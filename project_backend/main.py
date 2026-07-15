import base64
import io
import os
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, List, Tuple

import cv2
import easyocr
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

from app.routes import router as blueprint_router

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


class DocumentPayload(BaseModel):
    image: str
    rois: List[ROIModel]


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

print("Loading EasyOCR (TH/EN) engine...")
ocr_engine = easyocr.Reader(["th", "en"], gpu=False)
print("EasyOCR engine ready.")


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


def preprocess_ocr_variants(opencv_img: np.ndarray) -> List[Tuple[str, np.ndarray]]:
    padded = cv2.copyMakeBorder(
        opencv_img,
        15,
        15,
        15,
        15,
        cv2.BORDER_CONSTANT,
        value=[255, 255, 255],
    )
    variants: List[Tuple[str, np.ndarray]] = [("original_padded", padded)]

    height, width = padded.shape[:2]
    if max(height, width) < 900:
        variants.append(("upscaled_2x", cv2.resize(padded, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)))

    gray = cv2.cvtColor(padded, cv2.COLOR_BGR2GRAY)
    variants.append(("grayscale", cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)))

    sharpen_kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]])
    sharpened = cv2.filter2D(gray, -1, sharpen_kernel)
    variants.append(("sharpened", cv2.cvtColor(sharpened, cv2.COLOR_GRAY2BGR)))

    try:
        thresholded = cv2.adaptiveThreshold(
            gray,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            31,
            7,
        )
        variants.append(("adaptive_threshold", cv2.cvtColor(thresholded, cv2.COLOR_GRAY2BGR)))
    except cv2.error:
        pass

    return variants


def _segments_from_easyocr(ocr_result: list) -> List[Dict[str, Any]]:
    segments = []
    for line in ocr_result:
        bbox, text, conf = line
        segments.append(
            {
                "text": str(text),
                "confidence": float(conf),
                "bbox": [[float(pt[0]), float(pt[1])] for pt in bbox],
            }
        )
    return segments


def _summarize_ocr_segments(segments: List[Dict[str, Any]]) -> Tuple[str, float]:
    if not segments:
        return "", 0.0
    texts = [str(segment["text"]) for segment in segments]
    confs = [float(segment["confidence"]) for segment in segments]
    confidence = sum(confs) / len(confs) if confs else 0.0
    return " ".join(texts).strip(), confidence


def ocr_crop(opencv_img: np.ndarray) -> Dict[str, Any]:
    best_result: Dict[str, Any] = {
        "text": "",
        "confidence": 0.0,
        "segments": [],
        "preprocessing": "none",
        "attempts": [],
    }
    try:
        for variant_name, variant_image in preprocess_ocr_variants(opencv_img):
            ocr_result = ocr_engine.readtext(variant_image)
            segments = _segments_from_easyocr(ocr_result)
            text, confidence = _summarize_ocr_segments(segments)
            attempt = {
                "preprocessing": variant_name,
                "text": text,
                "confidence": float(confidence),
                "segment_count": len(segments),
                "segments": segments,
            }
            best_result["attempts"].append(attempt)
            if text and (confidence > float(best_result["confidence"]) or not best_result["text"]):
                best_result.update(
                    {
                        "text": text,
                        "confidence": float(confidence),
                        "segments": segments,
                        "preprocessing": variant_name,
                    }
                )
        return best_result
    except Exception as err:
        print(f"OCR crop error: {err}")
        return best_result


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
            ocr_result = ocr_engine.readtext(opencv_img)
            for idx, line in enumerate(ocr_result):
                bbox, text, conf = line
                xs = [pt[0] for pt in bbox]
                ys = [pt[1] for pt in bbox]
                x = max(0, int(min(xs)))
                y = max(0, int(min(ys)))
                w = max(1, int(max(xs) - x))
                h = max(1, int(max(ys) - y))
                w = min(w, w_img - x)
                h = min(h, h_img - y)

                crop_img = opencv_img[y : y + h, x : x + w]
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
                        "bbox": [[float(pt[0]), float(pt[1])] for pt in bbox],
                        "raw_segments": [
                            {
                                "text": str(text),
                                "confidence": float(conf),
                                "bbox": [[float(pt[0]), float(pt[1])] for pt in bbox],
                            }
                        ],
                        "ocr_attempts": [],
                        "ocr_preprocessing": "full_page",
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

                ocr_result = ocr_crop(crop_img)
                extracted_text = str(ocr_result.get("text") or "")
                confidence_score = float(ocr_result.get("confidence") or 0.0)
                if not extracted_text:
                    extracted_text = "(no text found in ROI)"
                    confidence_score = 0.0

                results.append(
                    {
                        "fieldName": roi.fieldName,
                        "text": extracted_text,
                        "confidence": confidence_score,
                        "saved_path": filepath,
                        "raw_segments": ocr_result.get("segments", []),
                        "ocr_attempts": ocr_result.get("attempts", []),
                        "ocr_preprocessing": ocr_result.get("preprocessing", "none"),
                    }
                )

        return {
            "success": True,
            "extracted_data": results,
        }
    except Exception as err:
        print("OCR processing error:")
        import traceback

        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(err))
