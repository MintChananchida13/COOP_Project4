from __future__ import annotations

import logging
from typing import Any, Dict, List

import cv2
import numpy as np


logger = logging.getLogger(__name__)

_MIN_REGION_HEIGHT_RATIO = 0.12
_MIN_REGION_WIDTH_RATIO = 0.35
_MIN_CONFIDENCE = 0.72


def _clip_region(x: int, y: int, width: int, height: int, image_width: int, image_height: int) -> Dict[str, Any]:
    left = max(0, min(image_width - 1, int(x)))
    top = max(0, min(image_height - 1, int(y)))
    right = max(left + 1, min(image_width, int(x + width)))
    bottom = max(top + 1, min(image_height, int(y + height)))
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


def _line_mask(gray: np.ndarray, orientation: str) -> np.ndarray:
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    height, width = gray.shape[:2]
    if orientation == "horizontal":
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(12, width // 24), 1))
    else:
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(12, height // 24)))
    opened = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel, iterations=1)
    return cv2.dilate(opened, kernel, iterations=1)


def _projected_line_positions(mask: np.ndarray, axis: int, threshold_ratio: float) -> List[int]:
    projection = np.mean(mask > 0, axis=axis)
    positions = [index for index, value in enumerate(projection) if value >= threshold_ratio]
    if not positions:
        return []
    groups: List[List[int]] = []
    for position in positions:
        if not groups or position - groups[-1][-1] > 3:
            groups.append([position])
        else:
            groups[-1].append(position)
    return [int(round(sum(group) / len(group))) for group in groups]


def _vertical_segment_counts(vertical_mask: np.ndarray, bands: List[tuple[int, int]], image_width: int) -> List[int]:
    counts: List[int] = []
    for top, bottom in bands:
        band = vertical_mask[max(0, top):max(top + 1, bottom), :]
        positions = _projected_line_positions(band, axis=0, threshold_ratio=0.18)
        usable = [x for x in positions if 2 <= x <= image_width - 3]
        counts.append(len(usable))
    return counts


def analyze_table_regions(image: np.ndarray) -> Dict[str, Any]:
    if image is None or image.size == 0:
        return {"detected": False, "confidence": 0.0, "regions": [], "reason": "empty_image"}

    try:
        height, width = image.shape[:2]
        if height < 40 or width < 40:
            return {"detected": False, "confidence": 0.0, "regions": [], "reason": "image_too_small"}

        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
        gray = cv2.GaussianBlur(gray, (3, 3), 0)
        horizontal = _line_mask(gray, "horizontal")
        vertical = _line_mask(gray, "vertical")
        horizontal_positions = _projected_line_positions(horizontal, axis=1, threshold_ratio=0.22)
        vertical_positions = _projected_line_positions(vertical, axis=0, threshold_ratio=0.18)

        if len(horizontal_positions) < 4 or len(vertical_positions) < 3:
            return {
                "detected": False,
                "confidence": 0.0,
                "regions": [],
                "reason": "insufficient_grid_lines",
                "line_summary": {"horizontal": len(horizontal_positions), "vertical": len(vertical_positions)},
            }

        boundaries = [0, *horizontal_positions, height]
        bands: List[tuple[int, int]] = []
        for top, bottom in zip(boundaries, boundaries[1:]):
            if bottom - top >= max(24, int(height * _MIN_REGION_HEIGHT_RATIO)):
                bands.append((top, bottom))
        if len(bands) < 2:
            return {
                "detected": False,
                "confidence": 0.0,
                "regions": [],
                "reason": "single_grid_topology",
                "line_summary": {"horizontal": len(horizontal_positions), "vertical": len(vertical_positions)},
            }

        segment_counts = _vertical_segment_counts(vertical, bands, width)
        topology_changes = sum(1 for prev, curr in zip(segment_counts, segment_counts[1:]) if prev != curr)
        distinct_topologies = len(set(segment_counts))
        if topology_changes <= 0 or distinct_topologies < 2:
            return {
                "detected": False,
                "confidence": 0.0,
                "regions": [],
                "reason": "no_topology_change",
                "line_summary": {"horizontal": len(horizontal_positions), "vertical": len(vertical_positions)},
                "segment_counts": segment_counts,
            }

        regions: List[Dict[str, Any]] = []
        current_top, current_bottom = bands[0]
        current_count = segment_counts[0]
        for (top, bottom), count in zip(bands[1:], segment_counts[1:]):
            if count != current_count:
                region_bbox = _clip_region(0, current_top, width, current_bottom - current_top, width, height)
                if region_bbox["height"] >= height * _MIN_REGION_HEIGHT_RATIO and region_bbox["width"] >= width * _MIN_REGION_WIDTH_RATIO:
                    regions.append({"type": "grid" if current_count >= 3 else "merged_block", "bbox": region_bbox, "grid_line_count": current_count})
                current_top = top
                current_count = count
            current_bottom = bottom

        region_bbox = _clip_region(0, current_top, width, current_bottom - current_top, width, height)
        if region_bbox["height"] >= height * _MIN_REGION_HEIGHT_RATIO and region_bbox["width"] >= width * _MIN_REGION_WIDTH_RATIO:
            regions.append({"type": "grid" if current_count >= 3 else "merged_block", "bbox": region_bbox, "grid_line_count": current_count})

        if len(regions) < 2:
            return {
                "detected": False,
                "confidence": 0.0,
                "regions": regions,
                "reason": "region_split_not_confident",
                "line_summary": {"horizontal": len(horizontal_positions), "vertical": len(vertical_positions)},
                "segment_counts": segment_counts,
            }

        line_strength = min(1.0, (len(horizontal_positions) / 8.0) * 0.45 + (len(vertical_positions) / 6.0) * 0.35)
        topology_strength = min(1.0, topology_changes / max(1, len(bands) - 1))
        confidence = round(max(0.0, min(1.0, line_strength + topology_strength * 0.45)), 4)
        detected = confidence >= _MIN_CONFIDENCE
        return {
            "detected": detected,
            "confidence": confidence,
            "regions": regions if detected else [],
            "reason": "topology_change_detected" if detected else "low_confidence",
            "line_summary": {"horizontal": len(horizontal_positions), "vertical": len(vertical_positions)},
            "segment_counts": segment_counts,
        }
    except Exception as error:
        logger.info("Table grid analyzer failed: %s", error)
        return {"detected": False, "confidence": 0.0, "regions": [], "reason": str(error)}
