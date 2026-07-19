import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

from .model_runtime_client import ModelRuntimeUnavailableError, remote_recognize_image, remote_recognize_images


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


def _env_flag(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


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


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    return str(value)


def _opencv_to_temp_png(opencv_img: np.ndarray) -> str:
    temp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
    temp.close()
    if not cv2.imwrite(temp.name, opencv_img):
        raise PaddleThaiOcrUnavailableError("Failed to prepare ROI image for Paddle Thai OCR.")
    return temp.name


def _result_from_output(output: Any) -> Dict[str, Any]:
    text, confidence = _extract_text_confidence(output)
    result = {
        "text": text,
        "confidence": float(confidence),
        "engine": "paddle_thai_ocr",
        "model": PADDLE_THAI_OCR_MODEL_NAME,
        "segments": [],
        "attempts": [],
        "preprocessing": "paddle_text_recognition",
    }
    if _env_flag("PADDLE_OCR_INCLUDE_RAW_OUTPUT", "false"):
        result["raw_output"] = _json_safe([_as_dict(output) or str(output)])
    return result


def run_paddle_thai_ocr(opencv_img: np.ndarray) -> Dict[str, Any]:
    if opencv_img is None or opencv_img.size == 0:
        return {
            "text": "",
            "confidence": 0.0,
            "engine": "paddle_thai_ocr",
            "model": PADDLE_THAI_OCR_MODEL_NAME,
            "error": "empty_image",
        }

    try:
        remote_result = remote_recognize_image(opencv_img)
        if remote_result is not None:
            return remote_result
    except ModelRuntimeUnavailableError as error:
        if os.getenv("MODEL_SERVICE_STRICT", "false").strip().lower() in {"1", "true", "yes", "on"}:
            raise PaddleThaiOcrUnavailableError(str(error)) from error

    image_path = _opencv_to_temp_png(opencv_img)
    try:
        model = _load_text_recognizer()
        predict = getattr(model, "predict", None)
        output = predict(input=image_path, batch_size=1) if callable(predict) else model(image_path)
        return _result_from_output(output)
    except PaddleThaiOcrUnavailableError:
        raise
    except Exception as error:
        raise PaddleThaiOcrUnavailableError(f"Paddle Thai OCR inference failed: {error}") from error
    finally:
        try:
            os.unlink(image_path)
        except OSError:
            pass


def run_paddle_thai_ocr_batch(opencv_images: List[np.ndarray]) -> List[Dict[str, Any]]:
    if not opencv_images:
        return []

    try:
        remote_result = remote_recognize_images(opencv_images)
        if remote_result is not None:
            results = remote_result.get("results")
            if isinstance(results, list):
                return [item if isinstance(item, dict) else {"text": "", "confidence": 0.0, "error": "invalid_batch_item"} for item in results]
    except ModelRuntimeUnavailableError as error:
        if os.getenv("MODEL_SERVICE_STRICT", "false").strip().lower() in {"1", "true", "yes", "on"}:
            raise PaddleThaiOcrUnavailableError(str(error)) from error

    temp_paths: List[str] = []
    try:
        for image in opencv_images:
            if image is None or image.size == 0:
                temp_paths.append("")
            else:
                temp_paths.append(_opencv_to_temp_png(image))

        model = _load_text_recognizer()
        predict = getattr(model, "predict", None)
        valid_paths = [path for path in temp_paths if path]
        if not valid_paths:
            return [
                {
                    "text": "",
                    "confidence": 0.0,
                    "engine": "paddle_thai_ocr",
                    "model": PADDLE_THAI_OCR_MODEL_NAME,
                    "error": "empty_image",
                }
                for _ in opencv_images
            ]

        try:
            output = predict(input=valid_paths, batch_size=max(1, min(len(valid_paths), int(os.getenv("PADDLE_OCR_BATCH_SIZE", "8"))))) if callable(predict) else [model(path) for path in valid_paths]
            output_items = output if isinstance(output, (list, tuple)) else [output]
            if len(output_items) != len(valid_paths):
                raise PaddleThaiOcrUnavailableError("Batch OCR output length mismatch.")
            valid_results = [_result_from_output(item) for item in output_items]
        except Exception:
            valid_results = []
            for path in valid_paths:
                output = predict(input=path, batch_size=1) if callable(predict) else model(path)
                valid_results.append(_result_from_output(output))

        results: List[Dict[str, Any]] = []
        result_index = 0
        for path in temp_paths:
            if not path:
                results.append(
                    {
                        "text": "",
                        "confidence": 0.0,
                        "engine": "paddle_thai_ocr",
                        "model": PADDLE_THAI_OCR_MODEL_NAME,
                        "error": "empty_image",
                    }
                )
            else:
                results.append(valid_results[result_index])
                result_index += 1
        return results
    except PaddleThaiOcrUnavailableError:
        raise
    except Exception as error:
        raise PaddleThaiOcrUnavailableError(f"Paddle Thai OCR batch inference failed: {error}") from error
    finally:
        for image_path in temp_paths:
            if image_path:
                try:
                    os.unlink(image_path)
                except OSError:
                    pass
