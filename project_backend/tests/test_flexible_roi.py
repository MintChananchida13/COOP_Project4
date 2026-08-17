import unittest
import sys
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import process_flexible_text_roi


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
        self.assertEqual(result["attempts"][0]["block_count"], 2)
        self.assertEqual(result["attempts"][0]["recognized_count"], 2)


if __name__ == "__main__":
    unittest.main()
