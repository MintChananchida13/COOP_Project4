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
from .table_grid_analyzer import analyze_table_regions


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
_TABLE_BORDERLESS_FINAL_CONFIDENCE_THRESHOLD = 0.72
_TABLE_BORDERLESS_FILL_RATIO_THRESHOLD = 0.20
_TABLE_BORDERLESS_COLUMN_CONSISTENCY_THRESHOLD = 0.45
_TABLE_BORDERLESS_SPARSE_ROW_RATIO_THRESHOLD = 0.70
_TABLE_CANDIDATE_TIE_EPSILON = 0.03
_TABLE_LOW_OCR_CONFIDENCE_THRESHOLD = 0.65
_TABLE_RECONSTRUCTION_MIN_ROW_GAIN = 1
_TABLE_RECONSTRUCTION_MIN_QUALITY_GAIN = 0.04


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
    structured = result.get("table_structured")
    if isinstance(structured, dict) and isinstance(structured.get("rows"), list):
        rows = structured.get("rows")
        if rows and all(isinstance(row, list) for row in rows):
            return normalize_table_rows(rows)
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
    structured = result.get("table_structured")
    if isinstance(structured, dict):
        return structured
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


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _to_confidence_score(value: Any) -> Optional[float]:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(numeric) or numeric < 0:
        return None
    if numeric > 1.0:
        numeric = numeric / 100.0
    return _clamp01(numeric)


def _cell_has_text(cell: Dict[str, Any]) -> bool:
    return bool(str(cell.get("text") or cell.get("ocrText") or cell.get("ocr_text") or cell.get("groundTruth") or "").strip())


def _first_confidence_value(record: Dict[str, Any], keys: List[str]) -> Optional[float]:
    for key in keys:
        if key in record:
            score = _to_confidence_score(record.get(key))
            if score is not None:
                return score
    return None


def _calculate_table_quality(rows: List[List[str]], structured: Optional[Dict[str, Any]], method: str) -> Dict[str, Any]:
    normalized_rows = normalize_table_rows(rows) if rows else []
    row_count, column_count = _table_shape(normalized_rows)
    total_cells = row_count * column_count if row_count and column_count else 0
    non_empty_by_row = [sum(1 for cell in row if str(cell).strip()) for row in normalized_rows]
    non_empty_cell_count = sum(non_empty_by_row)
    non_empty_rows = sum(1 for count in non_empty_by_row if count > 0)
    fill_ratio = non_empty_cell_count / total_cells if total_cells else 0.0
    non_empty_row_ratio = non_empty_rows / row_count if row_count else 0.0
    active_counts = [count for count in non_empty_by_row if count > 0]
    if column_count <= 0 or not active_counts:
        column_consistency = 0.0
    else:
        average_count = sum(active_counts) / len(active_counts)
        variance = sum((count - average_count) ** 2 for count in active_counts) / len(active_counts)
        normalized_std = (variance ** 0.5) / max(column_count, 1)
        column_consistency = _clamp01(1.0 - normalized_std)
    sparse_rows = sum(1 for count in non_empty_by_row if column_count > 0 and count > 0 and (count / column_count) < 0.35)
    sparse_row_ratio = sparse_rows / row_count if row_count else 0.0

    structured_cells = []
    if isinstance(structured, dict) and isinstance(structured.get("cells"), list):
        structured_cells = [cell for cell in structured.get("cells") or [] if isinstance(cell, dict)]
    visible_structured_cells = [cell for cell in structured_cells if not cell.get("hidden")]
    has_structured_cells = any(_cell_has_text(cell) or cell.get("bbox") is not None for cell in visible_structured_cells)
    merged_cells = [
        cell
        for cell in visible_structured_cells
        if int(cell.get("rowSpan") or cell.get("rowspan") or cell.get("row_span") or 1) > 1
        or int(cell.get("colSpan") or cell.get("colspan") or cell.get("col_span") or 1) > 1
    ]
    merged_cell_ratio = len(merged_cells) / len(visible_structured_cells) if visible_structured_cells else 0.0
    usable_shape = _has_usable_table_shape(normalized_rows)
    penalties: List[str] = []
    if not normalized_rows:
        penalties.append("no_rows")
    if not usable_shape:
        penalties.append("unusable_shape")
    if column_count < _BORDERLESS_MIN_COLUMNS:
        penalties.append("too_few_columns")
    if fill_ratio < _TABLE_BORDERLESS_FILL_RATIO_THRESHOLD:
        penalties.append("low_fill_ratio")
    if column_consistency < _TABLE_BORDERLESS_COLUMN_CONSISTENCY_THRESHOLD:
        penalties.append("low_column_consistency")
    if sparse_row_ratio > _TABLE_BORDERLESS_SPARSE_ROW_RATIO_THRESHOLD:
        penalties.append("too_many_sparse_rows")

    shape_score = 0.0
    if row_count >= _BORDERLESS_MIN_ROWS and column_count >= _BORDERLESS_MIN_COLUMNS:
        shape_score = 1.0
    elif row_count > 0 and column_count > 0:
        shape_score = 0.35
    structure_bonus = 0.08 if has_structured_cells else 0.0
    merged_adjustment = 0.04 if 0.0 < merged_cell_ratio <= 0.35 else (-0.04 if merged_cell_ratio > 0.65 else 0.0)
    score = (
        shape_score * 0.30
        + fill_ratio * 0.24
        + non_empty_row_ratio * 0.16
        + column_consistency * 0.18
        + (1.0 - sparse_row_ratio) * 0.08
        + structure_bonus
        + merged_adjustment
    )
    if not usable_shape:
        score *= 0.65
    if not normalized_rows:
        score = 0.0

    return {
        "score": round(_clamp01(score), 4),
        "row_count": row_count,
        "column_count": column_count,
        "non_empty_cell_count": non_empty_cell_count,
        "fill_ratio": round(_clamp01(fill_ratio), 4),
        "non_empty_row_ratio": round(_clamp01(non_empty_row_ratio), 4),
        "column_consistency": round(_clamp01(column_consistency), 4),
        "sparse_row_ratio": round(_clamp01(sparse_row_ratio), 4),
        "has_structured_cells": has_structured_cells,
        "merged_cell_ratio": round(_clamp01(merged_cell_ratio), 4),
        "usable_shape": usable_shape,
        "penalties": penalties,
        "method": method,
    }


def _collect_confidence_values(value: Any, include_empty: bool = False) -> List[float]:
    values: List[float] = []
    if isinstance(value, dict):
        if include_empty or _cell_has_text(value):
            for key in ("confidence", "score", "rec_score", "text_score", "ocr_confidence"):
                score = _to_confidence_score(value.get(key))
                if score is not None:
                    values.append(score)
            for key in ("rec_scores", "text_scores", "scores", "confidences"):
                nested = value.get(key)
                if isinstance(nested, (list, tuple)):
                    values.extend(score for score in (_to_confidence_score(item) for item in nested) if score is not None)
        for nested_value in value.values():
            values.extend(_collect_confidence_values(nested_value, include_empty=include_empty))
    elif isinstance(value, (list, tuple)):
        for item in value:
            values.extend(_collect_confidence_values(item, include_empty=include_empty))
    return values


def _calculate_ocr_confidence(result: Dict[str, Any]) -> Dict[str, Any]:
    values: List[float] = []
    segments = result.get("segments")
    if isinstance(segments, list):
        for segment in segments:
            if isinstance(segment, dict) and _cell_has_text(segment):
                score = _first_confidence_value(segment, ["confidence", "score", "rec_score", "text_score", "ocr_confidence"])
                if score is not None:
                    values.append(score)

    structured = result.get("table_structured")
    if isinstance(structured, dict) and isinstance(structured.get("cells"), list):
        for cell in structured.get("cells") or []:
            if isinstance(cell, dict) and _cell_has_text(cell):
                for key in ("confidence", "score", "rec_score", "text_score", "ocr_confidence"):
                    score = _to_confidence_score(cell.get(key))
                    if score is not None:
                        values.append(score)

    raw_sources = [
        result.get("raw_result"),
        result.get("raw_results"),
        result.get("table_debug", {}).get("raw_result") if isinstance(result.get("table_debug"), dict) else None,
    ]
    for source in raw_sources:
        values.extend(_collect_confidence_values(source, include_empty=False))

    if not values:
        return {
            "available": False,
            "score": 0.0,
            "average": 0.0,
            "minimum": 0.0,
            "recognized_count": 0,
            "low_confidence_count": 0,
        }

    average = sum(values) / len(values)
    minimum = min(values)
    return {
        "available": True,
        "score": round(_clamp01(average), 4),
        "average": round(_clamp01(average), 4),
        "minimum": round(_clamp01(minimum), 4),
        "recognized_count": len(values),
        "low_confidence_count": sum(1 for value in values if value < _TABLE_LOW_OCR_CONFIDENCE_THRESHOLD),
    }


def _build_table_candidate(result: Dict[str, Any], method: str) -> Dict[str, Any]:
    candidate = _postprocess_table_result(result)
    rows = normalize_table_rows(candidate.get("table_rows") or [])
    structured = candidate.get("table_structured") if isinstance(candidate.get("table_structured"), dict) else None
    quality = _calculate_table_quality(rows, structured, method)
    ocr_confidence = _calculate_ocr_confidence(candidate)
    structure_score = float(quality["score"])
    if ocr_confidence["available"]:
        final_confidence = structure_score * 0.65 + float(ocr_confidence["score"]) * 0.35
    else:
        final_confidence = structure_score * 0.85
    final_confidence = round(_clamp01(final_confidence), 4)

    candidate["confidence"] = final_confidence
    debug = candidate.get("table_debug")
    if not isinstance(debug, dict):
        debug = {}
    debug["quality"] = quality
    debug["ocr_confidence"] = ocr_confidence
    debug["final_confidence"] = final_confidence
    debug["candidate_method"] = method
    candidate["table_debug"] = debug
    candidate["table_selected_method"] = method
    return candidate


def _should_try_borderless_candidate(quality: Dict[str, Any], final_confidence: float) -> bool:
    return (
        not bool(quality.get("usable_shape"))
        or int(quality.get("row_count") or 0) <= 0
        or int(quality.get("column_count") or 0) < _BORDERLESS_MIN_COLUMNS
        or float(final_confidence or 0.0) < _TABLE_BORDERLESS_FINAL_CONFIDENCE_THRESHOLD
        or float(quality.get("fill_ratio") or 0.0) < _TABLE_BORDERLESS_FILL_RATIO_THRESHOLD
        or float(quality.get("column_consistency") or 0.0) < _TABLE_BORDERLESS_COLUMN_CONSISTENCY_THRESHOLD
        or float(quality.get("sparse_row_ratio") or 0.0) > _TABLE_BORDERLESS_SPARSE_ROW_RATIO_THRESHOLD
    )


def _candidate_has_content(candidate: Dict[str, Any]) -> bool:
    return bool(candidate.get("table_rows") or str(candidate.get("text") or "").strip())


def _candidate_summary(candidate: Dict[str, Any]) -> Dict[str, Any]:
    debug = candidate.get("table_debug") if isinstance(candidate.get("table_debug"), dict) else {}
    quality = debug.get("quality") if isinstance(debug.get("quality"), dict) else {}
    ocr_confidence = debug.get("ocr_confidence") if isinstance(debug.get("ocr_confidence"), dict) else {}
    return {
        "method": debug.get("candidate_method") or candidate.get("table_selected_method") or "",
        "structure_score": float(quality.get("score") or 0.0),
        "ocr_score": float(ocr_confidence.get("score") or 0.0),
        "ocr_available": bool(ocr_confidence.get("available")),
        "final_confidence": float(debug.get("final_confidence") or candidate.get("confidence") or 0.0),
        "row_count": int(quality.get("row_count") or 0),
        "column_count": int(quality.get("column_count") or 0),
        "usable_shape": bool(quality.get("usable_shape")),
        "has_structured_cells": bool(quality.get("has_structured_cells")),
        "non_empty_cell_count": int(quality.get("non_empty_cell_count") or 0),
        "penalties": quality.get("penalties") if isinstance(quality.get("penalties"), list) else [],
    }


def _select_best_table_candidate(candidates: List[Dict[str, Any]]) -> tuple[Dict[str, Any], str]:
    valid_candidates = [candidate for candidate in candidates if _candidate_has_content(candidate)]
    if not valid_candidates:
        return (candidates[0] if candidates else {}, "no_valid_candidate")
    if len(valid_candidates) == 1:
        return valid_candidates[0], "only_valid_candidate"

    sorted_candidates = sorted(valid_candidates, key=lambda item: float(item.get("confidence") or 0.0), reverse=True)
    best = sorted_candidates[0]
    runner_up = sorted_candidates[1]
    best_score = float(best.get("confidence") or 0.0)
    runner_score = float(runner_up.get("confidence") or 0.0)
    if best_score - runner_score > _TABLE_CANDIDATE_TIE_EPSILON:
        if _candidate_summary(best)["method"] == "borderless_text_clustering" and _candidate_summary(runner_up)["method"] == "slanext":
            return best, "borderless_improved_low_quality_slanext"
        return best, "higher_final_confidence"

    def tie_key(candidate: Dict[str, Any]) -> tuple[int, int, int, int, int]:
        summary = _candidate_summary(candidate)
        return (
            1 if summary["usable_shape"] else 0,
            1 if summary["has_structured_cells"] else 0,
            1 if summary["column_count"] > 1 else 0,
            summary["non_empty_cell_count"],
            1 if summary["method"] == "slanext" else 0,
        )

    selected = sorted(valid_candidates, key=lambda item: (tie_key(item), float(item.get("confidence") or 0.0)), reverse=True)[0]
    if _candidate_summary(selected)["method"] == "slanext" and _candidate_summary(selected)["has_structured_cells"]:
        return selected, "tie_preferred_structured_slanext"
    return selected, "tie_breaker"


def _attach_candidate_competition(selected: Dict[str, Any], candidates: List[Dict[str, Any]], reason: str) -> Dict[str, Any]:
    selected_debug = selected.get("table_debug")
    if not isinstance(selected_debug, dict):
        selected_debug = {}
    selected_method = _candidate_summary(selected)["method"]
    selected_debug["candidate_competition"] = {
        "selected_method": selected_method,
        "selection_reason": reason,
        "candidate_count": len(candidates),
        "candidates": [_candidate_summary(candidate) for candidate in candidates],
    }
    selected["table_debug"] = selected_debug
    selected["table_selected_method"] = selected_method
    selected["table_candidates"] = [_candidate_summary(candidate) for candidate in candidates]
    return selected


def _bbox_to_xywh(value: Any) -> Optional[Dict[str, float]]:
    if isinstance(value, dict):
        try:
            if {"x", "y", "width", "height"}.issubset(value):
                x = float(value.get("x") or 0.0)
                y = float(value.get("y") or 0.0)
                width = float(value.get("width") or 0.0)
                height = float(value.get("height") or 0.0)
                if width > 0 and height > 0:
                    return {"x": x, "y": y, "width": width, "height": height}
            if {"left", "top", "right", "bottom"}.issubset(value):
                left = float(value.get("left") or 0.0)
                top = float(value.get("top") or 0.0)
                right = float(value.get("right") or 0.0)
                bottom = float(value.get("bottom") or 0.0)
                if right > left and bottom > top:
                    return {"x": left, "y": top, "width": right - left, "height": bottom - top}
        except (TypeError, ValueError):
            return None
    if isinstance(value, (list, tuple)) and len(value) >= 4:
        try:
            if all(isinstance(point, (list, tuple)) and len(point) >= 2 for point in value[:4]):
                xs = [float(point[0]) for point in value[:4]]
                ys = [float(point[1]) for point in value[:4]]
                return {"x": min(xs), "y": min(ys), "width": max(xs) - min(xs), "height": max(ys) - min(ys)}
            x = float(value[0])
            y = float(value[1])
            third = float(value[2])
            fourth = float(value[3])
            width = third - x if third > x and fourth > y else third
            height = fourth - y if third > x and fourth > y else fourth
            if width > 0 and height > 0:
                return {"x": x, "y": y, "width": width, "height": height}
        except (TypeError, ValueError):
            return None
    return None


def _ocr_text_from_record(record: Dict[str, Any]) -> str:
    for key in ("text", "ocrText", "ocr_text", "rec_text", "label", "content", "value"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return normalize_ocr_text(value)
    return ""


def _collect_ocr_geometry(value: Any) -> List[Dict[str, Any]]:
    boxes: List[Dict[str, Any]] = []
    if isinstance(value, dict):
        text = _ocr_text_from_record(value)
        bbox = None
        for key in ("bbox", "box", "points", "polygon", "poly", "dt_polys", "rec_boxes"):
            bbox = _bbox_to_xywh(value.get(key))
            if bbox:
                break
        if text and bbox:
            confidence = _first_confidence_value(value, ["confidence", "score", "rec_score", "text_score", "ocr_confidence"])
            boxes.append(
                {
                    "text": text,
                    "bbox": bbox,
                    "confidence": confidence,
                    "center_x": bbox["x"] + bbox["width"] / 2,
                    "center_y": bbox["y"] + bbox["height"] / 2,
                    "height": bbox["height"],
                }
            )
        for nested in value.values():
            boxes.extend(_collect_ocr_geometry(nested))
    elif isinstance(value, (list, tuple)):
        for item in value:
            boxes.extend(_collect_ocr_geometry(item))
    return boxes


def _cell_bbox(cell: Dict[str, Any]) -> Optional[Dict[str, float]]:
    return _bbox_to_xywh(cell.get("bbox") or cell.get("box"))


def _contains_center(outer: Dict[str, float], inner: Dict[str, Any]) -> bool:
    return (
        outer["x"] <= float(inner["center_x"]) <= outer["x"] + outer["width"]
        and outer["y"] <= float(inner["center_y"]) <= outer["y"] + outer["height"]
    )


def _cluster_boxes_by_y(boxes: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    if not boxes:
        return []
    median_height = float(np.median([box["height"] for box in boxes if box.get("height")])) if boxes else 10.0
    threshold = max(6.0, median_height * 0.65)
    clusters: List[List[Dict[str, Any]]] = []
    for box in sorted(boxes, key=lambda item: (item["center_y"], item["center_x"])):
        target = None
        for cluster in clusters:
            center = sum(float(item["center_y"]) for item in cluster) / len(cluster)
            if abs(float(box["center_y"]) - center) <= threshold:
                target = cluster
                break
        if target is None:
            clusters.append([box])
        else:
            target.append(box)
    return [sorted(cluster, key=lambda item: item["center_x"]) for cluster in clusters]


def _build_geometry_reconstruction_candidate(original: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    structured = original.get("table_structured")
    if not isinstance(structured, dict) or not isinstance(structured.get("cells"), list):
        return None
    raw_boxes = _collect_ocr_geometry(original.get("raw_results"))
    if len(raw_boxes) < 2:
        raw_boxes = _collect_ocr_geometry(original.get("segments"))
    if len(raw_boxes) < 2:
        return None

    visible_cells = [cell for cell in structured.get("cells") or [] if isinstance(cell, dict) and not cell.get("hidden")]
    cell_boxes: List[Dict[str, Any]] = []
    for cell in visible_cells:
        bbox = _cell_bbox(cell)
        if not bbox:
            continue
        cell_boxes.append({**cell, "_bbox": bbox})
    if len(cell_boxes) < 2:
        return None

    assigned: List[Dict[str, Any]] = []
    for box in raw_boxes:
        containing = [cell for cell in cell_boxes if _contains_center(cell["_bbox"], box)]
        if not containing:
            continue
        cell = min(containing, key=lambda item: float(item["_bbox"]["width"]) * float(item["_bbox"]["height"]))
        assigned.append({**box, "row": int(cell.get("row") or 0), "col": int(cell.get("col") or 0), "source_cell": cell})

    if len(assigned) < 2:
        return None
    multi_box_cells: Dict[tuple[int, int], int] = {}
    for item in assigned:
        key = (int(item["row"]), int(item["col"]))
        multi_box_cells[key] = multi_box_cells.get(key, 0) + 1
    if not any(count > 1 for count in multi_box_cells.values()):
        return None

    clusters = _cluster_boxes_by_y(assigned)
    if len(clusters) <= len(normalize_table_rows(original.get("table_rows") or [])):
        return None
    multi_column_lines = sum(1 for cluster in clusters if len({int(item["col"]) for item in cluster}) >= 2)
    if multi_column_lines < 2:
        return None

    columns = sorted({int(cell.get("col") or 0) for cell in cell_boxes})
    if len(columns) < 2:
        return None
    col_to_index = {col: index for index, col in enumerate(columns)}
    reconstructed_rows: List[List[str]] = []
    reconstructed_cells: List[Dict[str, Any]] = []
    segments: List[Dict[str, Any]] = []
    confidence_values: List[float] = []
    for row_index, cluster in enumerate(clusters):
        row_values = ["" for _ in columns]
        grouped: Dict[int, List[Dict[str, Any]]] = {}
        for item in cluster:
            grouped.setdefault(int(item["col"]), []).append(item)
            if item.get("confidence") is not None:
                confidence_values.append(float(item["confidence"]))
            segments.append({"text": item["text"], "confidence": item.get("confidence"), "bbox": item["bbox"]})
        for original_col, items in grouped.items():
            col_index = col_to_index.get(original_col)
            if col_index is None:
                continue
            sorted_items = sorted(items, key=lambda item: item["center_x"])
            text = normalize_ocr_text(" ".join(item["text"] for item in sorted_items))
            bbox = _merge_bboxes([item["bbox"] for item in sorted_items])
            row_values[col_index] = text
            cell: Dict[str, Any] = {
                "row": row_index,
                "col": col_index,
                "text": text,
                "rowSpan": 1,
                "colSpan": 1,
                "ocrText": text,
                "groundTruth": text,
            }
            if bbox:
                cell["bbox"] = bbox
            if sorted_items and sorted_items[0].get("confidence") is not None:
                cell["confidence"] = sum(float(item.get("confidence") or 0.0) for item in sorted_items) / len(sorted_items)
            reconstructed_cells.append(cell)
        reconstructed_rows.append(row_values)

    reconstructed_rows = normalize_table_rows(reconstructed_rows)
    if not _has_usable_table_shape(reconstructed_rows):
        return None

    original_rows = normalize_table_rows(original.get("table_rows") or [])
    structured_reconstructed = {
        "rows": reconstructed_rows,
        "cells": reconstructed_cells,
        "headerRowCount": int(structured.get("headerRowCount") or structured.get("header_row_count") or 1),
        "postProcessing": "geometry_guided_cell_reconstruction",
    }
    result = {
        "text": _markdown_table(reconstructed_rows),
        "confidence": 0.0,
        "segments": segments,
        "attempts": [*([attempt for attempt in original.get("attempts") or [] if isinstance(attempt, dict)]), {"step": "geometry_guided_cell_reconstruction", "logical_row_count": len(reconstructed_rows)}],
        "preprocessing": original.get("preprocessing") or "paddle_table_recognition_v2",
        "engine": original.get("engine") or "table_recognition_v2",
        "model": original.get("model") or _TABLE_MODEL_NAME,
        "table_html": original.get("table_html"),
        "table_rows": reconstructed_rows,
        "table_structured": structured_reconstructed,
        "table_debug": {
            **(original.get("table_debug") if isinstance(original.get("table_debug"), dict) else {}),
            "status": "geometry_reconstructed",
            "reconstruction_source": "slanext_cell_bbox_and_raw_ocr_geometry",
        },
        "raw_results": original.get("raw_results"),
        "table_reconstruction": {
            "attempted": True,
            "selected": False,
            "original_row_count": len(original_rows),
            "reconstructed_row_count": len(reconstructed_rows),
            "confidence": 0.0,
        },
    }
    candidate = _build_table_candidate(result, "geometry_reconstruction")
    candidate["table_reconstruction"]["confidence"] = candidate.get("confidence", 0.0)
    original_quality = original.get("table_debug", {}).get("quality") if isinstance(original.get("table_debug"), dict) else {}
    reconstructed_quality = candidate.get("table_debug", {}).get("quality") if isinstance(candidate.get("table_debug"), dict) else {}
    row_gain = len(reconstructed_rows) - len(original_rows)
    quality_gain = float(reconstructed_quality.get("score") or 0.0) - float(original_quality.get("score") or 0.0)
    if row_gain < _TABLE_RECONSTRUCTION_MIN_ROW_GAIN and quality_gain < _TABLE_RECONSTRUCTION_MIN_QUALITY_GAIN:
        return None
    return candidate


def _add_reconstruction_candidate(original_candidate: Dict[str, Any], candidates: List[Dict[str, Any]]) -> None:
    reconstruction = _build_geometry_reconstruction_candidate(original_candidate)
    if reconstruction:
        candidates.append(reconstruction)


def _predict_table_model(model: Any, image: np.ndarray) -> Any:
    temp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
    temp.close()
    try:
        if not cv2.imwrite(temp.name, image):
            raise TableRecognitionV2UnavailableError("Unable to prepare table image for table_recognition_v2.")
        if _TABLE_MODEL_KIND == "pipeline_v2":
            return model.predict(
                input=temp.name,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_layout_detection=False,
                use_ocr_model=True,
            )
        return model.predict(input=temp.name, batch_size=1)
    finally:
        Path(temp.name).unlink(missing_ok=True)


def _slanext_result_from_output(output: Any, image: np.ndarray, started: float, region_debug: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    input_height, input_width = image.shape[:2]
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
    text = _markdown_table(rows)
    structured_table = structured_table or _structured_from_rows(rows)
    debug: Dict[str, Any] = {
        "status": "recognized" if text or html else "structure_empty",
        "row_count": len(rows),
        "column_count": max((len(row) for row in rows), default=0),
        "raw_result_count": len(dicts),
        "model_kind": _TABLE_MODEL_KIND,
        "text_recognition_model": _TABLE_TEXT_RECOGNITION_MODEL_NAME,
        "runtime_called": True,
        "input_size": [int(input_width), int(input_height)],
        "elapsed_seconds": round(time.perf_counter() - started, 3),
    }
    if region_debug:
        debug["region"] = region_debug
    return {
        "text": text,
        "confidence": 0.0,
        "segments": [],
        "attempts": [],
        "preprocessing": "paddle_table_recognition_v2",
        "engine": "table_recognition_v2",
        "model": _TABLE_MODEL_NAME,
        "table_html": html or None,
        "table_rows": rows,
        "table_structured": structured_table,
        "table_debug": debug,
        "raw_results": dicts,
    }


def _remap_bbox_value(value: Any, offset_x: float, offset_y: float) -> Any:
    if isinstance(value, dict):
        remapped = dict(value)
        if "x" in remapped:
            remapped["x"] = float(remapped.get("x") or 0.0) + offset_x
        if "y" in remapped:
            remapped["y"] = float(remapped.get("y") or 0.0) + offset_y
        return remapped
    if isinstance(value, list) and len(value) >= 4:
        remapped_list = list(value)
        try:
            remapped_list[0] = float(remapped_list[0]) + offset_x
            remapped_list[1] = float(remapped_list[1]) + offset_y
        except (TypeError, ValueError):
            return value
        return remapped_list
    return value


def _remap_candidate_to_roi(candidate: Dict[str, Any], offset_x: float, offset_y: float, row_offset: int) -> Dict[str, Any]:
    remapped = dict(candidate)
    structured = remapped.get("table_structured")
    if isinstance(structured, dict):
        next_structured = dict(structured)
        cells = []
        for cell in structured.get("cells") or []:
            if not isinstance(cell, dict):
                continue
            next_cell = dict(cell)
            next_cell["row"] = int(next_cell.get("row") or 0) + row_offset
            for bbox_key in ("bbox", "box"):
                if bbox_key in next_cell:
                    next_cell[bbox_key] = _remap_bbox_value(next_cell[bbox_key], offset_x, offset_y)
            cells.append(next_cell)
        next_structured["cells"] = cells
        if "bbox" in next_structured:
            next_structured["bbox"] = _remap_bbox_value(next_structured["bbox"], offset_x, offset_y)
        remapped["table_structured"] = next_structured
    segments = []
    for segment in remapped.get("segments") or []:
        if not isinstance(segment, dict):
            continue
        next_segment = dict(segment)
        if "bbox" in next_segment:
            next_segment["bbox"] = _remap_bbox_value(next_segment["bbox"], offset_x, offset_y)
        segments.append(next_segment)
    remapped["segments"] = segments
    return remapped


def _merge_region_candidates(region_candidates: List[Dict[str, Any]], semi_analysis: Dict[str, Any]) -> Dict[str, Any]:
    merged_rows: List[List[str]] = []
    merged_cells: List[Dict[str, Any]] = []
    merged_segments: List[Dict[str, Any]] = []
    attempts: List[Dict[str, Any]] = []
    html_parts: List[str] = []
    candidates_for_competition: List[Dict[str, Any]] = []
    header_row_count = 0
    for candidate in region_candidates:
        structured = candidate.get("table_structured")
        structured_rows = normalize_table_rows(structured.get("rows") if isinstance(structured, dict) else [])
        rows = structured_rows or normalize_table_rows(candidate.get("table_rows") or [])
        row_offset = len(merged_rows)
        merged_rows.extend(rows)
        if isinstance(structured, dict):
            header_row_count += int(structured.get("headerRowCount") or structured.get("header_row_count") or 0)
            for cell in structured.get("cells") or []:
                if isinstance(cell, dict):
                    next_cell = dict(cell)
                    next_cell["row"] = int(next_cell.get("row") or 0) + row_offset
                    merged_cells.append(next_cell)
        merged_segments.extend(segment for segment in candidate.get("segments") or [] if isinstance(segment, dict))
        attempts.extend(attempt for attempt in candidate.get("attempts") or [] if isinstance(attempt, dict))
        if candidate.get("table_html"):
            html_parts.append(str(candidate.get("table_html")))
        candidates_for_competition.append(candidate)

    structured = {
        "rows": merged_rows,
        "cells": merged_cells,
        "headerRowCount": header_row_count or 1,
        "postProcessing": "semi_structured_region_merge",
    } if merged_rows or merged_cells else None
    result = {
        "text": _markdown_table(merged_rows),
        "confidence": 0.0,
        "segments": merged_segments,
        "attempts": attempts or [{"step": "semi_structured_region_merge", "region_count": len(region_candidates)}],
        "preprocessing": "semi_structured_table_regions",
        "engine": "table_recognition_v2",
        "model": _TABLE_MODEL_NAME,
        "table_html": "\n".join(html_parts) if html_parts else None,
        "table_rows": merged_rows,
        "table_structured": structured,
        "table_debug": {
            "status": "semi_structured_merged" if merged_rows else "semi_structured_empty",
            "region_count": len(region_candidates),
        },
        "table_semi_analysis": semi_analysis,
    }
    merged_candidate = _build_table_candidate(result, "semi_structured_regions")
    selected, reason = _select_best_table_candidate([merged_candidate, *candidates_for_competition])
    if selected is not merged_candidate:
        selected = merged_candidate
        reason = "semi_structured_region_merge"
    return _attach_candidate_competition(selected, [merged_candidate, *candidates_for_competition], reason)


def _try_semi_structured_table(
    image: np.ndarray,
    model: Any,
    started: float,
    analysis: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    analysis = analysis if isinstance(analysis, dict) else analyze_table_regions(image)
    if not analysis.get("detected") or float(analysis.get("confidence") or 0.0) < 0.72:
        return None
    regions = [region for region in analysis.get("regions") or [] if isinstance(region, dict)]
    if len(regions) < 2:
        return None

    region_candidates: List[Dict[str, Any]] = []
    merge_regions: List[Dict[str, Any]] = []
    height, width = image.shape[:2]
    for index, region in enumerate(regions):
        if region.get("type") != "grid":
            merge_regions.append({**region, "status": "skipped_non_grid_region"})
            continue
        bbox = region.get("bbox")
        if not isinstance(bbox, dict):
            continue
        try:
            x = max(0, int(float(bbox.get("x") or 0)))
            y = max(0, int(float(bbox.get("y") or 0)))
            w = min(max(1, int(float(bbox.get("width") or 1))), width - x)
            h = min(max(1, int(float(bbox.get("height") or 1))), height - y)
        except (TypeError, ValueError):
            continue
        if w <= 0 or h <= 0:
            continue
        crop = image[y : y + h, x : x + w]
        try:
            output = _predict_table_model(model, crop)
            raw_result = _slanext_result_from_output(output, crop, started, {"index": index, "type": region.get("type"), "bbox": bbox})
            candidate = _build_table_candidate(raw_result, "slanext")
            region_candidates_for_selection = [candidate]
            _add_reconstruction_candidate(candidate, region_candidates_for_selection)
            candidate, _ = _select_best_table_candidate(region_candidates_for_selection)
            if candidate.get("table_reconstruction"):
                candidate["table_reconstruction"]["selected"] = True
            remapped = _remap_candidate_to_roi(candidate, float(x), float(y), 0)
            quality = remapped.get("table_debug", {}).get("quality") if isinstance(remapped.get("table_debug"), dict) else {}
            if _candidate_has_content(remapped) and bool(quality.get("usable_shape")):
                region_candidates.append(remapped)
                merge_regions.append({**region, "status": "recognized"})
            else:
                merge_regions.append({**region, "status": "unusable_result"})
        except Exception as error:
            logger.info("Semi-structured table region %s failed: %s", index, error)
            merge_regions.append({**region, "status": "failed", "reason": str(error)})

    if not region_candidates:
        return None
    semi_analysis = dict(analysis)
    semi_analysis["regions"] = merge_regions
    semi_analysis["merge_status"] = "merged" if len(region_candidates) == len(regions) else "partial"
    return _merge_region_candidates(region_candidates, semi_analysis)


def _whole_roi_semi_analysis(analysis: Optional[Dict[str, Any]], merge_status: str = "whole_roi_fallback") -> Dict[str, Any]:
    if isinstance(analysis, dict):
        result = dict(analysis)
    else:
        result = {"detected": False, "confidence": 0.0, "regions": [], "reason": "not_analyzed"}
    result.setdefault("detected", False)
    result.setdefault("confidence", 0.0)
    result.setdefault("regions", [])
    result["merge_status"] = merge_status
    return result


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
    semi_analysis: Optional[Dict[str, Any]] = None
    try:
        semi_analysis = analyze_table_regions(image)
        semi_result = _try_semi_structured_table(image, model, started, semi_analysis)
        if semi_result:
            return semi_result
    except Exception as error:
        logger.info("Semi-structured table analysis fell back to whole ROI: %s", error)
        semi_analysis = {"detected": False, "confidence": 0.0, "regions": [], "reason": str(error)}

    output = _predict_table_model(model, image)
    slanext_result = _slanext_result_from_output(output, image, started)
    slanext_candidate = _build_table_candidate(slanext_result, "slanext")
    candidates = [slanext_candidate]
    _add_reconstruction_candidate(slanext_candidate, candidates)
    slanext_debug = slanext_candidate.get("table_debug") if isinstance(slanext_candidate.get("table_debug"), dict) else {}
    slanext_quality = slanext_debug.get("quality") if isinstance(slanext_debug.get("quality"), dict) else {}
    slanext_confidence = float(slanext_candidate.get("confidence") or 0.0)

    if _should_try_borderless_candidate(slanext_quality, slanext_confidence):
        try:
            borderless_result = _recognize_borderless_table(image)
            if borderless_result:
                borderless_debug = borderless_result.get("table_debug")
                if isinstance(borderless_debug, dict):
                    slanext_rows = normalize_table_rows(slanext_result.get("table_rows") or [])
                    borderless_debug["slan_rows_before_fallback"] = len(slanext_rows)
                    borderless_debug["slan_columns_before_fallback"] = max((len(row) for row in slanext_rows), default=0)
                    borderless_debug["slan_status_before_fallback"] = "structure_empty" if not slanext_rows else "low_quality_candidate"
                candidates.append(_build_table_candidate(borderless_result, "borderless_text_clustering"))
        except Exception as error:
            logger.warning("Borderless table candidate failed: %s", error)

    selected, selection_reason = _select_best_table_candidate(candidates)
    for candidate in candidates:
        reconstruction = candidate.get("table_reconstruction")
        if isinstance(reconstruction, dict):
            reconstruction["selected"] = candidate is selected
    selected = _attach_candidate_competition(selected, candidates, selection_reason)
    selected.setdefault("table_semi_analysis", _whole_roi_semi_analysis(semi_analysis))
    return selected


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
        if isinstance(remote_result.get("table_debug"), dict) and isinstance(
            remote_result["table_debug"].get("candidate_competition"),
            dict,
        ):
            return _postprocess_table_result(remote_result)
        remote_method = str(remote_result.get("table_selected_method") or remote_result["table_debug"].get("candidate_method") or "remote_runtime")
        return _build_table_candidate(remote_result, remote_method)

    return recognize_table_v2_local(image)
