from pathlib import Path
from typing import Any, Dict


class OcrUnavailableError(RuntimeError):
    pass


_reader = None


def _load_reader():
    global _reader
    if _reader is not None:
        return _reader
    try:
        import easyocr
    except ImportError as error:
        raise OcrUnavailableError("EasyOCR is not available. Install the 'easyocr' package.") from error

    _reader = easyocr.Reader(["th", "en"], gpu=False)
    return _reader


def _load_image():
    try:
        import numpy as np
        from PIL import Image
    except ImportError as error:
        raise OcrUnavailableError("OCR verification requires Pillow and numpy.") from error
    return Image, np


def ocr_roi(image_path: str, roi: Dict[str, Any]) -> Dict[str, Any]:
    Image, np = _load_image()
    path = Path(image_path)
    if not path.exists():
        raise ValueError(f"Verification image not found: {image_path}")

    image = Image.open(path).convert("RGB")
    image_width, image_height = image.size
    x_ratio = float(roi.get("x_ratio", 0) or 0)
    y_ratio = float(roi.get("y_ratio", 0) or 0)
    width_ratio = float(roi.get("width_ratio", 0) or 0)
    height_ratio = float(roi.get("height_ratio", 0) or 0)

    x = max(0, min(image_width - 1, int(round(x_ratio * image_width))))
    y = max(0, min(image_height - 1, int(round(y_ratio * image_height))))
    width = max(1, int(round(width_ratio * image_width)))
    height = max(1, int(round(height_ratio * image_height)))
    right = min(image_width, x + width)
    bottom = min(image_height, y + height)
    if right <= x or bottom <= y:
        raise ValueError("ROI crop is outside the image bounds")

    crop = image.crop((x, y, right, bottom))
    reader = _load_reader()
    results = reader.readtext(np.array(crop))
    if not results:
        return {
            "text": "",
            "confidence": 0.0,
        }

    texts = [str(result[1]) for result in results if len(result) >= 2]
    confidences = [float(result[2]) for result in results if len(result) >= 3]
    confidence = sum(confidences) / len(confidences) if confidences else 0.0
    return {
        "text": " ".join(texts).strip(),
        "confidence": round(float(confidence), 4),
    }
