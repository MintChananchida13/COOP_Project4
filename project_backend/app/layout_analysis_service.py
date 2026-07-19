import tempfile
from dataclasses import dataclass
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
_PADDLEX_CACHE_HOME = _BACKEND_ROOT / "storage" / "paddlex_cache"
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(_PADDLEX_CACHE_HOME))
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "False")
os.environ.setdefault("PADDLE_PDX_USE_PIR_TRT", "False")
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("FLAGS_json_format_model", "False")


class LayoutAnalysisUnavailableError(RuntimeError):
    pass


@dataclass
class LayoutRegion:
    region_type: str
    x_ratio: float
    y_ratio: float
    width_ratio: float
    height_ratio: float
    confidence: float = 0.0


_LAYOUT_MODEL: Any = None
_TEXT_DETECTOR: Any = None
_LAYOUT_MODEL_NAME = "PP-DocLayoutV3"
_TEXT_DETECTION_MODEL_NAME = "PP-OCRv5_server_det"


def _common_model_kwargs() -> Dict[str, Any]:
    return {
        "device": "cpu",
        "enable_mkldnn": False,
        "enable_cinn": False,
        "use_tensorrt": False,
    }


def _load_layout_model() -> Any:
    global _LAYOUT_MODEL
    if _LAYOUT_MODEL is not None:
        return _LAYOUT_MODEL

    try:
        from paddleocr import LayoutDetection  # type: ignore
    except ImportError as import_error:
        raise LayoutAnalysisUnavailableError(
            "PaddleOCR layout detection requires paddleocr 3.x with LayoutDetection installed."
        ) from import_error

    try:
        _LAYOUT_MODEL = LayoutDetection(
            model_name=_LAYOUT_MODEL_NAME,
            **_common_model_kwargs(),
        )
        return _LAYOUT_MODEL
    except Exception as init_error:
        raise LayoutAnalysisUnavailableError(
            f"Failed to initialize PaddleOCR {_LAYOUT_MODEL_NAME}: {init_error}"
        ) from init_error


def _load_text_detector() -> Any:
    global _TEXT_DETECTOR
    if _TEXT_DETECTOR is not None:
        return _TEXT_DETECTOR

    try:
        from paddleocr import TextDetection  # type: ignore
    except ImportError as import_error:
        raise LayoutAnalysisUnavailableError(
            "PaddleOCR text detection requires paddleocr 3.x with TextDetection installed."
        ) from import_error

    try:
        _TEXT_DETECTOR = TextDetection(
            model_name=_TEXT_DETECTION_MODEL_NAME,
            **_common_model_kwargs(),
        )
        return _TEXT_DETECTOR
    except Exception as init_error:
        raise LayoutAnalysisUnavailableError(
            f"Failed to initialize PaddleOCR {_TEXT_DETECTION_MODEL_NAME}: {init_error}"
        ) from init_error


def _clamp_ratio(value: float) -> float:
    return min(1.0, max(0.0, float(value)))


def _normalize_region_type(value: Any) -> str:
    label = str(value or "text").lower()
    if "table" in label and "title" not in label and "caption" not in label:
        return "table"
    if any(token in label for token in ("image", "figure", "pic", "seal", "logo", "chart")):
        return "image"
    return "text"


def _box_from_points(points: Any) -> Optional[List[float]]:
    if points is None:
        return None
    if isinstance(points, np.ndarray):
        points = points.tolist()
    if isinstance(points, (list, tuple)) and len(points) == 0:
        return None
    if isinstance(points, (list, tuple)) and len(points) == 4 and all(isinstance(item, (int, float)) for item in points):
        x1, y1, x2, y2 = [float(item) for item in points]
        return [x1, y1, x2, y2]
    if isinstance(points, (list, tuple)):
        xs: List[float] = []
        ys: List[float] = []
        for point in points:
            if isinstance(point, (list, tuple)) and len(point) >= 2:
                try:
                    xs.append(float(point[0]))
                    ys.append(float(point[1]))
                except (TypeError, ValueError):
                    continue
        if xs and ys:
            return [min(xs), min(ys), max(xs), max(ys)]
    return None


def _extract_box(item: Dict[str, Any]) -> Optional[List[float]]:
    for key in ("bbox", "box", "layout_bbox", "coordinate", "coordinates", "dt_polys", "poly", "points"):
        if key in item:
            box = _box_from_points(item.get(key))
            if box:
                return box

    if all(key in item for key in ("x", "y", "width", "height")):
        try:
            x = float(item["x"])
            y = float(item["y"])
            return [x, y, x + float(item["width"]), y + float(item["height"])]
        except (TypeError, ValueError):
            return None
    return None


def _extract_label(item: Dict[str, Any]) -> str:
    for key in ("type", "label", "category", "layout_type", "block_type", "region_type"):
        if item.get(key):
            return str(item[key])
    return "text"


def _extract_score(item: Dict[str, Any]) -> float:
    for key in ("score", "confidence", "prob"):
        value = item.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return 0.0


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


def _walk_layout_items(value: Any) -> List[Dict[str, Any]]:
    found: List[Dict[str, Any]] = []
    item_dict = _as_dict(value)
    if item_dict is not None:
        if _extract_box(item_dict):
            found.append(item_dict)
        for child in item_dict.values():
            found.extend(_walk_layout_items(child))
        return found
    if isinstance(value, (list, tuple)):
        for child in value:
            found.extend(_walk_layout_items(child))
    return found


def _run_layout_detection(image_path: str) -> List[Dict[str, Any]]:
    pipeline = _load_layout_model()
    predict = getattr(pipeline, "predict", None)
    result = predict(input=image_path, batch_size=1) if callable(predict) else pipeline(image_path)
    items = _walk_layout_items(result)
    return [
        item
        for item in items
        if _normalize_region_type(_extract_label(item)) in {"table", "image"}
    ]


def _run_text_detection(image_path: str) -> List[Dict[str, Any]]:
    detector = _load_text_detector()
    predict = getattr(detector, "predict", None)
    result = predict(input=image_path, batch_size=1) if callable(predict) else detector(image_path)
    text_items: List[Dict[str, Any]] = []
    for item in result if isinstance(result, (list, tuple)) else [result]:
        item_dict = _as_dict(item) or {}
        data = item_dict.get("res") if isinstance(item_dict.get("res"), dict) else item_dict
        polygons = data.get("dt_polys") if isinstance(data, dict) else None
        scores = data.get("dt_scores") if isinstance(data, dict) else None
        if isinstance(polygons, np.ndarray):
            polygons = polygons.tolist()
        if isinstance(scores, np.ndarray):
            scores = scores.tolist()
        if not isinstance(polygons, (list, tuple)):
            continue
        for index, polygon in enumerate(polygons):
            score = 0.0
            if isinstance(scores, (list, tuple)) and index < len(scores):
                try:
                    score = float(scores[index])
                except (TypeError, ValueError):
                    score = 0.0
            text_items.append(
                {
                    "label": "text",
                    "dt_polys": polygon,
                    "score": score,
                    "source": "text_detection",
                }
            )
    return text_items


def _run_pipeline(image: np.ndarray, image_path: str) -> List[Dict[str, Any]]:
    return [*_run_text_detection(image_path), *_run_layout_detection(image_path)]


def _intersection_area(box_a: List[float], box_b: List[float]) -> float:
    left = max(min(box_a[0], box_a[2]), min(box_b[0], box_b[2]))
    top = max(min(box_a[1], box_a[3]), min(box_b[1], box_b[3]))
    right = min(max(box_a[0], box_a[2]), max(box_b[0], box_b[2]))
    bottom = min(max(box_a[1], box_a[3]), max(box_b[1], box_b[3]))
    return max(0.0, right - left) * max(0.0, bottom - top)


def _box_area(box: List[float]) -> float:
    return max(0.0, abs(float(box[2]) - float(box[0]))) * max(0.0, abs(float(box[3]) - float(box[1])))


def _box_center_inside(inner_box: List[float], outer_box: List[float]) -> bool:
    cx = (float(inner_box[0]) + float(inner_box[2])) / 2
    cy = (float(inner_box[1]) + float(inner_box[3])) / 2
    left = min(float(outer_box[0]), float(outer_box[2]))
    right = max(float(outer_box[0]), float(outer_box[2]))
    top = min(float(outer_box[1]), float(outer_box[3]))
    bottom = max(float(outer_box[1]), float(outer_box[3]))
    return left <= cx <= right and top <= cy <= bottom


def _text_box_belongs_to_table(text_box: List[float], table_boxes: List[List[float]]) -> bool:
    text_area = max(_box_area(text_box), 1.0)
    for table_box in table_boxes:
        if _box_center_inside(text_box, table_box):
            return True
        if _intersection_area(text_box, table_box) / text_area >= 0.25:
            return True
    return False


def analyze_layout(image: np.ndarray) -> Dict[str, Any]:
    if image is None or image.size == 0:
        raise ValueError("Invalid image for layout analysis.")

    height, width = image.shape[:2]
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp_file:
        temp_path = temp_file.name
    try:
        cv2.imwrite(temp_path, image)
        raw_items = _run_pipeline(image, temp_path)
    finally:
        Path(temp_path).unlink(missing_ok=True)

    parsed_items: List[Dict[str, Any]] = []
    for item in raw_items:
        box = _extract_box(item)
        if not box:
            continue
        region_type = _normalize_region_type(_extract_label(item))
        parsed_items.append(
            {
                "box": box,
                "type": region_type,
                "confidence": _extract_score(item),
            }
        )

    table_boxes = [item["box"] for item in parsed_items if item["type"] == "table"]

    regions: List[LayoutRegion] = []
    for item in parsed_items:
        box = item["box"]
        region_type = item["type"]
        if region_type == "text" and _text_box_belongs_to_table(box, table_boxes):
            continue

        x1, y1, x2, y2 = box
        left = max(0.0, min(float(width), min(x1, x2)))
        top = max(0.0, min(float(height), min(y1, y2)))
        right = max(0.0, min(float(width), max(x1, x2)))
        bottom = max(0.0, min(float(height), max(y1, y2)))
        box_width = right - left
        box_height = bottom - top
        if box_width < 4 or box_height < 4:
            continue

        regions.append(
            LayoutRegion(
                region_type=region_type,
                x_ratio=_clamp_ratio(left / max(width, 1)),
                y_ratio=_clamp_ratio(top / max(height, 1)),
                width_ratio=_clamp_ratio(box_width / max(width, 1)),
                height_ratio=_clamp_ratio(box_height / max(height, 1)),
                confidence=float(item["confidence"]),
            )
        )

    regions.sort(key=lambda region: (region.y_ratio, region.x_ratio, -region.width_ratio * region.height_ratio))

    return {
        "engine": "paddleocr",
        "model": f"{_LAYOUT_MODEL_NAME}+{_TEXT_DETECTION_MODEL_NAME}",
        "image_width": width,
        "image_height": height,
        "regions": [
            {
                "type": region.region_type,
                "confidence": region.confidence,
                "roi": {
                    "x_ratio": region.x_ratio,
                    "y_ratio": region.y_ratio,
                    "width_ratio": region.width_ratio,
                    "height_ratio": region.height_ratio,
                },
            }
            for region in regions
        ],
    }


def detect_text_boxes(image_path: str) -> Dict[str, Any]:
    image = cv2.imread(image_path)
    if image is None or image.size == 0:
        raise ValueError("Invalid image for text box detection.")

    height, width = image.shape[:2]
    raw_items = _run_text_detection(image_path)
    regions: List[Dict[str, Any]] = []
    for item in raw_items:
        box = _extract_box(item)
        if not box:
            continue
        x1, y1, x2, y2 = box
        left = max(0.0, min(float(width), min(float(x1), float(x2))))
        top = max(0.0, min(float(height), min(float(y1), float(y2))))
        right = max(0.0, min(float(width), max(float(x1), float(x2))))
        bottom = max(0.0, min(float(height), max(float(y1), float(y2))))
        box_width = right - left
        box_height = bottom - top
        if box_width < 2 or box_height < 2:
            continue
        regions.append(
            {
                "text": "",
                "confidence": _extract_score(item),
                "bbox": {
                    "x": left,
                    "y": top,
                    "width": box_width,
                    "height": box_height,
                },
                "roi": {
                    "x_ratio": _clamp_ratio(left / max(width, 1)),
                    "y_ratio": _clamp_ratio(top / max(height, 1)),
                    "width_ratio": _clamp_ratio(box_width / max(width, 1)),
                    "height_ratio": _clamp_ratio(box_height / max(height, 1)),
                },
            }
        )

    return {
        "engine": "paddleocr",
        "model": _TEXT_DETECTION_MODEL_NAME,
        "image_width": width,
        "image_height": height,
        "regions": regions,
    }
