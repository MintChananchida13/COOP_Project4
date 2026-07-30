import os
import sys
import types
import unittest
import importlib.util
from unittest.mock import patch

import numpy as np

from app.model_runtime_client import ModelRuntimeUnavailableError
from app.table_recognition_v2_adapter import (
    TableRecognitionV2UnavailableError,
    recognize_table_v2,
    recognize_table_v2_local,
    table_recognition_runtime_summary,
)
from app.ocr_postprocess import normalize_ocr_text, normalize_table_rows, parse_table_html_with_bs4


class FakeTableRecognitionPipelineV2:
    init_kwargs = None

    def __init__(self, **kwargs):
        FakeTableRecognitionPipelineV2.init_kwargs = kwargs

    def predict(self, **kwargs):
        return [{"html": "<table><tr><td>A</td><td>B</td></tr></table>"}]


class TableRecognitionV2AdapterRuntimeRoutingTest(unittest.TestCase):
    def setUp(self) -> None:
        patcher = patch.multiple(
            "app.table_recognition_v2_adapter",
            _TABLE_MODEL=None,
            _TABLE_MODEL_KIND="",
            _TABLE_MODEL_NAME="SLANet_plus",
            _TABLE_TEXT_RECOGNITION_MODEL_NAME="th_PP-OCRv5_mobile_rec",
            _TABLE_DEVICE="cpu",
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        FakeTableRecognitionPipelineV2.init_kwargs = None

    def test_remote_runtime_is_used_without_loading_local_pipeline(self) -> None:
        image = np.zeros((10, 10, 3), dtype=np.uint8)

        with patch.dict("os.environ", {"MODEL_SERVICE_URL": "https://model.example"}, clear=False), patch(
            "app.table_recognition_v2_adapter.remote_recognize_table",
            return_value={"text": "| A |", "confidence": 1.0, "engine": "table_recognition_v2"},
        ) as remote, patch("app.table_recognition_v2_adapter._load_table_model") as load_local:
            result = recognize_table_v2(image)

        self.assertEqual(result["text"], "| A |")
        remote.assert_called_once()
        load_local.assert_not_called()

    def test_remote_runtime_error_raises_without_local_fallback(self) -> None:
        image = np.zeros((10, 10, 3), dtype=np.uint8)

        with patch.dict("os.environ", {"MODEL_SERVICE_URL": "https://model.example"}, clear=False), patch(
            "app.table_recognition_v2_adapter.remote_recognize_table",
            side_effect=ModelRuntimeUnavailableError("remote table boom"),
        ), patch("app.table_recognition_v2_adapter._load_table_model") as load_local:
            with self.assertRaisesRegex(TableRecognitionV2UnavailableError, "remote table boom"):
                recognize_table_v2(image)

        load_local.assert_not_called()

    def test_remote_runtime_none_raises_clear_error(self) -> None:
        image = np.zeros((10, 10, 3), dtype=np.uint8)

        with patch.dict("os.environ", {"MODEL_SERVICE_URL": "https://model.example"}, clear=False), patch(
            "app.table_recognition_v2_adapter.remote_recognize_table",
            return_value=None,
        ), patch("app.table_recognition_v2_adapter._load_table_model") as load_local:
            with self.assertRaisesRegex(TableRecognitionV2UnavailableError, "Remote Table Recognition runtime returned no result."):
                recognize_table_v2(image)

        load_local.assert_not_called()

    def test_empty_model_service_url_uses_local_pipeline(self) -> None:
        image = np.zeros((10, 10, 3), dtype=np.uint8)
        fake_paddleocr = types.SimpleNamespace(TableRecognitionPipelineV2=FakeTableRecognitionPipelineV2)

        with patch.dict("os.environ", {"MODEL_SERVICE_URL": ""}, clear=False), patch.dict(sys.modules, {"paddleocr": fake_paddleocr}), patch(
            "app.table_recognition_v2_adapter.cv2.imwrite",
            return_value=True,
        ), patch("app.table_recognition_v2_adapter.Path.unlink"):
            result = recognize_table_v2(image)

        self.assertEqual(result["engine"], "table_recognition_v2")
        self.assertEqual(result["model"], "SLANet_plus")
        self.assertEqual(FakeTableRecognitionPipelineV2.init_kwargs["wired_table_structure_recognition_model_name"], "SLANet_plus")
        self.assertEqual(FakeTableRecognitionPipelineV2.init_kwargs["wireless_table_structure_recognition_model_name"], "SLANet_plus")
        self.assertEqual(FakeTableRecognitionPipelineV2.init_kwargs["text_recognition_model_name"], "th_PP-OCRv5_mobile_rec")
        self.assertEqual(FakeTableRecognitionPipelineV2.init_kwargs["device"], "cpu")

    def test_paddle_table_device_cpu_is_used_by_pipeline_and_summary(self) -> None:
        fake_paddleocr = types.SimpleNamespace(TableRecognitionPipelineV2=FakeTableRecognitionPipelineV2)

        with patch("app.table_recognition_v2_adapter._TABLE_DEVICE", "cpu"), patch.dict(sys.modules, {"paddleocr": fake_paddleocr}):
            summary = table_recognition_runtime_summary()

        self.assertEqual(
            summary,
            {
                "enabled": True,
                "structure_model": "SLANet_plus",
                "text_recognition_model": "th_PP-OCRv5_mobile_rec",
                "device": "cpu",
            },
        )
        self.assertIsNotNone(FakeTableRecognitionPipelineV2.init_kwargs)
        self.assertEqual(FakeTableRecognitionPipelineV2.init_kwargs["device"], "cpu")

    def test_paddle_table_device_env_gpu_is_ignored_for_cpu_only_runtime(self) -> None:
        fake_paddleocr = types.SimpleNamespace(TableRecognitionPipelineV2=FakeTableRecognitionPipelineV2)

        with patch.dict("os.environ", {"PADDLE_TABLE_DEVICE": "gpu:0"}, clear=False), patch.dict(sys.modules, {"paddleocr": fake_paddleocr}):
            summary = table_recognition_runtime_summary()

        self.assertEqual(summary["device"], "cpu")
        self.assertIsNotNone(FakeTableRecognitionPipelineV2.init_kwargs)
        self.assertEqual(FakeTableRecognitionPipelineV2.init_kwargs["device"], "cpu")

    def test_cached_pipeline_is_reused(self) -> None:
        image = np.zeros((10, 10, 3), dtype=np.uint8)
        fake_paddleocr = types.SimpleNamespace(TableRecognitionPipelineV2=FakeTableRecognitionPipelineV2)

        with patch.dict(sys.modules, {"paddleocr": fake_paddleocr}), patch(
            "app.table_recognition_v2_adapter.cv2.imwrite",
            return_value=True,
        ), patch("app.table_recognition_v2_adapter.Path.unlink"):
            first = recognize_table_v2_local(image)
            first_model = first["model"]
            FakeTableRecognitionPipelineV2.init_kwargs = {"sentinel": "should_not_be_reinitialized"}
            second = recognize_table_v2_local(image)

        self.assertEqual(first_model, "SLANet_plus")
        self.assertEqual(second["model"], "SLANet_plus")
        self.assertEqual(FakeTableRecognitionPipelineV2.init_kwargs, {"sentinel": "should_not_be_reinitialized"})

    def test_runtime_endpoint_can_use_warmed_local_model_function(self) -> None:
        image = np.zeros((10, 10, 3), dtype=np.uint8)
        fake_paddleocr = types.SimpleNamespace(TableRecognitionPipelineV2=FakeTableRecognitionPipelineV2)

        with patch.dict(sys.modules, {"paddleocr": fake_paddleocr}), patch(
            "app.table_recognition_v2_adapter.cv2.imwrite",
            return_value=True,
        ), patch("app.table_recognition_v2_adapter.Path.unlink"):
            result = recognize_table_v2_local(image)

        self.assertEqual(result["table_rows"], [["A", "B"]])

    @unittest.skipUnless(importlib.util.find_spec("bs4") and importlib.util.find_spec("lxml"), "beautifulsoup4/lxml not installed")
    def test_table_html_postprocess_uses_beautifulsoup_lxml(self) -> None:
        result = parse_table_html_with_bs4("<table><tr><th> วันที่ </th><th>ยอดเงิน</th></tr><tr><td>  1  ม.ค.  </td><td>  100.00 </td></tr></table>")

        self.assertIsNotNone(result)
        self.assertEqual(result["rows"], [["วันที่", "ยอดเงิน"], ["1 ม.ค.", "100.00"]])
        self.assertEqual(result["parser"], "beautifulsoup4+lxml")

    @unittest.skipUnless(importlib.util.find_spec("pythainlp"), "pythainlp not installed")
    def test_ocr_text_postprocess_uses_pythainlp_normalization(self) -> None:
        self.assertEqual(normalize_ocr_text("  ทดสอบ   OCR  \n\n  ภาษาไทย  "), "ทดสอบ OCR\nภาษาไทย")

    def test_table_row_postprocess_preserves_empty_structure_rows(self) -> None:
        rows = normalize_table_rows([["หัวข้อ", "จำนวน"], ["", ""], ["รวม", "10"]])

        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[1], ["", ""])
        self.assertEqual(rows[2][1], "10")


if __name__ == "__main__":
    unittest.main()
