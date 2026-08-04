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
    _build_table_candidate,
    _calculate_ocr_confidence,
    _calculate_table_quality,
    _select_best_table_candidate,
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


class EmptyTableRecognitionPipelineV2:
    init_kwargs = None

    def __init__(self, **kwargs):
        EmptyTableRecognitionPipelineV2.init_kwargs = kwargs

    def predict(self, **kwargs):
        return [{}]


class TableRecognitionV2AdapterRuntimeRoutingTest(unittest.TestCase):
    def setUp(self) -> None:
        patcher = patch.multiple(
            "app.table_recognition_v2_adapter",
            _TABLE_MODEL=None,
            _TABLE_MODEL_KIND="",
            _TABLE_WIRED_MODEL_NAME="SLANeXt_wired",
            _TABLE_WIRELESS_MODEL_NAME="SLANeXt_wireless",
            _TABLE_MODEL_NAME="SLANeXt_wired/SLANeXt_wireless",
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
        self.assertEqual(result["model"], "SLANeXt_wired/SLANeXt_wireless")
        self.assertEqual(FakeTableRecognitionPipelineV2.init_kwargs["wired_table_structure_recognition_model_name"], "SLANeXt_wired")
        self.assertEqual(FakeTableRecognitionPipelineV2.init_kwargs["wireless_table_structure_recognition_model_name"], "SLANeXt_wireless")
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
                "structure_model": "SLANeXt_wired/SLANeXt_wireless",
                "wired_structure_model": "SLANeXt_wired",
                "wireless_structure_model": "SLANeXt_wireless",
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

        self.assertEqual(first_model, "SLANeXt_wired/SLANeXt_wireless")
        self.assertEqual(second["model"], "SLANeXt_wired/SLANeXt_wireless")
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

    def test_borderless_table_fallback_clusters_text_boxes_when_slanet_is_empty(self) -> None:
        image = np.zeros((120, 260, 3), dtype=np.uint8)
        fake_paddleocr = types.SimpleNamespace(TableRecognitionPipelineV2=EmptyTableRecognitionPipelineV2)
        detected_regions = [
            {"bbox": {"x": 10, "y": 10, "width": 45, "height": 15}},
            {"bbox": {"x": 120, "y": 10, "width": 45, "height": 15}},
            {"bbox": {"x": 10, "y": 50, "width": 45, "height": 15}},
            {"bbox": {"x": 120, "y": 50, "width": 45, "height": 15}},
        ]
        recognitions = [
            {"text": "Name", "confidence": 0.9},
            {"text": "Amount", "confidence": 0.9},
            {"text": "Alice", "confidence": 0.8},
            {"text": "100", "confidence": 0.8},
        ]

        with patch.dict(sys.modules, {"paddleocr": fake_paddleocr}), patch(
            "app.table_recognition_v2_adapter.cv2.imwrite",
            return_value=True,
        ), patch("app.table_recognition_v2_adapter.Path.unlink"), patch(
            "app.table_recognition_v2_adapter.detect_text_boxes",
            return_value={"regions": detected_regions},
        ) as detect, patch(
            "app.table_recognition_v2_adapter.run_paddle_thai_ocr_batch",
            return_value=recognitions,
        ) as recognize:
            result = recognize_table_v2_local(image)

        self.assertEqual(result["table_rows"], [["Name", "Amount"], ["Alice", "100"]])
        self.assertEqual(result["table_structured"]["rows"], [["Name", "Amount"], ["Alice", "100"]])
        self.assertTrue(result["table_debug"]["borderless_fallback_used"])
        self.assertEqual(result["table_debug"]["column_count"], 2)
        detect.assert_called_once()
        recognize.assert_called_once()

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

    def test_slanext_good_structure_wins_over_borderless(self) -> None:
        slanext = _build_table_candidate(
            {
                "text": "",
                "table_rows": [["A", "B"], ["C", "D"]],
                "table_structured": {
                    "rows": [["A", "B"], ["C", "D"]],
                    "cells": [
                        {"row": 0, "col": 0, "text": "A"},
                        {"row": 0, "col": 1, "text": "B"},
                        {"row": 1, "col": 0, "text": "C"},
                        {"row": 1, "col": 1, "text": "D"},
                    ],
                },
            },
            "slanext",
        )
        borderless = _build_table_candidate({"table_rows": [["A", ""], ["C", ""]]}, "borderless_text_clustering")

        selected, reason = _select_best_table_candidate([slanext, borderless])

        self.assertIs(selected, slanext)
        self.assertIn(reason, {"higher_final_confidence", "tie_preferred_structured_slanext", "tie_breaker"})

    def test_sparse_slanext_loses_to_more_consistent_borderless(self) -> None:
        slanext = _build_table_candidate({"table_rows": [["A", "", "", ""], ["", "", "", ""], ["B", "", "", ""]]}, "slanext")
        borderless = _build_table_candidate(
            {
                "table_rows": [["A", "B", "C"], ["D", "E", "F"]],
                "segments": [{"text": "A", "confidence": 0.92}, {"text": "B", "confidence": 0.9}],
            },
            "borderless_text_clustering",
        )

        selected, reason = _select_best_table_candidate([slanext, borderless])

        self.assertIs(selected, borderless)
        self.assertIn(reason, {"higher_final_confidence", "borderless_improved_low_quality_slanext"})

    def test_tie_prefers_structured_slanext(self) -> None:
        rows = [["A", "B"], ["C", "D"]]
        slanext = _build_table_candidate(
            {
                "table_rows": rows,
                "table_structured": {
                    "rows": rows,
                    "cells": [
                        {"row": 0, "col": 0, "text": "A"},
                        {"row": 0, "col": 1, "text": "B"},
                        {"row": 1, "col": 0, "text": "C"},
                        {"row": 1, "col": 1, "text": "D"},
                    ],
                },
            },
            "slanext",
        )
        borderless = _build_table_candidate({"table_rows": rows}, "borderless_text_clustering")
        slanext["confidence"] = 0.8
        slanext["table_debug"]["final_confidence"] = 0.8
        borderless["confidence"] = 0.81
        borderless["table_debug"]["final_confidence"] = 0.81

        selected, reason = _select_best_table_candidate([borderless, slanext])

        self.assertIs(selected, slanext)
        self.assertEqual(reason, "tie_preferred_structured_slanext")

    def test_borderless_error_returns_slanext_candidate(self) -> None:
        image = np.zeros((120, 260, 3), dtype=np.uint8)
        fake_paddleocr = types.SimpleNamespace(TableRecognitionPipelineV2=FakeTableRecognitionPipelineV2)

        with patch.dict(sys.modules, {"paddleocr": fake_paddleocr}), patch(
            "app.table_recognition_v2_adapter.cv2.imwrite",
            return_value=True,
        ), patch("app.table_recognition_v2_adapter.Path.unlink"), patch(
            "app.table_recognition_v2_adapter._recognize_borderless_table",
            side_effect=RuntimeError("borderless boom"),
        ):
            result = recognize_table_v2_local(image)

        self.assertEqual(result["table_selected_method"], "slanext")
        self.assertEqual(result["table_rows"], [["A", "B"]])

    def test_no_rows_quality_score_is_zero(self) -> None:
        quality = _calculate_table_quality([], None, "slanext")

        self.assertEqual(quality["score"], 0.0)
        self.assertFalse(quality["usable_shape"])
        self.assertIn("no_rows", quality["penalties"])

    def test_missing_ocr_confidence_is_not_assumed_perfect(self) -> None:
        candidate = _build_table_candidate({"table_rows": [["A", "B"], ["C", "D"]]}, "slanext")

        self.assertFalse(candidate["table_debug"]["ocr_confidence"]["available"])
        self.assertLess(candidate["confidence"], 1.0)

    def test_confidence_0_to_100_is_normalized(self) -> None:
        ocr_confidence = _calculate_ocr_confidence(
            {
                "segments": [
                    {"text": "A", "confidence": 95},
                    {"text": "B", "confidence": 80},
                    {"text": "", "confidence": 10},
                ]
            }
        )

        self.assertTrue(ocr_confidence["available"])
        self.assertEqual(ocr_confidence["recognized_count"], 2)
        self.assertAlmostEqual(ocr_confidence["average"], 0.875)

    def test_merged_cells_are_not_over_penalized(self) -> None:
        rows = [["Header", ""], ["A", "B"], ["C", "D"]]
        structured = {
            "rows": rows,
            "cells": [
                {"row": 0, "col": 0, "text": "Header", "rowSpan": 1, "colSpan": 2},
                {"row": 0, "col": 1, "text": "", "hidden": True},
                {"row": 1, "col": 0, "text": "A"},
                {"row": 1, "col": 1, "text": "B"},
                {"row": 2, "col": 0, "text": "C"},
                {"row": 2, "col": 1, "text": "D"},
            ],
        }

        quality = _calculate_table_quality(rows, structured, "slanext")

        self.assertGreater(quality["score"], 0.65)
        self.assertGreater(quality["merged_cell_ratio"], 0.0)


if __name__ == "__main__":
    unittest.main()
