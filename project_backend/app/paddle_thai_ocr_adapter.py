import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np


class PaddleThaiOcrUnavailableError(RuntimeError):
    pass


BACKEND_ROOT = Path(__file__).resolve().parents[1]
PADDLE_CACHE_DIR = BACKEND_ROOT / "storage" / "paddlex_cache"
PADDLE_TEMP_DIR = BACKEND_ROOT / "storage" / "paddle_tmp"
PADDLE_THAI_OCR_MODEL_NAME = os.environ.get("PADDLE_THAI_OCR_MODEL_NAME", "th_PP-OCRv5_mobile_rec")
PADDLE_THAI_OCR_MODEL_DIR = os.environ.get("PADDLE_THAI_OCR_MODEL_DIR")

PADDLE_TEMP_DIR.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(PADDLE_CACHE_DIR))
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "False")
os.environ.setdefault("PADDLE_PDX_USE_PIR_TRT", "False")
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("FLAGS_json_format_model", "False")
os.environ.setdefault("TMP", str(PADDLE_TEMP_DIR))
os.environ.setdefault("TEMP", str(PADDLE_TEMP_DIR))


_TEXT_RECOGNIZER: Any = None


def _common_model_kwargs() -> Dict[str, Any]:
    return {
        "device": "cpu",
        "enable_mkldnn": False,
        "enable_cinn": False,
        "use_tensorrt": False,
    }


def _load_text_recognizer() -> Any:
    global _TEXT_RECOGNIZER
    if _TEXT_RECOGNIZER is not None:
        return _TEXT_RECOGNIZER

    try:
        from paddleocr import TextRecognition  # type: ignore
    except ImportError as error:
        raise PaddleThaiOcrUnavailableError(
            "Paddle Thai OCR requires paddleocr 3.x with TextRecognition installed."
        ) from error

    try:
        kwargs: Dict[str, Any] = _common_model_kwargs()
        if PADDLE_THAI_OCR_MODEL_DIR:
            kwargs["model_dir"] = PADDLE_THAI_OCR_MODEL_DIR
        else:
            kwargs["model_name"] = PADDLE_THAI_OCR_MODEL_NAME
        _TEXT_RECOGNIZER = TextRecognition(**kwargs)
        return _TEXT_RECOGNIZER
    except Exception as error:
        raise PaddleThaiOcrUnavailableError(
            f"Failed to initialize PaddleOCR {PADDLE_THAI_OCR_MODEL_NAME}: {error}"
        ) from error


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
            pass
    return None


def _walk_values(value: Any) -> List[Any]:
    found = [value]
    value_dict = _as_dict(value)
    if value_dict is not None:
        for child in value_dict.values():
            found.extend(_walk_values(child))
        return found
    if isinstance(value, (list, tuple)):
        for child in value:
            found.extend(_walk_values(child))
    return found


def _extract_text_confidence(value: Any) -> Tuple[str, float]:
    text_candidates: List[str] = []
    confidence_candidates: List[float] = []

    for item in _walk_values(value):
        item_dict = _as_dict(item)
        if not item_dict:
            continue

        for key in ("rec_text", "text", "label"):
            candidate = item_dict.get(key)
            if isinstance(candidate, str) and candidate.strip():
                text_candidates.append(candidate.strip())

        for key in ("rec_score", "confidence", "score", "prob"):
            candidate_score = item_dict.get(key)
            if isinstance(candidate_score, (int, float)):
                confidence_candidates.append(float(candidate_score))

    text = " ".join(dict.fromkeys(text_candidates)).strip()
    confidence = sum(confidence_candidates) / len(confidence_candidates) if confidence_candidates else 0.0
    return text, confidence


def _opencv_to_temp_png(opencv_img: np.ndarray) -> str:
    temp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
    temp.close()
    if not cv2.imwrite(temp.name, opencv_img):
        raise PaddleThaiOcrUnavailableError("Failed to prepare ROI image for Paddle Thai OCR.")
    return temp.name


def run_paddle_thai_ocr(opencv_img: np.ndarray) -> Dict[str, Any]:
    if opencv_img is None or opencv_img.size == 0:
        return {
            "text": "",
            "confidence": 0.0,
            "engine": "paddle_thai_ocr",
            "model": PADDLE_THAI_OCR_MODEL_NAME,
            "error": "empty_image",
        }

    image_path = _opencv_to_temp_png(opencv_img)
    try:
        model = _load_text_recognizer()
        predict = getattr(model, "predict", None)
        output = predict(input=image_path, batch_size=1) if callable(predict) else model(image_path)
        text, confidence = _extract_text_confidence(output)

        return {
            "text": text,
            "confidence": float(confidence),
            "engine": "paddle_thai_ocr",
            "model": PADDLE_THAI_OCR_MODEL_NAME,
            "segments": [],
            "attempts": [],
            "preprocessing": "paddle_text_recognition",
            "raw_output": [_as_dict(item) or str(item) for item in output] if isinstance(output, (list, tuple)) else [_as_dict(output) or str(output)],
        }
    except PaddleThaiOcrUnavailableError:
        raise
    except Exception as error:
        raise PaddleThaiOcrUnavailableError(f"Paddle Thai OCR inference failed: {error}") from error
    finally:
        try:
            os.unlink(image_path)
        except OSError:
            pass
