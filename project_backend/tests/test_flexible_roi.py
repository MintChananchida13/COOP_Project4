import unittest
import importlib.util
import sys
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

FASTAPI_AVAILABLE = importlib.util.find_spec("fastapi") is not None
if FASTAPI_AVAILABLE:
    from main import _paragraph_regions_from_text_lines, process_flexible_text_roi


@unittest.skipUnless(FASTAPI_AVAILABLE, "fastapi is not installed in this Python environment")
class FlexibleRoiTests(unittest.TestCase):
    def test_flexible_roi_uses_layout_blocks_in_reading_order(self):
        image = np.zeros((100, 100, 3), dtype=np.uint8)
        regions = [
            {
                "type": "text",
                "roi": {"x_ratio": 0.1, "y_ratio": 0.5, "width_ratio": 0.4, "height_ratio": 0.1},
            },
            {
                "type": "text",
                "roi": {"x_ratio": 0.1, "y_ratio": 0.1, "width_ratio": 0.4, "height_ratio": 0.1},
            },
            {
                "type": "table",
                "roi": {"x_ratio": 0.1, "y_ratio": 0.3, "width_ratio": 0.4, "height_ratio": 0.1},
            },
        ]

        with patch("main.analyze_layout", return_value={"regions": regions}) as analyze_mock, patch(
            "main.detect_text_boxes",
            return_value={"regions": []},
        ), patch(
            "main.process_table_roi_v2_with_fallback",
            return_value={"text": "", "confidence": 0.0, "segments": []},
        ), patch(
            "main.recognize_text_crop_with_detection",
            side_effect=[
                {"text": "first", "confidence": 0.9, "segments": []},
                {"text": "second", "confidence": 0.8, "segments": []},
            ],
        ) as ocr_mock:
            result = process_flexible_text_roi(image)

        analyze_mock.assert_called_once()
        self.assertEqual(ocr_mock.call_count, 2)
        self.assertEqual(result["text"], "first\nsecond")
        self.assertEqual(result["engine"], "flexible_roi_text")
        self.assertEqual(result["attempts"][0]["block_count"], 3)
        self.assertEqual(result["attempts"][0]["recognized_count"], 3)

    def test_paragraph_geometry_merges_when_break_evidence_is_weak(self):
        lines = [
            {"roi": {"x_ratio": 0.10, "y_ratio": 0.10, "width_ratio": 0.50, "height_ratio": 0.05}},
            {"roi": {"x_ratio": 0.11, "y_ratio": 0.16, "width_ratio": 0.48, "height_ratio": 0.05}},
            {"roi": {"x_ratio": 0.10, "y_ratio": 0.22, "width_ratio": 0.49, "height_ratio": 0.05}},
        ]

        paragraphs = _paragraph_regions_from_text_lines(lines)

        self.assertEqual(len(paragraphs), 1)
        self.assertEqual(paragraphs[0]["line_count"], 3)

    def test_paragraph_geometry_splits_on_adaptive_gap_and_alignment(self):
        lines = [
            {"roi": {"x_ratio": 0.10, "y_ratio": 0.10, "width_ratio": 0.50, "height_ratio": 0.05}},
            {"roi": {"x_ratio": 0.11, "y_ratio": 0.16, "width_ratio": 0.48, "height_ratio": 0.05}},
            {"roi": {"x_ratio": 0.30, "y_ratio": 0.36, "width_ratio": 0.35, "height_ratio": 0.05}},
            {"roi": {"x_ratio": 0.31, "y_ratio": 0.42, "width_ratio": 0.34, "height_ratio": 0.05}},
        ]

        paragraphs = _paragraph_regions_from_text_lines(lines)

        self.assertEqual(len(paragraphs), 2)
        self.assertEqual([paragraph["line_count"] for paragraph in paragraphs], [2, 2])


if __name__ == "__main__":
    unittest.main()
