from pathlib import Path
from typing import Any, Dict, List


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


def _ocr_variants(rgb_array: Any) -> List[Dict[str, Any]]:
    try:
        import cv2
        import numpy as np
    except ImportError:
        return [{"name": "original", "image": rgb_array}]

    bgr = cv2.cvtColor(rgb_array, cv2.COLOR_RGB2BGR)
    padded = cv2.copyMakeBorder(bgr, 15, 15, 15, 15, cv2.BORDER_CONSTANT, value=[255, 255, 255])
    variants = [{"name": "original_padded", "image": cv2.cvtColor(padded, cv2.COLOR_BGR2RGB)}]

    height, width = padded.shape[:2]
    if max(height, width) < 900:
        upscaled = cv2.resize(padded, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        variants.append({"name": "upscaled_2x", "image": cv2.cvtColor(upscaled, cv2.COLOR_BGR2RGB)})

    gray = cv2.cvtColor(padded, cv2.COLOR_BGR2GRAY)
    variants.append({"name": "grayscale", "image": cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB)})

    sharpen_kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]])
    try:
        sharpened = cv2.filter2D(gray, -1, sharpen_kernel)
        variants.append({"name": "sharpened", "image": cv2.cvtColor(sharpened, cv2.COLOR_GRAY2RGB)})
    except cv2.error:
        pass

    try:
        thresholded = cv2.adaptiveThreshold(
            gray,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            31,
            7,
        )
        variants.append({"name": "adaptive_threshold", "image": cv2.cvtColor(thresholded, cv2.COLOR_GRAY2RGB)})
    except cv2.error:
        pass

    return variants


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
    best = {
        "text": "",
        "confidence": 0.0,
        "preprocessing": "none",
        "segments": [],
    }
    for variant in _ocr_variants(np.array(crop)):
        results = reader.readtext(variant["image"])
        texts = [str(result[1]) for result in results if len(result) >= 2]
        confidences = [float(result[2]) for result in results if len(result) >= 3]
        confidence = sum(confidences) / len(confidences) if confidences else 0.0
        text = " ".join(texts).strip()
        segments = [
            {
                "text": str(result[1]),
                "confidence": float(result[2]) if len(result) >= 3 else 0.0,
                "bbox": [[float(point[0]), float(point[1])] for point in result[0]],
            }
            for result in results
            if len(result) >= 2
        ]
        if text and (confidence > float(best["confidence"]) or not best["text"]):
            best = {
                "text": text,
                "confidence": confidence,
                "preprocessing": variant["name"],
                "segments": segments,
            }
    return {
        "text": best["text"],
        "confidence": round(float(best["confidence"]), 4),
        "preprocessing": best["preprocessing"],
        "segments": best["segments"],
    }


def _bbox_from_easyocr_points(points: Any) -> Dict[str, float]:
    xs = [float(point[0]) for point in points if len(point) >= 2]
    ys = [float(point[1]) for point in points if len(point) >= 2]
    if not xs or not ys:
        return {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0}
    left = min(xs)
    top = min(ys)
    right = max(xs)
    bottom = max(ys)
    return {
        "x": round(left, 4),
        "y": round(top, 4),
        "width": round(max(0.0, right - left), 4),
        "height": round(max(0.0, bottom - top), 4),
    }


def ocr_text_regions(image_path: str) -> Dict[str, Any]:
    Image, np = _load_image()
    path = Path(image_path)
    if not path.exists():
        raise ValueError(f"OCR image not found: {image_path}")

    image = Image.open(path).convert("RGB")
    image_width, image_height = image.size
    reader = _load_reader()
    results = reader.readtext(np.array(image))

    regions: List[Dict[str, Any]] = []
    for result in results:
        if len(result) < 2:
            continue
        bbox = _bbox_from_easyocr_points(result[0])
        text = str(result[1] or "").strip()
        confidence = float(result[2]) if len(result) >= 3 else 0.0
        regions.append(
            {
                "text": text,
                "confidence": round(confidence, 4),
                "bbox": bbox,
                "center": {
                    "x": round(bbox["x"] + bbox["width"] / 2, 4),
                    "y": round(bbox["y"] + bbox["height"] / 2, 4),
                },
            }
        )

    return {
        "image_width": image_width,
        "image_height": image_height,
        "regions": regions,
    }
