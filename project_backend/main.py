import base64
import io
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Tuple

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

from app.routes import router as blueprint_router
from app.layout_analysis_service import LayoutAnalysisUnavailableError, analyze_layout, detect_text_boxes
from app.paddle_thai_ocr_adapter import PaddleThaiOcrUnavailableError, run_paddle_thai_ocr, run_paddle_thai_ocr_batch
from app.table_recognition_v2_adapter import TableRecognitionV2UnavailableError, recognize_table_v2

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
    type: str | None = None
    extractionMethod: str | None = None


class DocumentPayload(BaseModel):
    image: str
    rois: List[ROIModel]


class LayoutImagePayload(BaseModel):
    page_index: int
    image: str


class LayoutAnalysisPayload(BaseModel):
    images: List[LayoutImagePayload]


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


def _group_table_cells(regions: List[Dict[str, Any]], recognitions: List[Dict[str, Any]]) -> List[List[str]]:
    cells: List[Dict[str, Any]] = []
    for region, recognized in zip(regions, recognitions):
        text = str(recognized.get("text") or "").strip()
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
    return grouped_rows


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
        result = recognize_table_v2(crop_img)
        if str(result.get("text") or "").strip() or result.get("table_html"):
            return result
        fallback = process_table_roi_with_engine(crop_img)
        fallback["engine"] = "table_recognition_v2_fallback"
        fallback["preprocessing"] = f"table_recognition_v2_empty_then_{fallback.get('preprocessing', 'fallback')}"
        fallback["table_debug"] = {
            **(fallback.get("table_debug") or {}),
            "table_recognition_v2_status": (result.get("table_debug") or {}).get("status", "empty"),
            "fallback_engine": "paddle_table_roi",
        }
        return fallback
    except TableRecognitionV2UnavailableError as error:
        fallback = process_table_roi_with_engine(crop_img)
        fallback["engine"] = "table_recognition_v2_fallback"
        fallback["preprocessing"] = f"table_recognition_v2_unavailable_then_{fallback.get('preprocessing', 'fallback')}"
        fallback["table_debug"] = {
            **(fallback.get("table_debug") or {}),
            "table_recognition_v2_error": str(error),
            "fallback_engine": "paddle_table_roi",
        }
        return fallback
    except Exception as error:
        fallback = process_table_roi_with_engine(crop_img)
        fallback["engine"] = "table_recognition_v2_fallback"
        fallback["preprocessing"] = f"table_recognition_v2_error_then_{fallback.get('preprocessing', 'fallback')}"
        fallback["table_debug"] = {
            **(fallback.get("table_debug") or {}),
            "table_recognition_v2_error": str(error),
            "fallback_engine": "paddle_table_roi",
        }
        return fallback


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

    return run_paddle_thai_ocr(crop_img)


@app.get("/")
def read_root():
    return {
        "status": "OCR Engine Online",
        "framework": "FastAPI",
    }


@app.post("/api/ai/process")
async def process_document(payload: DocumentPayload):
    try:
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
                text = str(ocr_result.get("text") or "")
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

                ocr_result = process_roi_with_engine(crop_img, roi)
                extracted_text = str(ocr_result.get("text") or "")
                confidence_score = float(ocr_result.get("confidence") or 0.0)
                if not extracted_text and (roi.type or "").lower() != "image":
                    extracted_text = "(no text found in ROI)"
                    confidence_score = 0.0

                results.append(
                    {
                        "fieldName": roi.fieldName,
                        "text": extracted_text,
                        "confidence": confidence_score,
                        "saved_path": filepath,
                        "type": roi.type,
                        "extraction_method": roi.extractionMethod,
                        "raw_segments": ocr_result.get("segments", []),
                        "ocr_attempts": ocr_result.get("attempts", []),
                        "ocr_preprocessing": ocr_result.get("preprocessing", "none"),
                        "ocr_engine": ocr_result.get("engine", "unknown"),
                        "ocr_model": ocr_result.get("model"),
                        "table_rows": ocr_result.get("table_rows"),
                        "table_html": ocr_result.get("table_html"),
                        "table_debug": ocr_result.get("table_debug"),
                    }
                )

        return {
            "success": True,
            "extracted_data": results,
        }
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


@app.post("/api/layout/analyze")
async def analyze_document_layout(payload: LayoutAnalysisPayload):
    if not payload.images:
        raise HTTPException(status_code=400, detail="At least one page image is required.")

    pages: List[Dict[str, Any]] = []
    try:
        for page in payload.images:
            _, opencv_img = decode_base64_image(page.image)
            analysis = analyze_layout(opencv_img, expand_text_rois=True)
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
            "pages": pages,
        }
    except LayoutAnalysisUnavailableError as err:
        raise HTTPException(status_code=503, detail=str(err))
    except Exception as err:
        print("Layout analysis error:")
        import traceback

        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(err))
