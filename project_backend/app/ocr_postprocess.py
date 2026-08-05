import re
import unicodedata
from typing import Any, Dict, List, Optional


_WHITESPACE_RE = re.compile(r"[ \t\r\f\v]+")


def normalize_ocr_text(text: Any) -> str:
    value = unicodedata.normalize("NFKC", str(text or ""))
    try:
        from pythainlp.util import normalize as thai_normalize  # type: ignore

        value = thai_normalize(value)
    except Exception:
        pass
    lines = [_WHITESPACE_RE.sub(" ", line).strip() for line in value.splitlines()]
    return "\n".join(line for line in lines if line).strip()


def _read_span(value: Any) -> int:
    try:
        return max(1, int(value or 1))
    except (TypeError, ValueError):
        return 1


def parse_table_html_with_bs4(html: str) -> Optional[Dict[str, Any]]:
    if not html:
        return None
    try:
        from bs4 import BeautifulSoup  # type: ignore
    except Exception:
        return None

    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        try:
            soup = BeautifulSoup(html, "html.parser")
        except Exception:
            return None

    table = soup.find("table") or soup
    rows: List[List[str]] = []
    cells: List[Dict[str, Any]] = []
    occupied: set[tuple[int, int]] = set()

    for row_index, tr in enumerate(table.find_all("tr")):
        row: List[str] = []
        col_index = 0
        for cell in tr.find_all(["th", "td"], recursive=False):
            while (row_index, col_index) in occupied:
                row.append("")
                col_index += 1
            text = normalize_ocr_text(cell.get_text(" ", strip=True))
            row_span = _read_span(cell.get("rowspan"))
            col_span = _read_span(cell.get("colspan"))
            row.append(text)
            for _ in range(col_span - 1):
                row.append("")
            cells.append(
                {
                    "row": row_index,
                    "col": col_index,
                    "text": text,
                    "rowSpan": row_span,
                    "colSpan": col_span,
                    "ocrText": text,
                    "groundTruth": text,
                }
            )
            for row_offset in range(row_span):
                for col_offset in range(col_span):
                    occupied.add((row_index + row_offset, col_index + col_offset))
                    if row_offset != 0 or col_offset != 0:
                        cells.append(
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
            col_index += col_span
        rows.append(row)

    if not rows:
        return None
    max_columns = max((len(row) for row in rows), default=0)
    normalized_rows = [row + [""] * (max_columns - len(row)) for row in rows]
    return {
        "rows": normalized_rows,
        "cells": cells,
        "headerRowCount": 1,
        "parser": "beautifulsoup4+lxml",
    }


def normalize_table_rows(rows: List[List[Any]], preserve_empty_rows: bool = True) -> List[List[str]]:
    if not rows:
        return []
    normalized = [[normalize_ocr_text(cell) for cell in row] for row in rows]
    max_columns = max((len(row) for row in normalized), default=0)
    normalized = [row + [""] * (max_columns - len(row)) for row in normalized]
    if preserve_empty_rows:
        return normalized
    return [row for row in normalized if any(cell.strip() for cell in row)]
