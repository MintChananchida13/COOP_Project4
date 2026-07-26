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


class TableRecognitionV2UnavailableError(RuntimeError):
    pass


logger = logging.getLogger(__name__)

_TABLE_MODEL: Any = None
_TABLE_MODEL_KIND = ""
_TABLE_MODEL_NAME = os.getenv("PADDLE_TABLE_MODEL_NAME") or os.getenv("PADDLE_TABLE_RECOGNITION_MODEL_NAME", "SLANet_plus")
_TABLE_TEXT_RECOGNITION_MODEL_NAME = os.getenv("PADDLE_TABLE_TEXT_RECOGNITION_MODEL_NAME", "th_PP-OCRv5_mobile_rec")


def _model_service_url() -> str:
    return os.getenv("MODEL_SERVICE_URL", "").strip()


def _use_remote_runtime() -> bool:
    return bool(_model_service_url())


def _common_model_kwargs() -> Dict[str, Any]:
    return {
        "device": "cpu",
        "enable_mkldnn": False,
        "enable_cinn": False,
        "use_tensorrt": False,
    }


def _load_table_model() -> Any:
    global _TABLE_MODEL, _TABLE_MODEL_KIND
    if _TABLE_MODEL is not None:
        return _TABLE_MODEL

    try:
        from paddleocr import TableRecognitionPipelineV2  # type: ignore
    except ImportError as import_error:
        raise TableRecognitionV2UnavailableError(
            "table_recognition_v2 requires paddleocr 3.x with TableRecognitionPipelineV2 installed."
        ) from import_error

    try:
        _TABLE_MODEL = TableRecognitionPipelineV2(
            wired_table_structure_recognition_model_name=_TABLE_MODEL_NAME,
            wireless_table_structure_recognition_model_name=_TABLE_MODEL_NAME,
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
        "text_recognition_model": _TABLE_TEXT_RECOGNITION_MODEL_NAME,
        "device": str(_common_model_kwargs().get("device") or "cpu"),
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
    parser = _TableHtmlParser()
    try:
        parser.feed(html)
    except Exception:
        return []
    rows = [row for row in parser.rows if any(cell.strip() for cell in row)]
    if rows:
        return rows

    empty_rows = [row for row in parser.rows if row]
    return empty_rows


def _structured_from_html(html: str) -> Optional[Dict[str, Any]]:
    if not html:
        return None
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
                "text": str(text or ""),
                "rowSpan": int(source.get("rowSpan") or source.get("rowspan") or source.get("row_span") or 1),
                "colSpan": int(source.get("colSpan") or source.get("colspan") or source.get("col_span") or 1),
                "ocrText": str(source.get("ocrText") or source.get("ocr_text") or source.get("text") or text or ""),
                "groundTruth": str(text or ""),
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


def _normalize_cell_dicts(cells: Any) -> List[Dict[str, Any]]:
    if not isinstance(cells, list):
        return []

    normalized: List[Dict[str, Any]] = []
    for cell in cells:
        if not isinstance(cell, dict):
            continue
        text = str(cell.get("text") or cell.get("content") or cell.get("value") or "").strip()
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
            return [[str(cell or "") for cell in row] for row in value]
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

    text = _markdown_table(rows)
    structured_table = structured_table or _structured_from_rows(rows)
    return {
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
    }


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
        return remote_result

    return recognize_table_v2_local(image)
