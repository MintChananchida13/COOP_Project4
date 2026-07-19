import base64
import io
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Tuple

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

os.environ.setdefault("MODEL_RUNTIME_ROLE", "service")

from app.layout_analysis_service import LayoutAnalysisUnavailableError, analyze_layout, detect_text_boxes
from app.paddle_thai_ocr_adapter import PaddleThaiOcrUnavailableError, run_paddle_thai_ocr, run_paddle_thai_ocr_batch
from app.vision_embedding_adapter import encode_images


class ImagePayload(BaseModel):
    image: str


class ImagesPayload(BaseModel):
    images: List[str]


app = FastAPI(title="OCR Model Runtime Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_runtime_timing(request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    if request.url.path.startswith("/runtime/") and os.getenv("MODEL_RUNTIME_LOG_TIMING", "true").strip().lower() not in {"0", "false", "no", "off"}:
        elapsed = round(time.perf_counter() - started, 3)
        print(f"[model-runtime] {request.method} {request.url.path} -> {response.status_code} in {elapsed}s")
    return response


def _decode_image(image_str: str) -> Tuple[Image.Image, np.ndarray]:
    _, encoded = image_str.split(",", 1) if "," in image_str else ("", image_str)
    image_data = base64.b64decode(encoded)
    pil_image = Image.open(io.BytesIO(image_data)).convert("RGB")
    opencv_img = cv2.cvtColor(np.array(pil_image), cv2.COLOR_RGB2BGR)
    return pil_image, opencv_img


def _data_url_to_temp_image(image_str: str) -> str:
    _, opencv_img = _decode_image(image_str)
    temp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
    temp.close()
    if not cv2.imwrite(temp.name, opencv_img):
        raise ValueError("Unable to prepare temporary image.")
    return temp.name


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    return str(value)


def _warmup() -> Dict[str, Any]:
    started = time.perf_counter()
    sample = np.full((420, 720, 3), 255, dtype=np.uint8)
    cv2.putText(sample, "Thai National ID Card", (40, 90), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2, cv2.LINE_AA)
    cv2.putText(sample, "Name 1234567890", (40, 150), cv2.FONT_HERSHEY_SIMPLEX, 0.85, (0, 0, 0), 2, cv2.LINE_AA)
    cv2.rectangle(sample, (40, 210), (680, 350), (0, 0, 0), 2)

    layout = analyze_layout(sample)
    temp_path = _data_url_to_temp_image("data:image/png;base64," + base64.b64encode(cv2.imencode(".png", sample)[1].tobytes()).decode("ascii"))
    try:
        text_boxes = detect_text_boxes(temp_path)
    finally:
        Path(temp_path).unlink(missing_ok=True)
    recognition = run_paddle_thai_ocr(sample[45:170, 30:500])

    embedding_summary: Dict[str, Any] = {"enabled": False}
    if os.getenv("VISION_EMBEDDING_MODE", "stub").strip().lower() == "dinov2":
        temp_path = _data_url_to_temp_image("data:image/png;base64," + base64.b64encode(cv2.imencode(".png", sample)[1].tobytes()).decode("ascii"))
        try:
            embedding = encode_images([temp_path])
            embedding_summary = {
                "enabled": True,
                "engine": embedding.engine,
                "model": embedding.model_name,
                "dimension": embedding.dimension,
            }
        finally:
            Path(temp_path).unlink(missing_ok=True)

    return {
        "layout_regions": len(layout.get("regions") or []),
        "text_boxes": len(text_boxes.get("regions") or []),
        "ocr_model": recognition.get("model"),
        "vision_embedding": embedding_summary,
        "elapsed_seconds": round(time.perf_counter() - started, 2),
    }


@app.on_event("startup")
async def startup_warmup() -> None:
    if os.getenv("MODEL_SERVICE_WARMUP", "true").strip().lower() in {"0", "false", "no", "off"}:
        print("Model runtime warm-up skipped (MODEL_SERVICE_WARMUP=false).")
        return
    print("Warming up model runtime service...")
    try:
        summary = _warmup()
        print(f"Model runtime warm-up complete in {summary['elapsed_seconds']}s: {summary}")
    except Exception as error:
        print(f"Model runtime warm-up failed: {error}")
        if os.getenv("MODEL_SERVICE_WARMUP_STRICT", "false").strip().lower() in {"1", "true", "yes", "on"}:
            raise


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "role": "model_runtime_service",
        "layout_model": "PP-DocLayoutV3",
        "text_detection_model": "PP-OCRv5_server_det",
        "ocr_model": os.getenv("PADDLE_THAI_OCR_MODEL_NAME", "th_PP-OCRv5_mobile_rec"),
        "vision_embedding_mode": os.getenv("VISION_EMBEDDING_MODE", "stub").strip().lower(),
    }


@app.post("/runtime/warmup")
def warmup() -> Dict[str, Any]:
    try:
        return {"success": True, "data": _warmup()}
    except Exception as error:
        raise HTTPException(status_code=503, detail=str(error))


@app.post("/runtime/layout/analyze")
def runtime_analyze_layout(payload: ImagePayload) -> Dict[str, Any]:
    try:
        _, opencv_img = _decode_image(payload.image)
        return {"success": True, "data": _json_safe(analyze_layout(opencv_img))}
    except LayoutAnalysisUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error))
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


@app.post("/runtime/text/detect")
def runtime_detect_text(payload: ImagePayload) -> Dict[str, Any]:
    temp_path = ""
    try:
        temp_path = _data_url_to_temp_image(payload.image)
        return {"success": True, "data": _json_safe(detect_text_boxes(temp_path))}
    except LayoutAnalysisUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error))
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))
    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)


@app.post("/runtime/ocr/recognize")
def runtime_recognize(payload: ImagePayload) -> Dict[str, Any]:
    try:
        _, opencv_img = _decode_image(payload.image)
        return {"success": True, "data": _json_safe(run_paddle_thai_ocr(opencv_img))}
    except PaddleThaiOcrUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error))
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


@app.post("/runtime/ocr/recognize-batch")
def runtime_recognize_batch(payload: ImagesPayload) -> Dict[str, Any]:
    try:
        images = [_decode_image(image)[1] for image in payload.images]
        return {"success": True, "data": {"results": _json_safe(run_paddle_thai_ocr_batch(images))}}
    except PaddleThaiOcrUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error))
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


@app.post("/runtime/vision/encode")
def runtime_encode_images(payload: ImagesPayload) -> Dict[str, Any]:
    temp_paths: List[str] = []
    try:
        for image in payload.images:
            temp_paths.append(_data_url_to_temp_image(image))
        result = encode_images(temp_paths)
        return {
            "success": True,
            "data": _json_safe({
                "vector": result.vector,
                "dimension": result.dimension,
                "engine": result.engine,
                "version": result.version,
                "model_name": result.model_name,
                "input_count": result.input_count,
                "device": result.device,
            }),
        }
    except Exception as error:
        raise HTTPException(status_code=503, detail=str(error))
    finally:
        for temp_path in temp_paths:
            Path(temp_path).unlink(missing_ok=True)
