import base64
import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np


class ModelRuntimeUnavailableError(RuntimeError):
    pass


def _runtime_url() -> Optional[str]:
    if os.getenv("MODEL_RUNTIME_ROLE", "").strip().lower() == "service":
        return None
    value = os.getenv("MODEL_SERVICE_URL", "").strip().rstrip("/")
    return value or None


def _image_to_data_url(image: np.ndarray) -> str:
    if image is None or image.size == 0:
        raise ValueError("Invalid image for model runtime request.")
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise ValueError("Unable to encode image for model runtime request.")
    return "data:image/png;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")


def _path_to_data_url(image_path: str) -> str:
    path = Path(image_path)
    if not path.exists():
        raise ValueError(f"Model runtime input image not found: {image_path}")
    suffix = path.suffix.lower().lstrip(".") or "png"
    mime = "jpeg" if suffix in {"jpg", "jpeg"} else suffix
    return f"data:image/{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def _post(endpoint: str, payload: Dict[str, Any], timeout: float = 120.0) -> Dict[str, Any]:
    base_url = _runtime_url()
    if not base_url:
        raise ModelRuntimeUnavailableError("MODEL_SERVICE_URL is not configured.")

    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}{endpoint}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise ModelRuntimeUnavailableError(f"Model runtime HTTP {error.code}: {detail}") from error
    except OSError as error:
        raise ModelRuntimeUnavailableError(f"Model runtime unavailable: {error}") from error

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ModelRuntimeUnavailableError("Model runtime returned invalid JSON.") from error

    if not parsed.get("success", True):
        raise ModelRuntimeUnavailableError(str(parsed.get("detail") or parsed.get("error") or "Model runtime request failed."))
    data = parsed.get("data")
    return data if isinstance(data, dict) else parsed


def remote_analyze_layout(image: np.ndarray, expand_text_rois: bool = False) -> Optional[Dict[str, Any]]:
    if not _runtime_url():
        return None
    return _post(
        "/runtime/layout/analyze",
        {
            "image": _image_to_data_url(image),
            "expand_text_rois": expand_text_rois,
        },
    )


def remote_detect_text_boxes(image_path: str) -> Optional[Dict[str, Any]]:
    if not _runtime_url():
        return None
    return _post("/runtime/text/detect", {"image": _path_to_data_url(image_path)})


def remote_recognize_image(image: np.ndarray) -> Optional[Dict[str, Any]]:
    if not _runtime_url():
        return None
    return _post("/runtime/ocr/recognize", {"image": _image_to_data_url(image)})


def remote_recognize_images(images: List[np.ndarray]) -> Optional[Dict[str, Any]]:
    if not _runtime_url():
        return None
    return _post(
        "/runtime/ocr/recognize-batch",
        {"images": [_image_to_data_url(image) for image in images]},
        timeout=240.0,
    )


def remote_recognize_table(image: np.ndarray) -> Optional[Dict[str, Any]]:
    if not _runtime_url():
        return None
    return _post(
        "/runtime/table/recognize-v2",
        {"image": _image_to_data_url(image)},
        timeout=240.0,
    )


def remote_encode_images(image_paths: List[str]) -> Optional[Dict[str, Any]]:
    if not _runtime_url():
        return None
    return _post(
        "/runtime/vision/encode",
        {"images": [_path_to_data_url(image_path) for image_path in image_paths]},
        timeout=240.0,
    )
