from pathlib import Path
from typing import Any, Dict, List

import cv2

from .layout_analysis_service import LayoutAnalysisUnavailableError, detect_text_boxes
from .paddle_thai_ocr_adapter import PaddleThaiOcrUnavailableError, run_paddle_thai_ocr, run_paddle_thai_ocr_batch
from .table_recognition_v2_adapter import TableRecognitionV2UnavailableError, recognize_table_v2


class OcrUnavailableError(RuntimeError):
    pass


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
    try:
        bgr_crop = cv2.cvtColor(np.array(crop), cv2.COLOR_RGB2BGR)
        result = run_paddle_thai_ocr(bgr_crop)
    except PaddleThaiOcrUnavailableError as error:
        raise OcrUnavailableError(str(error)) from error

    return {
        "text": str(result.get("text") or ""),
        "confidence": round(float(result.get("confidence") or 0.0), 4),
        "preprocessing": result.get("preprocessing") or "paddle_text_recognition",
        "segments": result.get("segments") or [],
        "engine": result.get("engine") or "paddle_thai_ocr",
        "model": result.get("model"),
    }


def _crop_roi_from_image(image, roi: Dict[str, Any]):
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
    return image.crop((x, y, right, bottom))


def _is_table_item(item: Dict[str, Any]) -> bool:
    data_type = str(item.get("data_type") or item.get("dataType") or "").lower()
    extraction_method = str(item.get("extraction_method") or item.get("extractionMethod") or "").lower()
    return data_type == "table" or extraction_method in {"table_recognition_v2", "ocr_table"}


def ocr_rois(image_path: str, roi_items: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    if not roi_items:
        return {}

    Image, np = _load_image()
    path = Path(image_path)
    if not path.exists():
        raise ValueError(f"Verification image not found: {image_path}")

    image = Image.open(path).convert("RGB")
    crops = []
    keys = []
    failed: Dict[str, Dict[str, Any]] = {}
    for index, item in enumerate(roi_items):
        key = str(item.get("id") or item.get("field_id") or index)
        try:
            crop = _crop_roi_from_image(image, item.get("roi") or item)
            bgr_crop = cv2.cvtColor(np.array(crop), cv2.COLOR_RGB2BGR)
            if _is_table_item(item):
                table_result = recognize_table_v2(bgr_crop)
                results_text = str(table_result.get("text") or "")
                failed[key] = {
                    "text": results_text,
                    "confidence": round(float(table_result.get("confidence") or 0.0), 4),
                    "preprocessing": table_result.get("preprocessing") or "paddle_table_structure_recognition",
                    "segments": table_result.get("segments") or [],
                    "engine": table_result.get("engine") or "table_recognition_v2",
                    "model": table_result.get("model"),
                    "table_html": table_result.get("table_html"),
                    "table_rows": table_result.get("table_rows"),
                    "table_debug": table_result.get("table_debug"),
                    "error": table_result.get("error"),
                }
            else:
                crops.append(bgr_crop)
                keys.append(key)
        except TableRecognitionV2UnavailableError as error:
            failed[key] = {
                "text": "",
                "confidence": 0.0,
                "preprocessing": "paddle_table_structure_recognition",
                "segments": [],
                "engine": "table_recognition_v2",
                "model": None,
                "error": str(error),
            }
        except Exception as error:
            failed[key] = {
                "text": "",
                "confidence": 0.0,
                "preprocessing": "paddle_text_recognition",
                "segments": [],
                "engine": "paddle_thai_ocr",
                "model": None,
                "error": str(error),
            }

    results: Dict[str, Dict[str, Any]] = dict(failed)
    if not crops:
        return results

    try:
        batch_results = run_paddle_thai_ocr_batch(crops)
    except PaddleThaiOcrUnavailableError as error:
        raise OcrUnavailableError(str(error)) from error

    for key, result in zip(keys, batch_results):
        results[key] = {
            "text": str(result.get("text") or ""),
            "confidence": round(float(result.get("confidence") or 0.0), 4),
            "preprocessing": result.get("preprocessing") or "paddle_text_recognition",
            "segments": result.get("segments") or [],
            "engine": result.get("engine") or "paddle_thai_ocr",
            "model": result.get("model"),
            "error": result.get("error"),
        }
    return results


def ocr_text_regions(image_path: str) -> Dict[str, Any]:
    path = Path(image_path)
    if not path.exists():
        raise ValueError(f"OCR image not found: {image_path}")

    image = cv2.imread(str(path))
    if image is None or image.size == 0:
        raise ValueError(f"OCR image not readable: {image_path}")

    try:
        detection = detect_text_boxes(str(path))
    except (LayoutAnalysisUnavailableError, RuntimeError) as error:
        raise OcrUnavailableError(str(error)) from error

    image_width = int(detection.get("image_width") or image.shape[1])
    image_height = int(detection.get("image_height") or image.shape[0])

    regions: List[Dict[str, Any]] = []
    for region in detection.get("regions", []):
        bbox = region.get("bbox") or {}
        x = max(0, int(float(bbox.get("x") or 0)))
        y = max(0, int(float(bbox.get("y") or 0)))
        width = max(1, int(float(bbox.get("width") or 1)))
        height = max(1, int(float(bbox.get("height") or 1)))
        crop = image[y : min(image.shape[0], y + height), x : min(image.shape[1], x + width)]
        if crop.size == 0:
            continue
        try:
            recognized = run_paddle_thai_ocr(crop)
        except PaddleThaiOcrUnavailableError as error:
            raise OcrUnavailableError(str(error)) from error
        text = str(recognized.get("text") or "").strip()
        confidence = float(recognized.get("confidence") or region.get("confidence") or 0.0)
        regions.append(
            {
                "text": text,
                "confidence": round(confidence, 4),
                "bbox": {
                    "x": round(float(x), 4),
                    "y": round(float(y), 4),
                    "width": round(float(width), 4),
                    "height": round(float(height), 4),
                },
                "center": {
                    "x": round(float(x) + float(width) / 2, 4),
                    "y": round(float(y) + float(height) / 2, 4),
                },
                "engine": recognized.get("engine") or "paddle_thai_ocr",
                "model": recognized.get("model"),
            }
        )

    return {
        "engine": "paddleocr",
        "model": detection.get("model"),
        "image_width": image_width,
        "image_height": image_height,
        "regions": regions,
    }
