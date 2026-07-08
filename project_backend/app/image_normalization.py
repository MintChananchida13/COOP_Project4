from pathlib import Path
from typing import Any, Dict, Optional

import cv2
import numpy as np


class ImageNormalizationService:
    LONGEST_SIDE = 1024
    DETECTION_HEIGHT = 900
    MIN_CONTOUR_AREA_RATIO = 0.06
    MAX_CONTOUR_AREA_RATIO = 0.98
    MIN_ASPECT_RATIO = 0.20
    MAX_ASPECT_RATIO = 5.0
    MIN_TRANSFORMED_DIMENSION = 80
    MIN_TRANSFORMED_AREA_RATIO = 0.03
    MAX_TRANSFORMED_ASPECT_RATIO = 8.0
    MIN_IMAGE_STDDEV = 3.0

    def normalize_document(self, image_path: str, output_path: Optional[str] = None) -> Dict[str, Any]:
        source_path = Path(image_path)
        if output_path is None:
            output_path = str(source_path.with_name(f"{source_path.stem}_normalized.png"))
        target_path = Path(output_path)
        target_path.parent.mkdir(parents=True, exist_ok=True)

        image = cv2.imread(str(source_path))
        if image is None:
            raise ValueError(f"Unable to read image for normalization: {image_path}")

        original_height, original_width = image.shape[:2]
        # Temporary bypass: keep the normalization contract, but avoid crop/warp
        # until the document boundary algorithm is stable.
        normalized = image.copy()
        normalized_height, normalized_width = normalized.shape[:2]
        debug = {
            "document_detected": False,
            "crop_applied": False,
            "perspective_applied": False,
            "normalization_status": "bypassed",
            "validation_passed": True,
            "fallback_used": True,
            "fallback_reason": "normalization_temporarily_bypassed",
            "original_size": [original_width, original_height],
            "normalized_size": [normalized_width, normalized_height],
            "output_size": [normalized_width, normalized_height],
            "detected_contour_area": None,
            "contour_area_ratio": None,
            "contour_source": None,
            "contour_score": None,
            "contour_aspect_ratio": None,
            "contour_center_score": None,
            "detected_points": None,
            "transform_validation": {
                "passed": True,
                "reason": "normalization_temporarily_bypassed",
                "width": normalized_width,
                "height": normalized_height,
            },
        }

        write_success = bool(cv2.imwrite(str(target_path), normalized))
        decoded_output = cv2.imread(str(target_path)) if write_success else None
        if not write_success or decoded_output is None:
            cv2.imwrite(str(target_path), image)
            debug.update(
                {
                    "normalization_status": "fallback",
                    "validation_passed": False,
                    "fallback_used": True,
                    "fallback_reason": "output_decode_failed",
                }
            )

        return {
            "normalized_image_path": str(target_path),
            "document_detected": debug["document_detected"],
            "crop_applied": debug["crop_applied"],
            "perspective_applied": debug["perspective_applied"],
            "normalization_status": debug["normalization_status"],
            "validation_passed": debug["validation_passed"],
            "fallback_used": debug["fallback_used"],
            "fallback_reason": debug["fallback_reason"],
            "original_size": [original_width, original_height],
            "normalized_size": [normalized_width, normalized_height],
            "output_size": debug["output_size"],
            "resize_policy": "longest_side",
            "longest_side": self.LONGEST_SIDE,
            "normalization_debug": debug,
        }

    def _perspective_correct(self, image: np.ndarray) -> tuple[np.ndarray, Dict[str, Any]]:
        contour_info = self._find_document_contour(image)
        contour = contour_info.get("contour") if contour_info else None
        debug = {
            "document_detected": False,
            "crop_applied": False,
            "perspective_applied": False,
            "normalization_status": "fallback",
            "validation_passed": True,
            "fallback_used": True,
            "fallback_reason": contour_info.get("fallback_reason") if contour_info else "no_document_contour_found",
            "original_size": [image.shape[1], image.shape[0]],
            "detected_contour_area": contour_info.get("area") if contour_info else None,
            "contour_area_ratio": contour_info.get("area_ratio") if contour_info else None,
            "contour_source": contour_info.get("source") if contour_info else None,
            "contour_score": contour_info.get("score") if contour_info else None,
            "contour_aspect_ratio": contour_info.get("aspect_ratio") if contour_info else None,
            "contour_center_score": contour_info.get("center_score") if contour_info else None,
            "detected_points": contour_info.get("points") if contour_info else None,
            "normalized_size": None,
            "output_size": None,
        }
        if contour is None:
            return image.copy(), debug

        ordered = self._order_points(contour.reshape(4, 2).astype("float32"))
        top_left, top_right, bottom_right, bottom_left = ordered
        width_a = np.linalg.norm(bottom_right - bottom_left)
        width_b = np.linalg.norm(top_right - top_left)
        height_a = np.linalg.norm(top_right - bottom_right)
        height_b = np.linalg.norm(top_left - bottom_left)
        max_width = max(1, int(max(width_a, width_b)))
        max_height = max(1, int(max(height_a, height_b)))

        destination = np.array(
            [
                [0, 0],
                [max_width - 1, 0],
                [max_width - 1, max_height - 1],
                [0, max_height - 1],
            ],
            dtype="float32",
        )
        matrix = cv2.getPerspectiveTransform(ordered, destination)
        warped = cv2.warpPerspective(image, matrix, (max_width, max_height))
        validation = self._validate_transformed_image(warped, image)
        if not validation["passed"]:
            debug.update(
                {
                    "validation_passed": False,
                    "fallback_used": True,
                    "fallback_reason": validation["reason"],
                    "normalization_status": "fallback",
                    "transform_validation": validation,
                }
            )
            return image.copy(), debug

        debug.update(
            {
                "document_detected": True,
                "crop_applied": True,
                "perspective_applied": True,
                "normalization_status": "cropped",
                "validation_passed": True,
                "fallback_used": False,
                "fallback_reason": None,
                "detected_points": [[round(float(x), 2), round(float(y), 2)] for x, y in ordered.tolist()],
                "warped_size": [max_width, max_height],
                "transform_validation": validation,
            }
        )
        return warped, debug

    def _find_document_contour(self, image: np.ndarray) -> Dict[str, Any]:
        resized = self._resize_to_height(image, self.DETECTION_HEIGHT)
        ratio = image.shape[0] / float(resized.shape[0])
        gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        contour_masks = []

        threshold = cv2.adaptiveThreshold(
            blurred,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            21,
            7,
        )
        threshold_inv = cv2.bitwise_not(threshold)
        threshold_inv = cv2.morphologyEx(threshold_inv, cv2.MORPH_CLOSE, kernel, iterations=2)
        contour_masks.append(("adaptive_threshold", threshold_inv))

        edges = cv2.Canny(blurred, 40, 140)
        edges = cv2.dilate(edges, kernel, iterations=1)
        edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)
        contour_masks.append(("canny", edges))

        image_area = resized.shape[0] * resized.shape[1]
        image_center = np.array([resized.shape[1] / 2.0, resized.shape[0] / 2.0], dtype="float32")
        max_center_distance = np.linalg.norm(image_center)
        candidates = []
        for source, mask in contour_masks:
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:20]:
                candidate = self._quadrilateral_candidate(contour, image_area, image_center, max_center_distance, source)
                if candidate:
                    candidates.append(candidate)

        if not candidates:
            return {"contour": None, "fallback_reason": "no_document_contour_found"}

        best = max(candidates, key=lambda item: item["score"])
        scaled = (best["points_array"] * ratio).astype("float32").reshape(4, 1, 2)
        return {
            "contour": scaled,
            "area": round(float(best["area"] * (ratio ** 2)), 2),
            "area_ratio": round(float(best["area_ratio"]), 4),
            "points": [[round(float(x * ratio), 2), round(float(y * ratio), 2)] for x, y in best["points"]],
            "source": best["source"],
            "score": round(float(best["score"]), 4),
            "aspect_ratio": round(float(best["aspect_ratio"]), 4),
            "center_score": round(float(best["center_score"]), 4),
            "fallback_reason": None,
        }

    def _quadrilateral_candidate(
        self,
        contour: np.ndarray,
        image_area: int,
        image_center: np.ndarray,
        max_center_distance: float,
        source: str,
    ) -> Optional[Dict[str, Any]]:
        area = cv2.contourArea(contour)
        area_ratio = area / max(1, image_area)
        if area_ratio < self.MIN_CONTOUR_AREA_RATIO or area_ratio > self.MAX_CONTOUR_AREA_RATIO:
            return None

        perimeter = cv2.arcLength(contour, True)
        if perimeter <= 0:
            return None

        approx = None
        for epsilon_ratio in (0.015, 0.02, 0.03, 0.04, 0.06):
            candidate = cv2.approxPolyDP(contour, epsilon_ratio * perimeter, True)
            if len(candidate) == 4:
                approx = candidate
                break
        if approx is None:
            return None

        ordered = self._order_points(approx.reshape(4, 2).astype("float32"))
        top_left, top_right, bottom_right, bottom_left = ordered
        width_a = np.linalg.norm(bottom_right - bottom_left)
        width_b = np.linalg.norm(top_right - top_left)
        height_a = np.linalg.norm(top_right - bottom_right)
        height_b = np.linalg.norm(top_left - bottom_left)
        width = max(width_a, width_b)
        height = max(height_a, height_b)
        if width <= 1 or height <= 1:
            return None

        aspect_ratio = width / height
        if aspect_ratio < self.MIN_ASPECT_RATIO or aspect_ratio > self.MAX_ASPECT_RATIO:
            return None

        contour_center = ordered.mean(axis=0)
        center_distance = np.linalg.norm(contour_center - image_center)
        center_score = 1.0 - min(1.0, center_distance / max(1.0, max_center_distance))
        area_score = min(1.0, area_ratio / 0.75)
        score = (0.65 * area_score) + (0.35 * center_score)

        return {
            "points_array": ordered,
            "points": ordered.tolist(),
            "area": area,
            "area_ratio": area_ratio,
            "aspect_ratio": aspect_ratio,
            "center_score": center_score,
            "source": source,
            "score": score,
        }

    def _validate_transformed_image(self, transformed: Optional[np.ndarray], original: np.ndarray) -> Dict[str, Any]:
        if transformed is None or not isinstance(transformed, np.ndarray):
            return {"passed": False, "reason": "perspective_transform_failed"}
        if transformed.size == 0:
            return {"passed": False, "reason": "perspective_transform_empty"}

        height, width = transformed.shape[:2]
        original_height, original_width = original.shape[:2]
        area_ratio = (width * height) / max(1, original_width * original_height)
        aspect_ratio = width / max(1, height)
        gray = cv2.cvtColor(transformed, cv2.COLOR_BGR2GRAY) if len(transformed.shape) == 3 else transformed
        stddev = float(gray.std())
        validation = {
            "passed": True,
            "reason": None,
            "width": width,
            "height": height,
            "area_ratio": round(float(area_ratio), 4),
            "aspect_ratio": round(float(aspect_ratio), 4),
            "stddev": round(stddev, 4),
        }

        if width < self.MIN_TRANSFORMED_DIMENSION or height < self.MIN_TRANSFORMED_DIMENSION:
            validation.update({"passed": False, "reason": "transformed_image_too_small"})
        elif aspect_ratio > self.MAX_TRANSFORMED_ASPECT_RATIO or aspect_ratio < (1 / self.MAX_TRANSFORMED_ASPECT_RATIO):
            validation.update({"passed": False, "reason": "transformed_aspect_ratio_invalid"})
        elif area_ratio < self.MIN_TRANSFORMED_AREA_RATIO:
            validation.update({"passed": False, "reason": "transformed_area_too_small"})
        elif stddev < self.MIN_IMAGE_STDDEV:
            validation.update({"passed": False, "reason": "transformed_image_nearly_empty"})
        return validation

    def _resize_to_height(self, image: np.ndarray, height: int) -> np.ndarray:
        original_height, original_width = image.shape[:2]
        if original_height <= height:
            return image.copy()
        scale = height / float(original_height)
        width = max(1, int(original_width * scale))
        return cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA)

    def _resize_longest_side(self, image: np.ndarray, longest_side: int) -> np.ndarray:
        height, width = image.shape[:2]
        current_longest = max(width, height)
        if current_longest == 0:
            return image
        scale = longest_side / float(current_longest)
        if scale == 1:
            return image.copy()
        new_width = max(1, int(round(width * scale)))
        new_height = max(1, int(round(height * scale)))
        interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
        return cv2.resize(image, (new_width, new_height), interpolation=interpolation)

    def _order_points(self, points: np.ndarray) -> np.ndarray:
        rect = np.zeros((4, 2), dtype="float32")
        point_sum = points.sum(axis=1)
        point_diff = np.diff(points, axis=1)
        rect[0] = points[np.argmin(point_sum)]
        rect[2] = points[np.argmax(point_sum)]
        rect[1] = points[np.argmin(point_diff)]
        rect[3] = points[np.argmax(point_diff)]
        return rect
