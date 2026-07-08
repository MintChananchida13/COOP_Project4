import base64
import io
import os
import sys
import uuid
from pathlib import Path
from typing import List, Tuple

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


def ocr_crop(opencv_img: np.ndarray) -> Tuple[str, float]:
    padded = cv2.copyMakeBorder(
        opencv_img,
        15,
        15,
        15,
        15,
        cv2.BORDER_CONSTANT,
        value=[255, 255, 255],
    )
    try:
        ocr_result = ocr_engine.readtext(padded)
        if not ocr_result:
            return "", 0.0
        texts = [str(line[1]) for line in ocr_result]
        confs = [float(line[2]) for line in ocr_result]
        confidence = sum(confs) / len(confs) if confs else 0.0
        return " ".join(texts).strip(), confidence
    except Exception as err:
        print(f"OCR crop error: {err}")
        return "", 0.0


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

                extracted_text, confidence_score = ocr_crop(crop_img)
                if not extracted_text:
                    extracted_text = "(no text found in ROI)"
                    confidence_score = 0.0

                results.append(
                    {
                        "fieldName": roi.fieldName,
                        "text": extracted_text,
                        "confidence": confidence_score,
                        "saved_path": filepath,
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
