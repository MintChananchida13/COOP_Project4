import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

from app.layout_analysis_service import LayoutAnalysisUnavailableError, analyze_layout, detect_text_boxes
from app.model_runtime_client import ModelRuntimeUnavailableError


class LayoutAnalysisRemoteRoutingTest(unittest.TestCase):
    def test_analyze_layout_uses_remote_without_local_text_detection(self) -> None:
        image = np.zeros((20, 20, 3), dtype=np.uint8)
        remote_payload = {
            "engine": "remote",
            "model": "runtime",
            "image_width": 20,
            "image_height": 20,
            "regions": [],
        }

        with patch.dict("os.environ", {"MODEL_SERVICE_URL": "https://model.example"}, clear=False), patch(
            "app.layout_analysis_service.remote_analyze_layout",
            return_value=remote_payload,
        ) as remote, patch("app.layout_analysis_service._load_text_detector") as load_text, patch(
            "app.layout_analysis_service._run_text_detection"
        ) as run_text:
            result = analyze_layout(image)

        self.assertEqual(result, remote_payload)
        remote.assert_called_once()
        load_text.assert_not_called()
        run_text.assert_not_called()

    def test_detect_text_boxes_uses_remote_without_local_text_detection(self) -> None:
        image = np.zeros((20, 20, 3), dtype=np.uint8)
        remote_payload = {
            "engine": "remote",
            "model": "runtime-text-det",
            "image_width": 20,
            "image_height": 20,
            "regions": [],
        }

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp_file:
            image_path = temp_file.name
        try:
            cv2.imwrite(image_path, image)
            with patch.dict("os.environ", {"MODEL_SERVICE_URL": "https://model.example"}, clear=False), patch(
                "app.layout_analysis_service.remote_detect_text_boxes",
                return_value=remote_payload,
            ) as remote, patch("app.layout_analysis_service._load_text_detector") as load_text, patch(
                "app.layout_analysis_service._run_text_detection"
            ) as run_text:
                result = detect_text_boxes(image_path)
        finally:
            Path(image_path).unlink(missing_ok=True)

        self.assertEqual(result, remote_payload)
        remote.assert_called_once_with(image_path)
        load_text.assert_not_called()
        run_text.assert_not_called()

    def test_remote_text_detection_error_is_raised_without_local_fallback(self) -> None:
        image = np.zeros((20, 20, 3), dtype=np.uint8)

        with patch.dict("os.environ", {"MODEL_SERVICE_URL": "https://model.example"}, clear=False), patch(
            "app.layout_analysis_service.remote_analyze_layout",
            side_effect=ModelRuntimeUnavailableError("remote text detection failed"),
        ), patch("app.layout_analysis_service._load_text_detector") as load_text, patch(
            "app.layout_analysis_service._run_text_detection"
        ) as run_text:
            with self.assertRaisesRegex(LayoutAnalysisUnavailableError, "remote text detection failed"):
                analyze_layout(image)

        load_text.assert_not_called()
        run_text.assert_not_called()

    def test_remote_text_detection_none_is_clear_error(self) -> None:
        image = np.zeros((20, 20, 3), dtype=np.uint8)

        with patch.dict("os.environ", {"MODEL_SERVICE_URL": "https://model.example"}, clear=False), patch(
            "app.layout_analysis_service.remote_analyze_layout",
            return_value=None,
        ), patch("app.layout_analysis_service._load_text_detector") as load_text:
            with self.assertRaisesRegex(LayoutAnalysisUnavailableError, "Remote TextDetection runtime returned no result."):
                analyze_layout(image)

        load_text.assert_not_called()

    def test_auto_roi_keeps_table_bbox_without_expansion(self) -> None:
        image = np.zeros((100, 200, 3), dtype=np.uint8)
        raw_items = [
            {"bbox": [20, 10, 120, 60], "label": "table", "score": 0.95},
            {"bbox": [150, 20, 170, 30], "label": "text", "score": 0.9},
        ]

        with patch.dict("os.environ", {"MODEL_SERVICE_URL": ""}, clear=False), patch(
            "app.layout_analysis_service._run_pipeline",
            return_value=raw_items,
        ):
            result = analyze_layout(image, expand_text_rois=True, auto_roi_mode="text_line")

        table_region = next(region for region in result["regions"] if region["type"] == "table")
        text_region = next(region for region in result["regions"] if region["type"] == "text")

        self.assertEqual(table_region["roi"]["x_ratio"], 20 / 200)
        self.assertEqual(table_region["roi"]["y_ratio"], 10 / 100)
        self.assertEqual(table_region["roi"]["width_ratio"], 100 / 200)
        self.assertEqual(table_region["roi"]["height_ratio"], 50 / 100)
        self.assertFalse(table_region["roi_expansion"]["enabled"])
        self.assertEqual(table_region["roi_expansion"]["reason"], "table_uses_paddle_bbox")
        self.assertLess(text_region["roi"]["x_ratio"], 150 / 200)


if __name__ == "__main__":
    unittest.main()
