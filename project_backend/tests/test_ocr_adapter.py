import unittest
from unittest.mock import patch

import numpy as np

from app.ocr_adapter import _recognize_text_crops_with_detection


class OcrAdapterTextDetectionTest(unittest.TestCase):
    def test_text_roi_is_detected_then_recognized_by_boxes(self) -> None:
        crop = np.zeros((100, 200, 3), dtype=np.uint8)
        detection = {
            "model": "PP-OCRv5_server_det",
            "regions": [
                {"bbox": {"x": 80, "y": 10, "width": 40, "height": 20}},
                {"bbox": {"x": 10, "y": 10, "width": 50, "height": 20}},
            ],
        }

        with patch("app.ocr_adapter.detect_text_boxes", return_value=detection), patch(
            "app.ocr_adapter.run_paddle_thai_ocr_batch",
            return_value=[
                {"text": "LEFT", "confidence": 0.9, "engine": "paddle_thai_ocr", "model": "th_PP-OCRv5_mobile_rec"},
                {"text": "RIGHT", "confidence": 0.8, "engine": "paddle_thai_ocr", "model": "th_PP-OCRv5_mobile_rec"},
            ],
        ) as recognize_batch:
            result = _recognize_text_crops_with_detection([("field_1", crop)])["field_1"]

        self.assertEqual(len(recognize_batch.call_args.args[0]), 2)
        self.assertEqual(result["text"], "LEFT RIGHT")
        self.assertEqual(result["confidence"], 0.85)
        self.assertEqual(result["preprocessing"], "paddle_text_detection_then_recognition")
        self.assertEqual(result["engine"], "paddle_text_detection+paddle_thai_ocr")
        self.assertEqual(result["text_detection"]["box_count"], 2)
        self.assertFalse(result["text_detection"]["fallback_used"])

    def test_text_roi_falls_back_to_full_crop_when_no_boxes_detected(self) -> None:
        crop = np.zeros((90, 180, 3), dtype=np.uint8)

        with patch("app.ocr_adapter.detect_text_boxes", return_value={"model": "PP-OCRv5_server_det", "regions": []}), patch(
            "app.ocr_adapter.run_paddle_thai_ocr_batch",
            return_value=[
                {"text": "FULL ROI", "confidence": 0.7, "engine": "paddle_thai_ocr", "model": "th_PP-OCRv5_mobile_rec"}
            ],
        ) as recognize_batch:
            result = _recognize_text_crops_with_detection([("field_1", crop)])["field_1"]

        self.assertEqual(len(recognize_batch.call_args.args[0]), 1)
        self.assertEqual(result["text"], "FULL ROI")
        self.assertEqual(result["confidence"], 0.7)
        self.assertEqual(result["preprocessing"], "paddle_text_detection_fallback_then_recognition")
        self.assertEqual(result["text_detection"]["box_count"], 0)
        self.assertTrue(result["text_detection"]["fallback_used"])


if __name__ == "__main__":
    unittest.main()
