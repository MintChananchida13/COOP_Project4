import sys
import types
import unittest
from unittest.mock import patch

import numpy as np

from app.model_runtime_client import ModelRuntimeUnavailableError
from app.table_recognition_v2_adapter import (
    TableRecognitionV2UnavailableError,
    recognize_table_v2,
    recognize_table_v2_local,
    table_recognition_runtime_summary,
)


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

    def test_warmup_loads_table_recognition_pipeline_v2(self) -> None:
        fake_paddleocr = types.SimpleNamespace(TableRecognitionPipelineV2=FakeTableRecognitionPipelineV2)

        with patch.dict(sys.modules, {"paddleocr": fake_paddleocr}):
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

    def test_runtime_endpoint_can_use_warmed_local_model_function(self) -> None:
        image = np.zeros((10, 10, 3), dtype=np.uint8)
        fake_paddleocr = types.SimpleNamespace(TableRecognitionPipelineV2=FakeTableRecognitionPipelineV2)

        with patch.dict(sys.modules, {"paddleocr": fake_paddleocr}), patch(
            "app.table_recognition_v2_adapter.cv2.imwrite",
            return_value=True,
        ), patch("app.table_recognition_v2_adapter.Path.unlink"):
            result = recognize_table_v2_local(image)

        self.assertEqual(result["table_rows"], [["A", "B"]])


if __name__ == "__main__":
    unittest.main()
