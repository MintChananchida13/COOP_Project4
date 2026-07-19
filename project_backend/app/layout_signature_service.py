import json
import math
from collections import Counter, defaultdict
from typing import Any, Dict, List, Sequence


LABELS = ("text", "table", "image")
GRID_SIZE = 4


def _clamp(value: float, lower: float = 0.0, upper: float = 1.0) -> float:
    return max(lower, min(upper, float(value)))


def _roi_area(roi: Dict[str, Any]) -> float:
    return _clamp(float(roi.get("width_ratio") or 0.0)) * _clamp(float(roi.get("height_ratio") or 0.0))


def _normalize_label(value: Any) -> str:
    label = str(value or "text").lower()
    if label not in LABELS:
        return "text"
    return label


def _region_from_layout(item: Dict[str, Any]) -> Dict[str, Any] | None:
    roi = item.get("roi") or {}
    try:
        x = _clamp(float(roi.get("x_ratio")))
        y = _clamp(float(roi.get("y_ratio")))
        width = _clamp(float(roi.get("width_ratio")))
        height = _clamp(float(roi.get("height_ratio")))
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    area = _clamp(width * height)
    return {
        "label": _normalize_label(item.get("type") or item.get("label")),
        "bbox": {
            "x_ratio": round(x, 6),
            "y_ratio": round(y, 6),
            "width_ratio": round(width, 6),
            "height_ratio": round(height, 6),
        },
        "center": [round(x + width / 2, 6), round(y + height / 2, 6)],
        "area_ratio": round(area, 6),
        "confidence": round(float(item.get("confidence") or 0.0), 4),
    }


def build_layout_signature(layout_analysis: Dict[str, Any]) -> Dict[str, Any]:
    width = max(float(layout_analysis.get("image_width") or 1), 1.0)
    height = max(float(layout_analysis.get("image_height") or 1), 1.0)
    regions = [
        region
        for region in (_region_from_layout(item) for item in layout_analysis.get("regions", []))
        if region is not None
    ]
    regions.sort(key=lambda item: (item["label"], item["center"][1], item["center"][0]))

    label_counts = Counter(region["label"] for region in regions)
    area_by_label: Dict[str, float] = defaultdict(float)
    grid_counts = {label: [0 for _ in range(GRID_SIZE * GRID_SIZE)] for label in LABELS}
    grid_area = {label: [0.0 for _ in range(GRID_SIZE * GRID_SIZE)] for label in LABELS}

    for region in regions:
        label = region["label"]
        area = float(region["area_ratio"])
        area_by_label[label] += area
        cx, cy = region["center"]
        gx = min(GRID_SIZE - 1, max(0, int(float(cx) * GRID_SIZE)))
        gy = min(GRID_SIZE - 1, max(0, int(float(cy) * GRID_SIZE)))
        cell = gy * GRID_SIZE + gx
        grid_counts[label][cell] += 1
        grid_area[label][cell] += area

    return {
        "version": "layout-signature-v1",
        "engine": layout_analysis.get("engine") or "paddleocr",
        "model": layout_analysis.get("model") or "PP-DocLayoutV3",
        "page_aspect_ratio": round(width / height, 6),
        "image_width": int(width),
        "image_height": int(height),
        "region_count": len(regions),
        "labels": list(LABELS),
        "label_counts": {label: int(label_counts.get(label, 0)) for label in LABELS},
        "area_by_label": {label: round(_clamp(area_by_label.get(label, 0.0)), 6) for label in LABELS},
        "grid_size": GRID_SIZE,
        "grid_counts": grid_counts,
        "grid_area": {
            label: [round(_clamp(value), 6) for value in values]
            for label, values in grid_area.items()
        },
        "regions": regions,
    }


def signature_to_json(signature: Dict[str, Any]) -> str:
    return json.dumps(signature, ensure_ascii=False, sort_keys=True)


def signature_from_json(value: str | None) -> Dict[str, Any] | None:
    if not value:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _count_similarity(left: int, right: int) -> float:
    if left == 0 and right == 0:
        return 1.0
    return min(left, right) / max(left, right, 1)


def _ratio_similarity(left: float, right: float) -> float:
    if left <= 0 and right <= 0:
        return 1.0
    if max(abs(left), abs(right)) == 0:
        return 0.0
    return _clamp(1.0 - (abs(left - right) / max(abs(left), abs(right), 1e-6)))


def _vector_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    if not left and not right:
        return 1.0
    length = min(len(left), len(right))
    if length == 0:
        return 0.0
    dot = sum(float(left[i]) * float(right[i]) for i in range(length))
    left_norm = math.sqrt(sum(float(value) * float(value) for value in left[:length]))
    right_norm = math.sqrt(sum(float(value) * float(value) for value in right[:length]))
    if left_norm == 0 and right_norm == 0:
        return 1.0
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return _clamp(dot / (left_norm * right_norm))


def _bbox_similarity(query_region: Dict[str, Any], template_region: Dict[str, Any]) -> float:
    q = query_region.get("bbox") or {}
    t = template_region.get("bbox") or {}
    qx = float(q.get("x_ratio") or 0.0)
    qy = float(q.get("y_ratio") or 0.0)
    qw = float(q.get("width_ratio") or 0.0)
    qh = float(q.get("height_ratio") or 0.0)
    tx = float(t.get("x_ratio") or 0.0)
    ty = float(t.get("y_ratio") or 0.0)
    tw = float(t.get("width_ratio") or 0.0)
    th = float(t.get("height_ratio") or 0.0)
    center_distance = math.sqrt(((qx + qw / 2) - (tx + tw / 2)) ** 2 + ((qy + qh / 2) - (ty + th / 2)) ** 2)
    position_score = _clamp(1.0 - center_distance / 0.75)
    size_score = (_ratio_similarity(qw, tw) + _ratio_similarity(qh, th)) / 2
    area_score = _ratio_similarity(qw * qh, tw * th)
    return _clamp((position_score * 0.50) + (size_score * 0.30) + (area_score * 0.20))


def _spatial_similarity(query: Dict[str, Any], template: Dict[str, Any]) -> float:
    scores: List[float] = []
    for label in LABELS:
        query_regions = [item for item in query.get("regions", []) if item.get("label") == label]
        template_regions = [item for item in template.get("regions", []) if item.get("label") == label]
        if not query_regions and not template_regions:
            scores.append(1.0)
            continue
        if not query_regions or not template_regions:
            scores.append(0.0)
            continue
        used: set[int] = set()
        label_scores = []
        for q_region in query_regions[:20]:
            candidates = [
                (index, _bbox_similarity(q_region, t_region))
                for index, t_region in enumerate(template_regions[:20])
                if index not in used
            ]
            if not candidates:
                break
            best_index, best_score = max(candidates, key=lambda item: item[1])
            used.add(best_index)
            label_scores.append(best_score)
        matched_score = sum(label_scores) / max(len(query_regions), len(template_regions), 1)
        scores.append(_clamp(matched_score))
    return sum(scores) / len(scores)


def compare_layout_signatures(query: Dict[str, Any], template: Dict[str, Any]) -> Dict[str, Any]:
    aspect_score = _ratio_similarity(
        float(query.get("page_aspect_ratio") or 0.0),
        float(template.get("page_aspect_ratio") or 0.0),
    )

    count_scores = []
    area_scores = []
    grid_scores = []
    for label in LABELS:
        count_scores.append(
            _count_similarity(
                int((query.get("label_counts") or {}).get(label, 0)),
                int((template.get("label_counts") or {}).get(label, 0)),
            )
        )
        area_scores.append(
            _ratio_similarity(
                float((query.get("area_by_label") or {}).get(label, 0.0)),
                float((template.get("area_by_label") or {}).get(label, 0.0)),
            )
        )
        grid_scores.append(
            _vector_similarity(
                (query.get("grid_area") or {}).get(label, []),
                (template.get("grid_area") or {}).get(label, []),
            )
        )

    label_count_score = sum(count_scores) / len(count_scores)
    area_distribution_score = sum(area_scores) / len(area_scores)
    grid_score = sum(grid_scores) / len(grid_scores)
    spatial_score = _spatial_similarity(query, template)
    final_score = _clamp(
        (aspect_score * 0.15)
        + (label_count_score * 0.20)
        + (area_distribution_score * 0.20)
        + (grid_score * 0.20)
        + (spatial_score * 0.25)
    )
    return {
        "score": round(final_score, 4),
        "aspect_score": round(aspect_score, 4),
        "label_count_score": round(label_count_score, 4),
        "area_distribution_score": round(area_distribution_score, 4),
        "grid_score": round(grid_score, 4),
        "spatial_score": round(spatial_score, 4),
        "query_region_count": int(query.get("region_count") or 0),
        "template_region_count": int(template.get("region_count") or 0),
    }
