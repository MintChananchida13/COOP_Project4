import base64
import io
import json
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Tuple

import cv2
import numpy as np
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

from app.routes import router as blueprint_router
from app.layout_analysis_service import LayoutAnalysisUnavailableError, analyze_layout, detect_text_boxes
from app.ocr_adapter import recognize_text_crop_with_detection
from app.ocr_postprocess import normalize_ocr_text, normalize_table_rows
from app.paddle_thai_ocr_adapter import PaddleThaiOcrUnavailableError, run_paddle_thai_ocr, run_paddle_thai_ocr_batch
from app.table_recognition_v2_adapter import TableRecognitionV2UnavailableError, recognize_table_v2
from app.db import connect as db_connect

# Force UTF-8 console output on Windows.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

OUTPUT_DIR = "cropped_rois"
os.makedirs(OUTPUT_DIR, exist_ok=True)


class ROIModel(BaseModel):
    fieldName: str
    x: float
    y: float
    width: float
    height: float
    roiId: int | None = None
    type: str | None = None
    extractionMethod: str | None = None
    roiMode: str | None = None
    expectedContent: str | None = None


class DocumentPayload(BaseModel):
    image: str
    rois: List[ROIModel]
    async_mode: bool = False


class LayoutImagePayload(BaseModel):
    page_index: int
    image: str


class LayoutAnalysisPayload(BaseModel):
    images: List[LayoutImagePayload]
    auto_roi_mode: str = "text_line"


app = FastAPI(title="OCR AI Engine")
DETECTION_DEBUG_DIR = Path(__file__).resolve().parent / "storage" / "detection_queries"
DETECTION_DEBUG_DIR.mkdir(parents=True, exist_ok=True)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount(
    "/debug/detection-queries",
    StaticFiles(directory=str(DETECTION_DEBUG_DIR)),
    name="detection_debug",
)

app.include_router(blueprint_router)


def _env_flag(name: str, default: str = "true") -> bool:
    return os.getenv(name, default).strip().lower() not in {"0", "false", "no", "off"}


def warmup_paddle_models() -> Dict[str, Any]:
    started = time.perf_counter()
    sample = np.full((420, 720, 3), 255, dtype=np.uint8)
    cv2.putText(sample, "Thai National ID Card", (40, 90), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2, cv2.LINE_AA)
    cv2.putText(sample, "Name 1234567890", (40, 150), cv2.FONT_HERSHEY_SIMPLEX, 0.85, (0, 0, 0), 2, cv2.LINE_AA)
    cv2.rectangle(sample, (40, 210), (680, 350), (0, 0, 0), 2)
    for x in (200, 360, 520):
        cv2.line(sample, (x, 210), (x, 350), (0, 0, 0), 1)
    for y in (255, 300):
        cv2.line(sample, (40, y), (680, y), (0, 0, 0), 1)

    layout = analyze_layout(sample)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp_file:
        temp_path = temp_file.name
    try:
        cv2.imwrite(temp_path, sample)
        text_boxes = detect_text_boxes(temp_path)
    finally:
        Path(temp_path).unlink(missing_ok=True)
    recognition = run_paddle_thai_ocr(sample[45:170, 30:500])
    elapsed = round(time.perf_counter() - started, 2)
    return {
        "layout_regions": len(layout.get("regions") or []),
        "text_boxes": len(text_boxes.get("regions") or []),
        "ocr_model": recognition.get("model"),
        "elapsed_seconds": elapsed,
    }


@app.on_event("startup")
async def startup_warmup() -> None:
    model_service_url = os.getenv("MODEL_SERVICE_URL", "").strip()
    if model_service_url:
        print(f"Using external model runtime service: {model_service_url}")
        print("Main backend Paddle model warm-up skipped; model_server.py owns model loading.")
        return

    if not _env_flag("OCR_MODEL_WARMUP", "true"):
        print("Paddle model warm-up skipped (OCR_MODEL_WARMUP=false).")
        return
    print("Warming up Paddle OCR/Layout models...")
    try:
        summary = warmup_paddle_models()
        print(
            "Paddle model warm-up complete "
            f"in {summary['elapsed_seconds']}s "
            f"(layout_regions={summary['layout_regions']}, text_boxes={summary['text_boxes']}, "
            f"ocr_model={summary['ocr_model']})."
        )
    except Exception as error:
        print(f"Paddle model warm-up failed: {error}")
        if _env_flag("OCR_MODEL_WARMUP_STRICT", "false"):
            raise


def decode_base64_image(image_str: str) -> Tuple[Image.Image, np.ndarray]:
    _, encoded = image_str.split(",", 1) if "," in image_str else ("", image_str)
    image_data = base64.b64decode(encoded)
    pil_image = Image.open(io.BytesIO(image_data))
    if pil_image.mode != "RGB":
        pil_image = pil_image.convert("RGB")
    opencv_img = cv2.cvtColor(np.array(pil_image), cv2.COLOR_RGB2BGR)
    return pil_image, opencv_img


def crop_opencv_region(opencv_img: np.ndarray, x: int, y: int, w: int, h: int) -> np.ndarray:
    h_img, w_img = opencv_img.shape[:2]
    x = max(0, x)
    y = max(0, y)
    x_end = min(x + max(1, w), w_img)
    y_end = min(y + max(1, h), h_img)
    return opencv_img[y:y_end, x:x_end]


def _markdown_table(rows: List[List[str]]) -> str:
    if not rows:
        return ""
    max_columns = max(len(row) for row in rows)
    normalized = [row + [""] * (max_columns - len(row)) for row in rows]
    header = normalized[0]
    separator = ["---"] * max_columns
    body = normalized[1:]

    def fmt(row: List[str]) -> str:
        return "| " + " | ".join(cell.strip() for cell in row) + " |"

    return "\n".join([fmt(header), fmt(separator), *[fmt(row) for row in body]])


def _structured_table_from_rows(rows: List[List[str]], regions: List[Dict[str, Any]] | None = None) -> Dict[str, Any] | None:
    if not rows:
        return None
    max_columns = max((len(row) for row in rows), default=0)
    normalized_rows = [row + [""] * (max_columns - len(row)) for row in rows]
    source_regions = regions or []
    cells: List[Dict[str, Any]] = []
    for row_index, row in enumerate(normalized_rows):
        for col_index, text in enumerate(row):
            flat_index = row_index * max_columns + col_index
            source_region = source_regions[flat_index] if flat_index < len(source_regions) else {}
            normalized_text = normalize_ocr_text(text)
            cell: Dict[str, Any] = {
                "row": row_index,
                "col": col_index,
                "text": normalized_text,
                "rowSpan": 1,
                "colSpan": 1,
                "ocrText": normalized_text,
                "groundTruth": normalized_text,
            }
            bbox = source_region.get("bbox") if isinstance(source_region, dict) else None
            if bbox is not None:
                cell["bbox"] = bbox
            cells.append(cell)
    return {
        "rows": normalized_rows,
        "cells": cells,
        "headerRowCount": 1,
    }


def _group_table_cells(regions: List[Dict[str, Any]], recognitions: List[Dict[str, Any]]) -> List[List[str]]:
    cells: List[Dict[str, Any]] = []
    for region, recognized in zip(regions, recognitions):
        text = normalize_ocr_text(recognized.get("text"))
        if not text:
            continue
        bbox = region.get("bbox") or {}
        x = float(bbox.get("x") or 0)
        y = float(bbox.get("y") or 0)
        width = float(bbox.get("width") or 0)
        height = float(bbox.get("height") or 0)
        cells.append(
            {
                "text": text,
                "x": x,
                "y": y,
                "height": max(1.0, height),
                "center_y": y + height / 2,
            }
        )

    if not cells:
        return []

    median_height = float(np.median([cell["height"] for cell in cells])) if cells else 12.0
    line_threshold = max(8.0, median_height * 0.65)
    rows: List[List[Dict[str, Any]]] = []

    for cell in sorted(cells, key=lambda item: (item["center_y"], item["x"])):
        target_row = None
        for row in rows:
            row_center = sum(item["center_y"] for item in row) / len(row)
            if abs(cell["center_y"] - row_center) <= line_threshold:
                target_row = row
                break
        if target_row is None:
            rows.append([cell])
        else:
            target_row.append(cell)

    grouped_rows: List[List[str]] = []
    for row in rows:
        sorted_row = sorted(row, key=lambda item: item["x"])
        grouped_rows.append([item["text"] for item in sorted_row])
    return normalize_table_rows(grouped_rows)


def process_table_roi_with_engine(crop_img: np.ndarray) -> Dict[str, Any]:
    if crop_img is None or crop_img.size == 0:
        return {
            "text": "",
            "confidence": 0.0,
            "segments": [],
            "attempts": [],
            "preprocessing": "table_empty_image",
            "engine": "paddle_table_roi",
            "model": None,
        }

    h_img, w_img = crop_img.shape[:2]
    working_img = crop_img
    scale_factor = 1.0
    longest_side = max(w_img, h_img)
    if longest_side < 1400:
        scale_factor = min(4.0, max(2.0, 1400.0 / max(longest_side, 1)))
        working_img = cv2.resize(
            crop_img,
            (max(1, int(w_img * scale_factor)), max(1, int(h_img * scale_factor))),
            interpolation=cv2.INTER_CUBIC,
        )

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp_file:
        temp_path = temp_file.name
    try:
        cv2.imwrite(temp_path, working_img)
        text_detection = detect_text_boxes(temp_path)
    finally:
        Path(temp_path).unlink(missing_ok=True)

    regions = text_detection.get("regions") or []
    crops: List[np.ndarray] = []
    valid_regions: List[Dict[str, Any]] = []
    h_working, w_working = working_img.shape[:2]
    for region in regions:
        bbox = region.get("bbox") or {}
        x = max(0, int(float(bbox.get("x") or 0)))
        y = max(0, int(float(bbox.get("y") or 0)))
        width = max(1, int(float(bbox.get("width") or 1)))
        height = max(1, int(float(bbox.get("height") or 1)))
        width = min(width, w_working - x)
        height = min(height, h_working - y)
        if width <= 0 or height <= 0:
            continue
        cell_crop = working_img[y : y + height, x : x + width]
        if cell_crop.size == 0:
            continue
        valid_regions.append(region)
        crops.append(cell_crop)

    if not crops:
        fallback_result = run_paddle_thai_ocr(working_img)
        fallback_text = str(fallback_result.get("text") or "").strip()
        return {
            "text": fallback_text,
            "confidence": float(fallback_result.get("confidence") or 0.0),
            "segments": [],
            "attempts": [{"step": "whole_table_fallback", "text": fallback_text}],
            "preprocessing": "table_text_detection_empty_whole_crop_fallback",
            "engine": "paddle_table_roi",
            "model": fallback_result.get("model") or text_detection.get("model"),
            "table_debug": {
                "detected_boxes": 0,
                "scale_factor": scale_factor,
                "input_size": [w_img, h_img],
                "working_size": [w_working, h_working],
            },
        }

    recognitions = run_paddle_thai_ocr_batch(crops)
    table_rows = _group_table_cells(valid_regions, recognitions)
    text = _markdown_table(table_rows)
    table_structured = _structured_table_from_rows(table_rows, valid_regions)
    confidence_values = [
        float(item.get("confidence") or 0.0)
        for item in recognitions
        if str(item.get("text") or "").strip()
    ]
    confidence = sum(confidence_values) / len(confidence_values) if confidence_values else 0.0
    if not text:
        fallback_result = run_paddle_thai_ocr(working_img)
        text = str(fallback_result.get("text") or "").strip()
        confidence = float(fallback_result.get("confidence") or 0.0)

    return {
        "text": text,
        "confidence": float(confidence),
        "segments": [
            {
                "text": str(recognized.get("text") or ""),
                "confidence": float(recognized.get("confidence") or 0.0),
                "bbox": region.get("bbox"),
            }
            for region, recognized in zip(valid_regions, recognitions)
        ],
        "attempts": [],
        "preprocessing": "table_text_detection_then_paddle_recognition",
        "engine": "paddle_table_roi",
        "model": "PP-OCRv5_server_det+th_PP-OCRv5_mobile_rec",
        "table_rows": table_rows,
        "table_structured": table_structured,
        "table_debug": {
            "detected_boxes": len(regions),
            "recognized_cells": len(confidence_values),
            "row_count": len(table_rows),
            "scale_factor": scale_factor,
            "input_size": [w_img, h_img],
            "working_size": [w_working, h_working],
        },
    }


def process_table_roi_v2_with_fallback(crop_img: np.ndarray) -> Dict[str, Any]:
    try:
        return recognize_table_v2(crop_img)
    except TableRecognitionV2UnavailableError as error:
        raise error
    except Exception as error:
        raise TableRecognitionV2UnavailableError(str(error)) from error


def process_roi_with_engine(crop_img: np.ndarray, roi: ROIModel) -> Dict[str, Any]:
    field_type = (roi.type or "text").lower()
    extraction_method = (roi.extractionMethod or "paddle_thai_ocr").lower()
    if extraction_method == "typhoon_ocr":
        extraction_method = "paddle_thai_ocr"

    if extraction_method == "extract_image" or field_type == "image":
        return {
            "text": "",
            "confidence": 1.0,
            "segments": [],
            "attempts": [],
            "preprocessing": "image_crop_only",
            "engine": "extract_image",
            "model": None,
        }

    if field_type == "table" or extraction_method == "table_recognition_v2":
        return process_table_roi_v2_with_fallback(crop_img)

    if extraction_method == "ocr_table":
        return process_table_roi_with_engine(crop_img)

    return recognize_text_crop_with_detection(crop_img)


def _region_type(region: Dict[str, Any]) -> str:
    return str(region.get("type") or region.get("data_type") or "").lower()


def _layout_regions_from_analysis(analysis: Dict[str, Any]) -> List[Dict[str, Any]]:
    if isinstance(analysis.get("regions"), list):
        return [region for region in analysis["regions"] if isinstance(region, dict)]
    data = analysis.get("data")
    if isinstance(data, dict) and isinstance(data.get("regions"), list):
        return [region for region in data["regions"] if isinstance(region, dict)]
    pages = analysis.get("pages")
    if isinstance(pages, list):
        regions: List[Dict[str, Any]] = []
        for page in pages:
            if isinstance(page, dict) and isinstance(page.get("regions"), list):
                regions.extend(region for region in page["regions"] if isinstance(region, dict))
        return regions
    return []


def _is_supported_layout_region(region: Dict[str, Any]) -> bool:
    region_type = _region_type(region).replace("_", " ").replace("-", " ")
    if any(token in region_type for token in ("header", "footer", "page number")):
        return False
    return bool(region.get("roi")) or bool(region.get("bbox"))


def _resolved_layout_region_type(region: Dict[str, Any]) -> str:
    region_type = _region_type(region).replace("_", " ").replace("-", " ")
    if "table" in region_type and "title" not in region_type and "caption" not in region_type:
        return "table"
    if any(token in region_type for token in ("image", "figure", "pic", "seal", "logo", "chart")):
        return "image"
    return "text"


def _extraction_method_for_resolved_type(data_type: str) -> str:
    if data_type == "table":
        return "table_recognition_v2"
    if data_type == "image":
        return "extract_image"
    return "paddle_thai_ocr"


def _region_crop_box(region: Dict[str, Any], image_width: int, image_height: int) -> Tuple[int, int, int, int] | None:
    roi = region.get("roi") if isinstance(region, dict) else None
    bbox = region.get("bbox") if isinstance(region, dict) else None
    try:
        if isinstance(roi, dict):
            x = int(float(roi.get("x_ratio") or 0.0) * image_width)
            y = int(float(roi.get("y_ratio") or 0.0) * image_height)
            w = int(float(roi.get("width_ratio") or 0.0) * image_width)
            h = int(float(roi.get("height_ratio") or 0.0) * image_height)
        elif isinstance(bbox, dict):
            x = int(float(bbox.get("x") or 0.0))
            y = int(float(bbox.get("y") or 0.0))
            w = int(float(bbox.get("width") or 0.0))
            h = int(float(bbox.get("height") or 0.0))
        else:
            return None
    except (TypeError, ValueError):
        return None
    x = max(0, min(x, image_width - 1))
    y = max(0, min(y, image_height - 1))
    w = max(1, min(w, image_width - x))
    h = max(1, min(h, image_height - y))
    return (x, y, w, h)


def _region_roi(region: Dict[str, Any], image_width: int, image_height: int) -> Dict[str, float] | None:
    box = _region_crop_box(region, image_width, image_height)
    if not box:
        return None
    x, y, w, h = box
    return {
        "x_ratio": x / max(float(image_width), 1.0),
        "y_ratio": y / max(float(image_height), 1.0),
        "width_ratio": w / max(float(image_width), 1.0),
        "height_ratio": h / max(float(image_height), 1.0),
    }


def _roi_area(roi: Dict[str, float]) -> float:
    return max(0.0, float(roi.get("width_ratio") or 0.0)) * max(0.0, float(roi.get("height_ratio") or 0.0))


def _roi_intersection_area(left: Dict[str, float], right: Dict[str, float]) -> float:
    left_x = float(left.get("x_ratio") or 0.0)
    left_y = float(left.get("y_ratio") or 0.0)
    left_right = left_x + float(left.get("width_ratio") or 0.0)
    left_bottom = left_y + float(left.get("height_ratio") or 0.0)
    right_x = float(right.get("x_ratio") or 0.0)
    right_y = float(right.get("y_ratio") or 0.0)
    right_right = right_x + float(right.get("width_ratio") or 0.0)
    right_bottom = right_y + float(right.get("height_ratio") or 0.0)
    width = max(0.0, min(left_right, right_right) - max(left_x, right_x))
    height = max(0.0, min(left_bottom, right_bottom) - max(left_y, right_y))
    return width * height


def _filter_nested_flexible_regions(regions: List[Dict[str, Any]], image_width: int, image_height: int) -> List[Dict[str, Any]]:
    prepared: List[Dict[str, Any]] = []
    for region in regions:
        roi = _region_roi(region, image_width, image_height)
        if not roi:
            continue
        data_type = _resolved_layout_region_type(region)
        prepared.append({"region": region, "roi": roi, "data_type": data_type, "area": _roi_area(roi)})

    kept: List[Dict[str, Any]] = []
    for item in sorted(prepared, key=lambda value: value["area"], reverse=True):
        if item["area"] <= 0:
            continue
        nested_in_existing = False
        for existing in kept:
            if existing["data_type"] != item["data_type"]:
                continue
            overlap = _roi_intersection_area(item["roi"], existing["roi"])
            item_overlap = overlap / max(item["area"], 1e-9)
            existing_overlap = overlap / max(existing["area"], 1e-9)
            if item["data_type"] in {"table", "image"}:
                if item_overlap >= 0.72 or existing_overlap >= 0.72:
                    nested_in_existing = True
                    break
                continue
            if item_overlap >= 0.88:
                nested_in_existing = True
                break
        if not nested_in_existing:
            kept.append(item)

    kept_regions = [item["region"] for item in kept]
    kept_regions.sort(key=lambda region: (
        float((_region_roi(region, image_width, image_height) or {}).get("y_ratio") or 0.0),
        float((_region_roi(region, image_width, image_height) or {}).get("x_ratio") or 0.0),
    ))
    return kept_regions


def _ocr_flexible_regions(search_img: np.ndarray, regions: List[Dict[str, Any]], source: str) -> Dict[str, Any]:
    h_img, w_img = search_img.shape[:2]
    texts: List[str] = []
    confidences: List[float] = []
    segments: List[Dict[str, Any]] = []
    for index, region in enumerate(regions):
        box = _region_crop_box(region, w_img, h_img)
        if not box:
            continue
        data_type = _resolved_layout_region_type(region)
        extraction_method = _extraction_method_for_resolved_type(data_type)
        x, y, w, h = box
        block_img = search_img[y : y + h, x : x + w]
        if block_img.size == 0:
            continue
        table_rows = None
        table_structured = None
        table_html = None
        try:
            if data_type == "image":
                text = "(image crop)"
                confidence = 1.0
                raw_segments = []
            elif data_type == "table":
                ocr_result = process_table_roi_v2_with_fallback(block_img)
                text = normalize_ocr_text(ocr_result.get("text"))
                confidence = float(ocr_result.get("confidence") or 0.0)
                raw_segments = ocr_result.get("segments", [])
                table_rows = ocr_result.get("table_rows")
                table_structured = ocr_result.get("table_structured")
                table_html = ocr_result.get("table_html")
            else:
                ocr_result = recognize_text_crop_with_detection(block_img)
                text = normalize_ocr_text(ocr_result.get("text"))
                confidence = float(ocr_result.get("confidence") or 0.0)
                raw_segments = ocr_result.get("segments", [])
            error_message = None
        except Exception as error:
            text = ""
            confidence = 0.0
            raw_segments = []
            error_message = str(error)
        if text:
            texts.append(text)
            confidences.append(confidence)
        segments.append(
            {
                "index": index,
                "text": text,
                "confidence": confidence,
                "bbox": {"x": x, "y": y, "width": w, "height": h},
                "type": data_type,
                "data_type": data_type,
                "extraction_method": extraction_method,
                "layout_type": _region_type(region) or data_type,
                "source": source,
                "raw_segments": raw_segments,
                "table_rows": table_rows,
                "table_structured": table_structured,
                "table_html": table_html,
                "ocr_error": error_message,
            }
        )
    return {
        "text": "\n".join(texts),
        "confidence": sum(confidences) / len(confidences) if confidences else 0.0,
        "segments": segments,
    }


def process_flexible_text_roi(search_img: np.ndarray) -> Dict[str, Any]:
    if search_img.size == 0:
        return {"text": "", "confidence": 0.0, "segments": [], "attempts": [], "engine": "flexible_roi_text"}

    h_img, w_img = search_img.shape[:2]
    analysis = analyze_layout(search_img, expand_text_rois=True, auto_roi_mode="text_line")
    text_regions = [
        region
        for region in _layout_regions_from_analysis(analysis)
        if _is_supported_layout_region(region)
    ]
    if not text_regions:
        text_regions = [
            {
                "type": "text",
                "roi": {
                    "x_ratio": 0.0,
                    "y_ratio": 0.0,
                    "width_ratio": 1.0,
                    "height_ratio": 1.0,
                },
                "source": "pp_doclayout_v3_search_boundary",
                "type": "text",
                "data_type": "text",
                "extraction_method": "paddle_thai_ocr",
            }
        ]
    text_regions = _filter_nested_flexible_regions(text_regions, w_img, h_img)

    result = _ocr_flexible_regions(search_img, text_regions, "pp_doclayout_v3_block")
    attempts = [{"step": "flexible_roi_layout_blocks", "block_count": len(text_regions), "recognized_count": len(result["segments"])}]

    return {
        "text": result.get("text") or "",
        "confidence": float(result.get("confidence") or 0.0),
        "segments": result.get("segments") or [],
        "attempts": attempts,
        "preprocessing": "flexible_roi_search_boundary_layout_blocks",
        "engine": "flexible_roi_text",
        "model": "PP-DocLayoutV3 + text_ocr_pipeline",
        "resolved_blocks": result.get("segments") or [],
    }


def _payload_to_json(payload: DocumentPayload) -> str:
    if hasattr(payload, "model_dump"):
        data = payload.model_dump()
    else:
        data = payload.dict()
    data["async_mode"] = False
    return json.dumps(data, ensure_ascii=False)


def create_ocr_job(payload: DocumentPayload) -> str:
    job_id = f"ocr_{uuid.uuid4().hex}"
    with db_connect() as conn:
        conn.execute(
            """
            INSERT INTO ocr_jobs (id, status, request_json)
            VALUES (?, 'queued', ?)
            """,
            (job_id, _payload_to_json(payload)),
        )
    return job_id


def get_ocr_job(job_id: str) -> Dict[str, Any] | None:
    with db_connect() as conn:
        row = conn.execute(
            """
            SELECT id, status, requested_at, started_at, completed_at, error_message, result_json
            FROM ocr_jobs
            WHERE id = ?
            """,
            (job_id,),
        ).fetchone()
    if not row:
        return None
    result = dict(row)
    result_json = result.pop("result_json", None)
    if result_json:
        try:
            result["result"] = json.loads(result_json)
        except json.JSONDecodeError:
            result["result"] = None
    return result


def update_ocr_job_status(job_id: str, status: str, error_message: str | None = None, result: Dict[str, Any] | None = None) -> None:
    result_json = json.dumps(result, ensure_ascii=False) if result is not None else None
    with db_connect() as conn:
        if status == "processing":
            conn.execute(
                """
                UPDATE ocr_jobs
                SET status = 'processing', started_at = CURRENT_TIMESTAMP, error_message = NULL
                WHERE id = ?
                """,
                (job_id,),
            )
        elif status == "completed":
            conn.execute(
                """
                UPDATE ocr_jobs
                SET status = 'completed', completed_at = CURRENT_TIMESTAMP, result_json = ?, error_message = NULL
                WHERE id = ?
                """,
                (result_json, job_id),
            )
        elif status == "failed":
            conn.execute(
                """
                UPDATE ocr_jobs
                SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error_message = ?
                WHERE id = ?
                """,
                (error_message or "OCR job failed.", job_id),
            )


def run_ocr_job(job_id: str) -> None:
    job = get_ocr_job(job_id)
    if not job:
        return
    try:
        update_ocr_job_status(job_id, "processing")
        with db_connect() as conn:
            row = conn.execute("SELECT request_json FROM ocr_jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            raise RuntimeError("OCR job request payload not found.")
        payload = DocumentPayload(**json.loads(row["request_json"]))
        result = process_document_payload(payload)
        update_ocr_job_status(job_id, "completed", result=result)
    except Exception as error:
        update_ocr_job_status(job_id, "failed", error_message=str(error))


def process_document_payload(payload: DocumentPayload) -> Dict[str, Any]:
    _, opencv_img = decode_base64_image(payload.image)
    h_img, w_img = opencv_img.shape[:2]
    results = []

    if not payload.rois:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp_file:
            temp_path = temp_file.name
        try:
            cv2.imwrite(temp_path, opencv_img)
            text_detection = detect_text_boxes(temp_path)
        finally:
            Path(temp_path).unlink(missing_ok=True)

        for idx, region in enumerate(text_detection.get("regions", [])):
            bbox = region.get("bbox") or {}
            x = max(0, int(float(bbox.get("x") or 0)))
            y = max(0, int(float(bbox.get("y") or 0)))
            w = max(1, int(float(bbox.get("width") or 1)))
            h = max(1, int(float(bbox.get("height") or 1)))
            w = min(w, w_img - x)
            h = min(h, h_img - y)

            crop_img = opencv_img[y : y + h, x : x + w]
            ocr_result = run_paddle_thai_ocr(crop_img) if crop_img.size > 0 else {"text": "", "confidence": 0.0, "segments": []}
            text = normalize_ocr_text(ocr_result.get("text"))
            conf = float(ocr_result.get("confidence") or 0.0)
            filepath = ""
            if crop_img.size > 0:
                filename = f"line_{idx + 1}_{uuid.uuid4().hex[:6]}.png"
                filepath = os.path.join(OUTPUT_DIR, filename)
                cv2.imwrite(filepath, crop_img)

            results.append(
                {
                    "fieldName": f"line_{idx + 1}",
                    "text": text,
                    "confidence": float(conf),
                    "saved_path": filepath,
                    "x": float(x),
                    "y": float(y),
                    "width": float(w),
                    "height": float(h),
                    "bbox": [
                        [float(x), float(y)],
                        [float(x + w), float(y)],
                        [float(x + w), float(y + h)],
                        [float(x), float(y + h)],
                    ],
                    "raw_segments": ocr_result.get("segments", []),
                    "ocr_attempts": [],
                    "ocr_preprocessing": ocr_result.get("preprocessing", "paddle_text_detection_crop"),
                    "ocr_engine": ocr_result.get("engine", "paddle_thai_ocr"),
                    "ocr_model": ocr_result.get("model"),
                }
            )
    else:
        for idx, roi in enumerate(payload.rois):
            crop_img = crop_opencv_region(
                opencv_img,
                int(roi.x),
                int(roi.y),
                int(roi.width),
                int(roi.height),
            )
            if crop_img.size == 0:
                continue

            filename = f"{roi.fieldName}_{idx}_{uuid.uuid4().hex[:6]}.png"
            filepath = os.path.join(OUTPUT_DIR, filename)
            cv2.imwrite(filepath, crop_img)

            roi_mode = (roi.roiMode or "fix").lower()
            expected_content = (roi.expectedContent or "").lower()
            if roi_mode == "flexible" and expected_content == "text":
                ocr_result = process_flexible_text_roi(crop_img)
            else:
                ocr_result = process_roi_with_engine(crop_img, roi)
            extracted_text = normalize_ocr_text(ocr_result.get("text"))
            confidence_score = float(ocr_result.get("confidence") or 0.0)
            if not extracted_text and (roi.type or "").lower() != "image":
                extracted_text = "(ไม่พบข้อความในพื้นที่ที่กำหนด)"
                confidence_score = 0.0

            results.append(
                {
                    "roiId": roi.roiId,
                    "fieldName": roi.fieldName,
                    "text": extracted_text,
                    "confidence": confidence_score,
                    "saved_path": filepath,
                    "type": roi.type,
                    "extraction_method": roi.extractionMethod,
                    "roi_mode": roi.roiMode or "fix",
                    "expected_content": roi.expectedContent,
                    "raw_segments": ocr_result.get("segments", []),
                    "ocr_attempts": ocr_result.get("attempts", []),
                    "ocr_preprocessing": ocr_result.get("preprocessing", "none"),
                    "ocr_engine": ocr_result.get("engine", "unknown"),
                    "ocr_model": ocr_result.get("model"),
                    "table_rows": ocr_result.get("table_rows"),
                    "table_structured": ocr_result.get("table_structured"),
                    "table_sections": ocr_result.get("table_sections"),
                    "table_html": ocr_result.get("table_html"),
                    "table_debug": ocr_result.get("table_debug"),
                }
            )

    return {
        "success": True,
        "extracted_data": results,
    }


@app.get("/")
def read_root():
    return {
        "status": "OCR Engine Online",
        "framework": "FastAPI",
    }


@app.post("/api/ai/process")
async def process_document(payload: DocumentPayload, background_tasks: BackgroundTasks):
    try:
        if payload.async_mode:
            job_id = create_ocr_job(payload)
            background_tasks.add_task(run_ocr_job, job_id)
            return {"success": True, "job_id": job_id, "status": "queued"}
        return process_document_payload(payload)
    except PaddleThaiOcrUnavailableError as err:
        print("Paddle Thai OCR processing error:")
        import traceback

        traceback.print_exc()
        raise HTTPException(status_code=503, detail=str(err))
    except LayoutAnalysisUnavailableError as err:
        print("Paddle text detection error:")
        import traceback

        traceback.print_exc()
        raise HTTPException(status_code=503, detail=str(err))
    except Exception as err:
        print("OCR processing error:")
        import traceback

        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(err))


@app.get("/api/ai/jobs/{job_id}")
async def get_ai_process_job(job_id: str):
    job = get_ocr_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="OCR job not found.")
    response: Dict[str, Any] = {
        "success": True,
        "job_id": job["id"],
        "status": job["status"],
        "requested_at": str(job.get("requested_at")) if job.get("requested_at") is not None else None,
        "started_at": str(job.get("started_at")) if job.get("started_at") is not None else None,
        "completed_at": str(job.get("completed_at")) if job.get("completed_at") is not None else None,
    }
    if job["status"] == "completed":
        response["result"] = job.get("result") or {"success": True, "extracted_data": []}
    if job["status"] == "failed":
        response["error"] = job.get("error_message") or "OCR job failed."
    return response


@app.post("/api/layout/analyze")
async def analyze_document_layout(payload: LayoutAnalysisPayload):
    if not payload.images:
        raise HTTPException(status_code=400, detail="At least one page image is required.")

    pages: List[Dict[str, Any]] = []
    try:
        for page in payload.images:
            _, opencv_img = decode_base64_image(page.image)
            analysis = analyze_layout(opencv_img, expand_text_rois=True, auto_roi_mode="text_line")
            regions = []
            for index, region in enumerate(analysis["regions"], start=1):
                region_type = region["type"]
                extraction_method = (
                    "extract_image"
                    if region_type == "image"
                    else "table_recognition_v2"
                    if region_type == "table"
                    else "paddle_thai_ocr"
                )
                regions.append(
                    {
                        "field_name": f"{region_type}_{index}",
                        "type": region_type,
                        "data_type": region_type,
                        "extraction_method": extraction_method,
                        "confidence": region.get("confidence", 0.0),
                        "roi_expansion": region.get("roi_expansion"),
                        "auto_roi_group": region.get("auto_roi_group"),
                        "roi": {
                            "page_number": int(page.page_index) + 1,
                            **region["roi"],
                        },
                    }
                )

            pages.append(
                {
                    "page_index": page.page_index,
                    "page_number": int(page.page_index) + 1,
                    "image_width": analysis["image_width"],
                    "image_height": analysis["image_height"],
                    "engine": analysis["engine"],
                    "model": analysis["model"],
                    "regions": regions,
                    "message": None if regions else "No layout regions found on this page.",
                }
            )

        return {
            "success": True,
            "engine": "paddleocr",
            "model": "PP-DocLayoutV3+PP-OCRv5",
            "auto_roi_mode": "text_line",
            "pages": pages,
        }
    except LayoutAnalysisUnavailableError as err:
        raise HTTPException(status_code=503, detail=str(err))
    except Exception as err:
        print("Layout analysis error:")
        import traceback

        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(err))
