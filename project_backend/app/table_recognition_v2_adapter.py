import os
import tempfile
import logging
import time
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

from .model_runtime_client import ModelRuntimeUnavailableError, remote_recognize_table
from .ocr_postprocess import normalize_ocr_text, normalize_table_rows, parse_table_html_with_bs4
from .layout_analysis_service import LayoutAnalysisUnavailableError, detect_text_boxes
from .paddle_thai_ocr_adapter import PaddleThaiOcrUnavailableError, run_paddle_thai_ocr_batch


class TableRecognitionV2UnavailableError(RuntimeError):
    pass


logger = logging.getLogger(__name__)

_TABLE_MODEL: Any = None
_TABLE_MODEL_KIND = ""
_TABLE_WIRED_MODEL_NAME = (
    os.getenv("PADDLE_TABLE_WIRED_MODEL_NAME")
    or os.getenv("PADDLE_TABLE_MODEL_NAME")
    or os.getenv("PADDLE_TABLE_RECOGNITION_MODEL_NAME")
    or "SLANeXt_wired"
)
_TABLE_WIRELESS_MODEL_NAME = (
    os.getenv("PADDLE_TABLE_WIRELESS_MODEL_NAME")
    or os.getenv("PADDLE_TABLE_MODEL_NAME")
    or os.getenv("PADDLE_TABLE_RECOGNITION_MODEL_NAME")
    or "SLANeXt_wireless"
)
_TABLE_MODEL_NAME = f"{_TABLE_WIRED_MODEL_NAME}/{_TABLE_WIRELESS_MODEL_NAME}"
_TABLE_TEXT_RECOGNITION_MODEL_NAME = os.getenv("PADDLE_TABLE_TEXT_RECOGNITION_MODEL_NAME", "th_PP-OCRv5_mobile_rec")
_TABLE_DEVICE = "cpu"
_BORDERLESS_MIN_COLUMNS = 2
_BORDERLESS_MIN_ROWS = 2


def _model_service_url() -> str:
    return os.getenv("MODEL_SERVICE_URL", "").strip()


def _use_remote_runtime() -> bool:
    return bool(_model_service_url())


def _common_model_kwargs() -> Dict[str, Any]:
    return {
        "device": _TABLE_DEVICE,
        "enable_mkldnn": False,
        "enable_cinn": False,
        "use_tensorrt": False,
    }


def _load_table_model() -> Any:
    global _TABLE_MODEL, _TABLE_MODEL_KIND
    if _TABLE_MODEL is not None:
        logger.info("Reusing cached TableRecognitionPipelineV2 (device=%s)", _TABLE_DEVICE)
        return _TABLE_MODEL

    try:
        from paddleocr import TableRecognitionPipelineV2  # type: ignore
    except ImportError as import_error:
        raise TableRecognitionV2UnavailableError(
            "table_recognition_v2 requires paddleocr 3.x with TableRecognitionPipelineV2 installed."
        ) from import_error

    try:
        logger.info("Loading TableRecognitionPipelineV2 (device=%s)", _TABLE_DEVICE)
        _TABLE_MODEL = TableRecognitionPipelineV2(
            wired_table_structure_recognition_model_name=_TABLE_WIRED_MODEL_NAME,
            wireless_table_structure_recognition_model_name=_TABLE_WIRELESS_MODEL_NAME,
            text_recognition_model_name=_TABLE_TEXT_RECOGNITION_MODEL_NAME,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_layout_detection=False,
            use_ocr_model=True,
            **_common_model_kwargs(),
        )
        _TABLE_MODEL_KIND = "pipeline_v2"
        return _TABLE_MODEL
    except Exception as init_error:
        raise TableRecognitionV2UnavailableError(
            f"Failed to initialize PaddleOCR table_recognition_v2 model {_TABLE_MODEL_NAME}: {init_error}"
        ) from init_error


def table_recognition_runtime_summary() -> Dict[str, Any]:
    _load_table_model()
    return {
        "enabled": True,
        "structure_model": _TABLE_MODEL_NAME,
        "wired_structure_model": _TABLE_WIRED_MODEL_NAME,
        "wireless_structure_model": _TABLE_WIRELESS_MODEL_NAME,
        "text_recognition_model": _TABLE_TEXT_RECOGNITION_MODEL_NAME,
        "device": _TABLE_DEVICE,
    }


def _as_dict(value: Any) -> Optional[Dict[str, Any]]:
    if isinstance(value, dict):
        return value
    json_value = getattr(value, "json", None)
    if isinstance(json_value, dict):
        return json_value
    if callable(json_value):
        try:
            resolved = json_value()
            if isinstance(resolved, dict):
                return resolved
        except Exception:
            return None
    res_value = getattr(value, "res", None)
    if isinstance(res_value, dict):
        return res_value
    return None


def _collect_dicts(value: Any) -> List[Dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, dict):
        nested: List[Dict[str, Any]] = [value]
        for item in value.values():
            nested.extend(_collect_dicts(item))
        return nested
    if isinstance(value, (list, tuple)):
        rows: List[Dict[str, Any]] = []
        for item in value:
            rows.extend(_collect_dicts(item))
        return rows
    item = _as_dict(value)
    return [item] if item else []


def _extract_html(result: Dict[str, Any]) -> str:
    for key in ("html", "pred_html", "table_html", "structure_html"):
        value = result.get(key)
        if isinstance(value, str) and "<table" in value.lower():
            return value
    structure = result.get("structure")
    if isinstance(structure, list) and structure:
        value = "".join(str(item) for item in structure)
        if "<table" in value.lower():
            return value
    return ""


class _TableHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.rows: List[List[str]] = []
        self.cells: List[Dict[str, Any]] = []
        self._current_row: Optional[List[str]] = None
        self._current_cell: Optional[List[str]] = None
        self._cell_colspan = 1
        self._cell_rowspan = 1
        self._current_row_index = -1
        self._current_col_index = 0
        self._occupied: set[str] = set()

    def handle_starttag(self, tag: str, attrs: List[tuple[str, Optional[str]]]) -> None:
        tag_name = tag.lower()
        if tag_name == "tr":
            self._current_row = []
            self._current_row_index += 1
            self._current_col_index = 0
        if tag_name in {"td", "th"} and self._current_row is not None:
            while f"{self._current_row_index}:{self._current_col_index}" in self._occupied:
                self._current_row.append("")
                self._current_col_index += 1
            self._current_cell = []
            attrs_map = {key.lower(): value for key, value in attrs}
            try:
                self._cell_colspan = max(1, int(attrs_map.get("colspan") or 1))
            except (TypeError, ValueError):
                self._cell_colspan = 1
            try:
                self._cell_rowspan = max(1, int(attrs_map.get("rowspan") or 1))
            except (TypeError, ValueError):
                self._cell_rowspan = 1

    def handle_data(self, data: str) -> None:
        if self._current_cell is not None:
            self._current_cell.append(data)

    def handle_endtag(self, tag: str) -> None:
        tag_name = tag.lower()
        if tag_name in {"td", "th"} and self._current_row is not None and self._current_cell is not None:
            text = " ".join("".join(self._current_cell).split())
            row_index = max(0, self._current_row_index)
            col_index = self._current_col_index
            self._current_row.append(text)
            for _ in range(self._cell_colspan - 1):
                self._current_row.append("")
            self.cells.append(
                {
                    "row": row_index,
                    "col": col_index,
                    "text": text,
                    "rowSpan": self._cell_rowspan,
                    "colSpan": self._cell_colspan,
                    "ocrText": text,
                    "groundTruth": text,
                }
            )
            for row_offset in range(self._cell_rowspan):
                for col_offset in range(self._cell_colspan):
                    self._occupied.add(f"{row_index + row_offset}:{col_index + col_offset}")
                    if row_offset != 0 or col_offset != 0:
                        self.cells.append(
                            {
                                "row": row_index + row_offset,
                                "col": col_index + col_offset,
                                "text": "",
                                "rowSpan": 1,
                                "colSpan": 1,
                                "ocrText": "",
                                "groundTruth": "",
                                "hidden": True,
                            }
                        )
            self._current_col_index += self._cell_colspan
            self._current_cell = None
            self._cell_colspan = 1
            self._cell_rowspan = 1
        if tag_name == "tr" and self._current_row is not None:
            self.rows.append(self._current_row)
            self._current_row = None


def _rows_from_html(html: str) -> List[List[str]]:
    if not html:
        return []
    bs4_result = parse_table_html_with_bs4(html)
    if bs4_result:
        return bs4_result.get("rows") or []
    parser = _TableHtmlParser()
    try:
        parser.feed(html)
    except Exception:
        return []
    return [row for row in parser.rows if row]


def _structured_from_html(html: str) -> Optional[Dict[str, Any]]:
    if not html:
        return None
    bs4_result = parse_table_html_with_bs4(html)
    if bs4_result:
        return {
            "rows": bs4_result["rows"],
            "cells": bs4_result["cells"],
            "headerRowCount": bs4_result.get("headerRowCount", 1),
            "postProcessing": bs4_result.get("parser"),
        }
    parser = _TableHtmlParser()
    try:
        parser.feed(html)
    except Exception:
        return None
    rows = [row for row in parser.rows if row]
    if not rows:
        return None
    max_columns = max((len(row) for row in rows), default=0)
    normalized_rows = [row + [""] * (max_columns - len(row)) for row in rows]
    header_row_count = 1
    return {
        "rows": normalized_rows,
        "cells": parser.cells or _cells_from_rows(normalized_rows),
        "headerRowCount": header_row_count,
    }


def _cells_from_rows(rows: List[List[str]], source_cells: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    source_by_position = {
        (int(cell.get("row", 0)), int(cell.get("col", 0))): cell
        for cell in source_cells or []
        if isinstance(cell, dict)
    }
    cells: List[Dict[str, Any]] = []
    for row_index, row in enumerate(rows):
        for col_index, text in enumerate(row):
            source = source_by_position.get((row_index, col_index), {})
            bbox = source.get("bbox") or source.get("box")
            cell: Dict[str, Any] = {
                "row": row_index,
                "col": col_index,
                "text": normalize_ocr_text(text),
                "rowSpan": int(source.get("rowSpan") or source.get("rowspan") or source.get("row_span") or 1),
                "colSpan": int(source.get("colSpan") or source.get("colspan") or source.get("col_span") or 1),
                "ocrText": normalize_ocr_text(source.get("ocrText") or source.get("ocr_text") or source.get("text") or text or ""),
                "groundTruth": normalize_ocr_text(text),
            }
            if bbox is not None:
                cell["bbox"] = bbox
            cells.append(cell)
    return cells


def _structured_from_rows(rows: List[List[str]], source_cells: Optional[List[Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
    if not rows:
        return None
    max_columns = max((len(row) for row in rows), default=0)
    normalized_rows = [row + [""] * (max_columns - len(row)) for row in rows]
    return {
        "rows": normalized_rows,
        "cells": _cells_from_rows(normalized_rows, source_cells),
        "headerRowCount": 1,
    }


def _table_shape(rows: List[List[str]]) -> tuple[int, int]:
    if not rows:
        return (0, 0)
    return (len(rows), max((len(row) for row in rows), default=0))


def _has_usable_table_shape(rows: List[List[str]]) -> bool:
    row_count, column_count = _table_shape(rows)
    non_empty_rows = sum(1 for row in rows if any(str(cell).strip() for cell in row))
    return row_count >= _BORDERLESS_MIN_ROWS and column_count >= _BORDERLESS_MIN_COLUMNS and non_empty_rows >= _BORDERLESS_MIN_ROWS


def _region_bbox(region: Dict[str, Any], scale_factor: float = 1.0) -> Optional[Dict[str, float]]:
    bbox = region.get("bbox") if isinstance(region, dict) else None
    if not isinstance(bbox, dict):
        return None
    try:
        x = float(bbox.get("x") or 0) / scale_factor
        y = float(bbox.get("y") or 0) / scale_factor
        width = float(bbox.get("width") or 0) / scale_factor
        height = float(bbox.get("height") or 0) / scale_factor
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return {"x": x, "y": y, "width": width, "height": height}


def _merge_bboxes(boxes: List[Dict[str, float]]) -> Optional[Dict[str, float]]:
    if not boxes:
        return None
    left = min(box["x"] for box in boxes)
    top = min(box["y"] for box in boxes)
    right = max(box["x"] + box["width"] for box in boxes)
    bottom = max(box["y"] + box["height"] for box in boxes)
    return {"x": left, "y": top, "width": max(1.0, right - left), "height": max(1.0, bottom - top)}


def _cluster_text_cells(cells: List[Dict[str, Any]]) -> tuple[List[List[str]], List[Dict[str, Any]]]:
    if not cells:
        return ([], [])

    median_height = float(np.median([cell["height"] for cell in cells])) if cells else 12.0
    row_threshold = max(8.0, median_height * 0.75)
    row_groups: List[List[Dict[str, Any]]] = []
    for cell in sorted(cells, key=lambda item: (item["center_y"], item["x"])):
        target_row = None
        for row in row_groups:
            row_center = sum(item["center_y"] for item in row) / len(row)
            if abs(cell["center_y"] - row_center) <= row_threshold:
                target_row = row
                break
        if target_row is None:
            row_groups.append([cell])
        else:
            target_row.append(cell)

    row_groups = [sorted(row, key=lambda item: item["x"]) for row in row_groups]
    x_centers = sorted(cell["center_x"] for row in row_groups for cell in row)
    if not x_centers:
        return ([], [])
    median_width = float(np.median([cell["width"] for cell in cells])) if cells else 40.0
    column_threshold = max(14.0, median_width * 0.75)
    column_centers: List[float] = []
    for center in x_centers:
        if not column_centers or abs(center - column_centers[-1]) > column_threshold:
            column_centers.append(center)
        else:
            column_centers[-1] = (column_centers[-1] + center) / 2

    if len(column_centers) < _BORDERLESS_MIN_COLUMNS:
        return ([], [])

    rows: List[List[str]] = []
    source_cells: List[Dict[str, Any]] = []
    for row_index, row in enumerate(row_groups):
        values = ["" for _ in column_centers]
        grouped_boxes: List[List[Dict[str, float]]] = [[] for _ in column_centers]
        grouped_texts: List[List[str]] = [[] for _ in column_centers]
        for cell in row:
            col_index = min(range(len(column_centers)), key=lambda index: abs(cell["center_x"] - column_centers[index]))
            grouped_texts[col_index].append(cell["text"])
            grouped_boxes[col_index].append(cell["bbox"])
        for col_index, texts in enumerate(grouped_texts):
            text = normalize_ocr_text(" ".join(texts))
            values[col_index] = text
            bbox = _merge_bboxes(grouped_boxes[col_index])
            source_cell: Dict[str, Any] = {
                "row": row_index,
                "col": col_index,
                "text": text,
                "rowSpan": 1,
                "colSpan": 1,
                "ocrText": text,
                "groundTruth": text,
            }
            if bbox:
                source_cell["bbox"] = bbox
            source_cells.append(source_cell)
        rows.append(values)

    rows = normalize_table_rows(rows)
    if not _has_usable_table_shape(rows):
        return ([], [])
    return (rows, source_cells)


def _recognize_borderless_table(image: np.ndarray) -> Optional[Dict[str, Any]]:
    if image is None or image.size == 0:
        return None

    input_height, input_width = image.shape[:2]
    working_img = image
    scale_factor = 1.0
    longest_side = max(input_width, input_height)
    if longest_side < 1400:
        scale_factor = min(4.0, max(2.0, 1400.0 / max(longest_side, 1)))
        working_img = cv2.resize(
            image,
            (max(1, int(input_width * scale_factor)), max(1, int(input_height * scale_factor))),
            interpolation=cv2.INTER_CUBIC,
        )

    temp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
    temp.close()
    try:
        if not cv2.imwrite(temp.name, working_img):
            return None
        text_detection = detect_text_boxes(temp.name)
    except (LayoutAnalysisUnavailableError, Exception) as error:
        logger.info("Borderless table text detection failed: %s", error)
        return None
    finally:
        Path(temp.name).unlink(missing_ok=True)

    regions = text_detection.get("regions") if isinstance(text_detection, dict) else []
    if not isinstance(regions, list) or not regions:
        return None

    crops: List[np.ndarray] = []
    valid_regions: List[Dict[str, Any]] = []
    h_working, w_working = working_img.shape[:2]
    for region in regions:
        bbox = region.get("bbox") if isinstance(region, dict) else None
        if not isinstance(bbox, dict):
            continue
        try:
            x = max(0, int(float(bbox.get("x") or 0)))
            y = max(0, int(float(bbox.get("y") or 0)))
            width = max(1, int(float(bbox.get("width") or 1)))
            height = max(1, int(float(bbox.get("height") or 1)))
        except (TypeError, ValueError):
            continue
        width = min(width, w_working - x)
        height = min(height, h_working - y)
        if width <= 0 or height <= 0:
            continue
        crop = working_img[y : y + height, x : x + width]
        if crop.size == 0:
            continue
        valid_regions.append(region)
        crops.append(crop)

    if len(crops) < _BORDERLESS_MIN_ROWS * _BORDERLESS_MIN_COLUMNS:
        return None

    try:
        recognitions = run_paddle_thai_ocr_batch(crops)
    except PaddleThaiOcrUnavailableError as error:
        logger.info("Borderless table OCR failed: %s", error)
        return None

    cells: List[Dict[str, Any]] = []
    confidence_values: List[float] = []
    for region, recognition in zip(valid_regions, recognitions):
        text = normalize_ocr_text(recognition.get("text") if isinstance(recognition, dict) else "")
        if not text:
            continue
        bbox = _region_bbox(region, scale_factor)
        if not bbox:
            continue
        confidence = float(recognition.get("confidence") or 0.0) if isinstance(recognition, dict) else 0.0
        confidence_values.append(confidence)
        cells.append(
            {
                "text": text,
                "confidence": confidence,
                "bbox": bbox,
                "x": bbox["x"],
                "y": bbox["y"],
                "width": bbox["width"],
                "height": bbox["height"],
                "center_x": bbox["x"] + bbox["width"] / 2,
                "center_y": bbox["y"] + bbox["height"] / 2,
            }
        )

    rows, source_cells = _cluster_text_cells(cells)
    if not rows:
        return None
    structured = _structured_from_rows(rows, source_cells)
    confidence = sum(confidence_values) / len(confidence_values) if confidence_values else 0.0
    return {
        "text": _markdown_table(rows),
        "confidence": float(confidence),
        "segments": [
            {
                "text": cell["text"],
                "confidence": cell["confidence"],
                "bbox": cell["bbox"],
            }
            for cell in cells
        ],
        "attempts": [{"step": "borderless_text_detection_clustering", "row_count": len(rows)}],
        "preprocessing": "borderless_table_text_detection_clustering",
        "engine": "table_recognition_v2",
        "model": _TABLE_MODEL_NAME,
        "table_rows": rows,
        "table_structured": structured,
        "table_debug": {
            "status": "borderless_fallback",
            "borderless_fallback_used": True,
            "detected_boxes": len(regions),
            "recognized_cells": len(cells),
            "row_count": len(rows),
            "column_count": max((len(row) for row in rows), default=0),
            "scale_factor": scale_factor,
            "input_size": [int(input_width), int(input_height)],
            "working_size": [int(working_img.shape[1]), int(working_img.shape[0])],
        },
    }


def _normalize_cell_dicts(cells: Any) -> List[Dict[str, Any]]:
    if not isinstance(cells, list):
        return []

    normalized: List[Dict[str, Any]] = []
    for cell in cells:
        if not isinstance(cell, dict):
            continue
        text = normalize_ocr_text(cell.get("text") or cell.get("content") or cell.get("value") or "")
        row = cell.get("row") or cell.get("row_index") or cell.get("start_row")
        col = cell.get("col") or cell.get("col_index") or cell.get("start_col")
        if row is None or col is None:
            continue
        try:
            normalized.append({**cell, "row": int(row), "col": int(col), "text": text})
        except (TypeError, ValueError):
            continue

    return normalized


def _rows_from_cells(cells: Any) -> List[List[str]]:
    normalized = _normalize_cell_dicts(cells)
    if not normalized:
        return []

    min_row = min(item["row"] for item in normalized)
    min_col = min(item["col"] for item in normalized)
    max_row = max(item["row"] for item in normalized)
    max_col = max(item["col"] for item in normalized)
    rows = [["" for _ in range(max_col - min_col + 1)] for _ in range(max_row - min_row + 1)]
    for item in normalized:
        rows[item["row"] - min_row][item["col"] - min_col] = item["text"]
    return rows


def _markdown_table(rows: List[List[str]]) -> str:
    if not rows:
        return ""
    max_columns = max(len(row) for row in rows)
    normalized = [row + [""] * (max_columns - len(row)) for row in rows]
    header = normalized[0]
    separator = ["---"] * max_columns

    def fmt(row: List[str]) -> str:
        return "| " + " | ".join(str(cell).strip().replace("|", "/") for cell in row) + " |"

    return "\n".join([fmt(header), fmt(separator), *[fmt(row) for row in normalized[1:]]])


def _extract_rows(result: Dict[str, Any]) -> List[List[str]]:
    for key in ("rows", "table_rows", "cells"):
        rows = _rows_from_cells(result.get(key))
        if rows:
            return rows
    for key in ("rows", "table_rows"):
        value = result.get(key)
        if isinstance(value, list) and value and all(isinstance(row, list) for row in value):
            return normalize_table_rows(value)
    return []


def _extract_structured_table(result: Dict[str, Any], rows: List[List[str]], html: str) -> Optional[Dict[str, Any]]:
    for key in ("cells", "table_cells"):
        source_cells = _normalize_cell_dicts(result.get(key))
        if source_cells:
            return _structured_from_rows(rows or _rows_from_cells(source_cells), source_cells)
    if html:
        structured = _structured_from_html(html)
        if structured:
            return structured
    return _structured_from_rows(rows)


def _postprocess_table_result(result: Dict[str, Any]) -> Dict[str, Any]:
    processed = dict(result)
    html = str(processed.get("table_html") or processed.get("html") or "")
    rows = processed.get("table_rows")
    if isinstance(rows, list) and rows and all(isinstance(row, list) for row in rows):
        normalized_rows = normalize_table_rows(rows)
    else:
        normalized_rows = _rows_from_html(html)

    structured = processed.get("table_structured")
    if not isinstance(structured, dict):
        structured = _extract_structured_table(processed, normalized_rows, html)

    if normalized_rows:
        processed["table_rows"] = normalized_rows
        processed["text"] = _markdown_table(normalized_rows)
    elif processed.get("text") is not None:
        processed["text"] = normalize_ocr_text(processed.get("text"))

    if structured:
        processed["table_structured"] = structured

    debug = processed.get("table_debug")
    if isinstance(debug, dict):
        debug.setdefault("post_processing", "beautifulsoup4+lxml")
    else:
        processed["table_debug"] = {"post_processing": "beautifulsoup4+lxml"}
    return processed


def recognize_table_v2_local(image: np.ndarray) -> Dict[str, Any]:
    started = time.perf_counter()
    if image is None or image.size == 0:
        return {
            "text": "",
            "confidence": 0.0,
            "segments": [],
            "attempts": [],
            "preprocessing": "table_v2_empty_image",
            "engine": "table_recognition_v2",
            "model": _TABLE_MODEL_NAME,
            "table_debug": {"status": "empty_image", "runtime_called": True},
        }

    logger.info("Using local Table Recognition runtime")
    model = _load_table_model()
    input_height, input_width = image.shape[:2]
    temp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
    temp.close()
    try:
        if not cv2.imwrite(temp.name, image):
            raise TableRecognitionV2UnavailableError("Unable to prepare table image for table_recognition_v2.")
        if _TABLE_MODEL_KIND == "pipeline_v2":
            output = model.predict(
                input=temp.name,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_layout_detection=False,
                use_ocr_model=True,
            )
        else:
            output = model.predict(input=temp.name, batch_size=1)
    finally:
        Path(temp.name).unlink(missing_ok=True)

    dicts = _collect_dicts(output)
    html = ""
    rows: List[List[str]] = []
    structured_table: Optional[Dict[str, Any]] = None
    for item in dicts:
        if not html:
            html = _extract_html(item)
        if not rows:
            rows = _extract_rows(item)
        if not rows and html:
            rows = _rows_from_html(html)
        if structured_table is None:
            structured_table = _extract_structured_table(item, rows, html)

    rows = normalize_table_rows(rows)
    borderless_result: Optional[Dict[str, Any]] = None
    if not _has_usable_table_shape(rows):
        borderless_result = _recognize_borderless_table(image)
        if borderless_result:
            borderless_debug = borderless_result.get("table_debug")
            if isinstance(borderless_debug, dict):
                borderless_debug["slan_rows_before_fallback"] = len(rows)
                borderless_debug["slan_columns_before_fallback"] = max((len(row) for row in rows), default=0)
                borderless_debug["slan_status_before_fallback"] = "structure_empty" if not rows else "insufficient_shape"
            return _postprocess_table_result(borderless_result)

    text = _markdown_table(rows)
    structured_table = structured_table or _structured_from_rows(rows)
    return _postprocess_table_result({
        "text": text,
        "confidence": 1.0 if text or html else 0.0,
        "segments": [],
        "attempts": [],
        "preprocessing": "paddle_table_recognition_v2",
        "engine": "table_recognition_v2",
        "model": _TABLE_MODEL_NAME,
        "table_html": html or None,
        "table_rows": rows,
        "table_structured": structured_table,
        "table_debug": {
            "status": "recognized" if text or html else "structure_empty",
            "row_count": len(rows),
            "column_count": max((len(row) for row in rows), default=0),
            "raw_result_count": len(dicts),
            "model_kind": _TABLE_MODEL_KIND,
            "text_recognition_model": _TABLE_TEXT_RECOGNITION_MODEL_NAME,
            "runtime_called": True,
            "input_size": [int(input_width), int(input_height)],
            "elapsed_seconds": round(time.perf_counter() - started, 3),
        },
    })


def recognize_table_v2(image: np.ndarray) -> Dict[str, Any]:
    if _use_remote_runtime():
        logger.info("Using remote Table Recognition runtime")
        try:
            remote_result = remote_recognize_table(image)
        except ModelRuntimeUnavailableError as error:
            raise TableRecognitionV2UnavailableError(str(error)) from error
        except Exception as error:
            raise TableRecognitionV2UnavailableError(str(error)) from error

        if remote_result is None:
            raise TableRecognitionV2UnavailableError("Remote Table Recognition runtime returned no result.")
        if not isinstance(remote_result, dict):
            raise TableRecognitionV2UnavailableError("Remote Table Recognition runtime returned an invalid response.")
        remote_debug = remote_result.get("table_debug")
        if isinstance(remote_debug, dict):
            remote_debug.setdefault("remote_runtime_called", True)
        else:
            remote_result["table_debug"] = {"remote_runtime_called": True}
        return _postprocess_table_result(remote_result)

    return recognize_table_v2_local(image)
