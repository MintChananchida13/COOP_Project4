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
    _postprocess_table_result,
    _select_best_table_candidate,
    _section_from_region_candidate,
    _try_semi_structured_table,
    recognize_table_v2,
    recognize_table_v2_local,
    table_recognition_runtime_summary,
)
from app.table_grid_analyzer import analyze_table_regions
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

    @unittest.skipUnless(importlib.util.find_spec("bs4") and importlib.util.find_spec("lxml"), "beautifulsoup4/lxml not installed")
    def test_table_html_postprocess_preserves_empty_tr_rows(self) -> None:
        result = parse_table_html_with_bs4("<table><tr><td>A</td></tr><tr></tr><tr><td>C</td></tr></table>")

        self.assertIsNotNone(result)
        self.assertEqual(result["rows"], [["A"], [""], ["C"]])

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

    def test_grid_analyzer_splits_multiple_topologies_without_text_keywords(self) -> None:
        image = np.full((240, 240, 3), 255, dtype=np.uint8)
        for y in [10, 70, 130, 190, 230]:
            image[y : y + 2, 10:230] = 0
        for x in [10, 80, 150, 230]:
            image[10:130, x : x + 2] = 0
        for x in [10, 120, 230]:
            image[130:230, x : x + 2] = 0

        analysis = analyze_table_regions(image)

        self.assertTrue(analysis["detected"])
        self.assertGreaterEqual(len(analysis["regions"]), 2)
        self.assertGreaterEqual(analysis["confidence"], 0.72)
        self.assertTrue(all({"bbox", "confidence", "type"}.issubset(region) for region in analysis["regions"]))

    def test_normal_table_does_not_split(self) -> None:
        image = np.full((220, 220, 3), 255, dtype=np.uint8)
        for y in [10, 70, 130, 190]:
            image[y : y + 2, 10:210] = 0
        for x in [10, 80, 150, 210]:
            image[10:190, x : x + 2] = 0

        analysis = analyze_table_regions(image)

        self.assertFalse(analysis["detected"])

    def test_semi_structured_regions_are_read_with_slanext_and_merged(self) -> None:
        image = np.zeros((120, 120, 3), dtype=np.uint8)

        class RegionModel:
            calls = 0

            def predict(self, **kwargs):
                RegionModel.calls += 1
                value = "Top" if RegionModel.calls == 1 else "Bottom"
                return [{"html": f"<table><tr><td>{value}</td><td>Value</td></tr><tr><td>A</td><td>B</td></tr></table>"}]

        fake_analysis = {
            "detected": True,
            "confidence": 0.91,
            "regions": [
                {"type": "grid", "bbox": {"x": 0, "y": 0, "width": 120, "height": 60}},
                {"type": "grid", "bbox": {"x": 0, "y": 60, "width": 120, "height": 60}},
            ],
        }

        with patch("app.table_recognition_v2_adapter.analyze_table_regions", return_value=fake_analysis), patch(
            "app.table_recognition_v2_adapter.cv2.imwrite",
            return_value=True,
        ), patch("app.table_recognition_v2_adapter.Path.unlink"):
            result = _try_semi_structured_table(image, RegionModel(), 0.0)

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["table_rows"], [["Top", "Value"], ["A", "B"], ["Bottom", "Value"], ["A", "B"]])
        self.assertTrue(result["table_semi_analysis"]["detected"])
        self.assertEqual(result["table_semi_analysis"]["merge_status"], "merged")
        self.assertEqual(result["table_selected_method"], "semi_structured_regions")

    def test_semi_structured_keeps_region_with_content_even_when_region_shape_is_small(self) -> None:
        image = np.zeros((120, 120, 3), dtype=np.uint8)

        class SmallRegionModel:
            calls = 0

            def predict(self, **kwargs):
                SmallRegionModel.calls += 1
                return [{"html": f"<table><tr><td>Region {SmallRegionModel.calls}</td></tr></table>"}]

        fake_analysis = {
            "detected": True,
            "confidence": 0.91,
            "regions": [
                {"type": "grid", "bbox": {"x": 0, "y": 0, "width": 120, "height": 60}},
                {"type": "grid", "bbox": {"x": 0, "y": 60, "width": 120, "height": 60}},
            ],
        }

        with patch("app.table_recognition_v2_adapter.analyze_table_regions", return_value=fake_analysis), patch(
            "app.table_recognition_v2_adapter.cv2.imwrite",
            return_value=True,
        ), patch("app.table_recognition_v2_adapter.Path.unlink"):
            result = _try_semi_structured_table(image, SmallRegionModel(), 0.0)

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["table_rows"], [["Region 1"], ["Region 2"]])
        self.assertEqual(result["table_debug"]["status"], "semi_structured_merged")

    def test_semi_structured_remaps_bbox_and_preserves_spans(self) -> None:
        image = np.zeros((160, 160, 3), dtype=np.uint8)

        class BboxModel:
            calls = 0

            def predict(self, **kwargs):
                BboxModel.calls += 1
                label = "First" if BboxModel.calls == 1 else "Second"
                return [
                    {
                        "table_rows": [[label, ""], ["A", "B"]],
                        "table_structured": {
                            "rows": [[label, ""], ["A", "B"]],
                            "cells": [
                                {"row": 0, "col": 0, "text": label, "rowSpan": 1, "colSpan": 2, "bbox": {"x": 2, "y": 3, "width": 40, "height": 10}},
                                {"row": 1, "col": 0, "text": "A", "rowSpan": 1, "colSpan": 1, "bbox": {"x": 2, "y": 20, "width": 18, "height": 10}},
                                {"row": 1, "col": 1, "text": "B", "rowSpan": 1, "colSpan": 1, "bbox": {"x": 24, "y": 20, "width": 18, "height": 10}},
                            ],
                        },
                    }
                ]

        fake_analysis = {
            "detected": True,
            "confidence": 0.91,
            "regions": [
                {"type": "grid", "confidence": 0.91, "bbox": {"x": 5, "y": 7, "width": 120, "height": 60}},
                {"type": "grid", "confidence": 0.91, "bbox": {"x": 9, "y": 80, "width": 120, "height": 60}},
            ],
        }

        with patch("app.table_recognition_v2_adapter.analyze_table_regions", return_value=fake_analysis), patch(
            "app.table_recognition_v2_adapter.cv2.imwrite",
            return_value=True,
        ), patch("app.table_recognition_v2_adapter.Path.unlink"):
            result = _try_semi_structured_table(image, BboxModel(), 0.0)

        self.assertIsNotNone(result)
        assert result is not None
        cells = result["table_structured"]["cells"]
        self.assertEqual(cells[0]["colSpan"], 2)
        self.assertEqual(cells[0]["bbox"]["x"], 7.0)
        self.assertEqual(cells[0]["bbox"]["y"], 10.0)
        self.assertEqual(cells[3]["row"], 2)
        self.assertEqual(cells[3]["bbox"]["x"], 11.0)
        self.assertEqual(cells[3]["bbox"]["y"], 83.0)
        self.assertEqual(cells[0]["regionId"], "region_1")
        self.assertEqual(result["table_sections"][0]["cells"][0]["regionId"], "region_1")

    def test_semi_structured_sections_keep_local_columns_for_secondary_grids(self) -> None:
        image = np.zeros((220, 220, 3), dtype=np.uint8)

        class MultiTopologyModel:
            calls = 0

            def predict(self, **kwargs):
                MultiTopologyModel.calls += 1
                if MultiTopologyModel.calls == 1:
                    row = "".join(f"<td>M{i}</td>" for i in range(1, 8))
                    return [{"html": f"<table><tr>{row}</tr></table>"}]
                if MultiTopologyModel.calls == 2:
                    return [{"html": "<table><tr><td>S1</td><td>S2</td></tr></table>"}]
                return [{"html": "<table><tr><td>A</td><td>B</td><td>C</td></tr></table>"}]

        fake_analysis = {
            "detected": True,
            "confidence": 0.94,
            "regions": [
                {"type": "grid", "regionId": "main", "bbox": {"x": 0, "y": 0, "width": 220, "height": 80}},
                {"type": "grid", "regionId": "summary_2col", "bbox": {"x": 0, "y": 80, "width": 220, "height": 60}},
                {"type": "grid", "regionId": "summary_3col", "bbox": {"x": 0, "y": 140, "width": 220, "height": 60}},
            ],
        }

        with patch("app.table_recognition_v2_adapter.analyze_table_regions", return_value=fake_analysis), patch(
            "app.table_recognition_v2_adapter.cv2.imwrite",
            return_value=True,
        ), patch("app.table_recognition_v2_adapter.Path.unlink"):
            result = _try_semi_structured_table(image, MultiTopologyModel(), 0.0)

        self.assertIsNotNone(result)
        assert result is not None
        sections = result["table_sections"]
        self.assertEqual([len(section["columns"]) for section in sections], [7, 2, 3])
        self.assertEqual(sections[0]["regionId"], "main")
        self.assertEqual(sections[1]["regionId"], "summary_2col")
        self.assertEqual(sections[2]["regionId"], "summary_3col")
        self.assertEqual(len(result["table_structured"]["rows"][0]), 7)
        self.assertEqual(len(result["table_structured"]["rows"][1]), 2)
        self.assertEqual(len(result["table_structured"]["rows"][2]), 3)
        self.assertEqual(result["table_structured"]["cells"][0]["regionId"], "main")
        self.assertEqual(result["table_semi_analysis"]["regions"][1]["result"]["columns"][1]["col"], 1)

    def test_column_anchor_assignment_prevents_values_shifting_to_neighbor_columns(self) -> None:
        cells = []
        anchors_x = [10, 50, 90, 130, 170, 210, 250]
        for col, x in enumerate(anchors_x):
            cells.append({"row": 0, "col": col, "text": f"H{col}", "bbox": {"x": x - 6, "y": 0, "width": 12, "height": 10}, "rowSpan": 1, "colSpan": 1})
        # Deliberately wrong SLANeXt col values. Geometry should put all item ids back in column 0.
        for row, item_id in enumerate(["IC-0003", "IC-0004", "IC-0005"], start=1):
            cells.append({"row": row, "col": 1, "text": item_id, "bbox": {"x": 4, "y": row * 20, "width": 24, "height": 10}, "rowSpan": 1, "colSpan": 1})
            cells.append({"row": row, "col": 3, "text": str(row * 100), "bbox": {"x": 84, "y": row * 20, "width": 18, "height": 10}, "rowSpan": 1, "colSpan": 1})
        candidate = {
            "confidence": 0.9,
            "table_rows": [[""] * 7 for _ in range(4)],
            "table_structured": {"rows": [[""] * 7 for _ in range(4)], "cells": cells, "headerRowCount": 1},
        }

        section = _section_from_region_candidate(candidate, {"bbox": {"x": 0, "y": 0, "width": 280, "height": 100}}, "main")

        self.assertEqual(section["rows"][1][0], "IC-0003")
        self.assertEqual(section["rows"][2][0], "IC-0004")
        self.assertEqual(section["rows"][3][0], "IC-0005")
        self.assertEqual(section["rows"][1][2], "100")
        item_cells = [cell for cell in section["cells"] if cell["text"].startswith("IC-")]
        self.assertTrue(all(cell["col"] == 0 for cell in item_cells))

    def test_summary_table_uses_local_column_anchors(self) -> None:
        cells = [
            {"row": 0, "col": 0, "text": "Total", "bbox": {"x": 10, "y": 0, "width": 40, "height": 10}, "rowSpan": 1, "colSpan": 1},
            {"row": 0, "col": 1, "text": "300", "bbox": {"x": 150, "y": 0, "width": 30, "height": 10}, "rowSpan": 1, "colSpan": 1},
            {"row": 1, "col": 0, "text": "VAT", "bbox": {"x": 12, "y": 20, "width": 28, "height": 10}, "rowSpan": 1, "colSpan": 1},
            {"row": 1, "col": 1, "text": "21", "bbox": {"x": 154, "y": 20, "width": 20, "height": 10}, "rowSpan": 1, "colSpan": 1},
        ]
        candidate = {"confidence": 0.8, "table_rows": [["Total", "300"], ["VAT", "21"]], "table_structured": {"rows": [["Total", "300"], ["VAT", "21"]], "cells": cells}}

        section = _section_from_region_candidate(candidate, {"bbox": {"x": 0, "y": 120, "width": 220, "height": 60}}, "summary")

        self.assertEqual(len(section["columns"]), 2)
        self.assertEqual(section["rows"], [["Total", "300"], ["VAT", "21"]])
        self.assertTrue(all(cell["colSpan"] == 1 for cell in section["cells"]))

    def test_column_anchor_reconstruction_preserves_header_merge(self) -> None:
        cells = [
            {"row": 0, "col": 0, "text": "Asset", "bbox": {"x": 0, "y": 0, "width": 90, "height": 10}, "rowSpan": 1, "colSpan": 2},
            {"row": 1, "col": 0, "text": "Code", "bbox": {"x": 0, "y": 20, "width": 30, "height": 10}, "rowSpan": 1, "colSpan": 1},
            {"row": 1, "col": 1, "text": "Name", "bbox": {"x": 50, "y": 20, "width": 30, "height": 10}, "rowSpan": 1, "colSpan": 1},
        ]
        candidate = {"confidence": 0.8, "table_rows": [["Asset", ""], ["Code", "Name"]], "table_structured": {"rows": [["Asset", ""], ["Code", "Name"]], "cells": cells}}

        section = _section_from_region_candidate(candidate, {"bbox": {"x": 0, "y": 0, "width": 120, "height": 50}}, "main")
        header = next(cell for cell in section["cells"] if cell["text"] == "Asset")

        self.assertEqual(header["col"], 0)
        self.assertEqual(header["colSpan"], 2)

    def test_postprocess_preserves_empty_cells_and_merge_grid(self) -> None:
        result = {
            "text": "",
            "table_structured": {
                "cells": [
                    {"row": 0, "col": 0, "text": "Header", "rowSpan": 1, "colSpan": 3},
                    {"row": 0, "col": 1, "text": "", "rowSpan": 1, "colSpan": 1, "hidden": True},
                    {"row": 0, "col": 2, "text": "", "rowSpan": 1, "colSpan": 1, "hidden": True},
                    {"row": 1, "col": 0, "text": "A", "rowSpan": 1, "colSpan": 1},
                    {"row": 1, "col": 1, "text": "", "rowSpan": 1, "colSpan": 1},
                    {"row": 1, "col": 2, "text": "C", "rowSpan": 1, "colSpan": 1},
                    {"row": 2, "col": 0, "text": "", "rowSpan": 1, "colSpan": 1},
                    {"row": 2, "col": 1, "text": "", "rowSpan": 1, "colSpan": 1},
                    {"row": 2, "col": 2, "text": "", "rowSpan": 1, "colSpan": 1},
                ],
                "headerRowCount": 1,
            },
        }

        processed = _postprocess_table_result(result)

        self.assertEqual(processed["table_rows"], [["Header", "", ""], ["A", "", "C"], ["", "", ""]])
        self.assertEqual(len(processed["table_structured"]["cells"]), 9)
        self.assertEqual(processed["table_structured"]["cells"][0]["colSpan"], 3)

    def test_postprocess_prefers_structured_cell_grid_over_short_rows(self) -> None:
        cells = [
            {"row": row, "col": col, "text": "A" if row == 0 and col == 0 else "", "rowSpan": 1, "colSpan": 1}
            for row in range(10)
            for col in range(2)
        ]
        result = {
            "text": "",
            "table_rows": [["A", ""]],
            "table_structured": {
                "rows": [["A", ""]],
                "cells": cells,
                "headerRowCount": 1,
            },
        }

        processed = _postprocess_table_result(result)

        self.assertEqual(len(processed["table_rows"]), 10)
        self.assertEqual(len(processed["table_rows"][0]), 2)
        self.assertEqual(processed["table_rows"][9], ["", ""])
        self.assertEqual(len(processed["table_structured"]["rows"]), 10)

    def test_semi_structured_all_regions_fail_returns_none_for_whole_roi_fallback(self) -> None:
        image = np.zeros((120, 120, 3), dtype=np.uint8)
        fake_analysis = {
            "detected": True,
            "confidence": 0.91,
            "regions": [{"type": "grid", "bbox": {"x": 0, "y": 0, "width": 120, "height": 60}}],
        }

        with patch("app.table_recognition_v2_adapter.analyze_table_regions", return_value=fake_analysis):
            result = _try_semi_structured_table(image, object(), 0.0)

        self.assertIsNone(result)

    def test_grid_analyzer_error_falls_back_to_whole_roi(self) -> None:
        image = np.zeros((120, 260, 3), dtype=np.uint8)
        fake_paddleocr = types.SimpleNamespace(TableRecognitionPipelineV2=FakeTableRecognitionPipelineV2)

        with patch.dict(sys.modules, {"paddleocr": fake_paddleocr}), patch(
            "app.table_recognition_v2_adapter.analyze_table_regions",
            side_effect=RuntimeError("grid analyzer boom"),
        ), patch("app.table_recognition_v2_adapter.cv2.imwrite", return_value=True), patch(
            "app.table_recognition_v2_adapter.Path.unlink"
        ):
            result = recognize_table_v2_local(image)

        self.assertEqual(result["table_rows"], [["A", "B"]])
        self.assertEqual(result["table_semi_analysis"]["merge_status"], "whole_roi_fallback")
        self.assertFalse(result["table_semi_analysis"]["detected"])

    def test_ocr_table_fallback_is_selected_when_slanext_has_no_usable_table(self) -> None:
        image = np.zeros((120, 260, 3), dtype=np.uint8)
        fake_paddleocr = types.SimpleNamespace(TableRecognitionPipelineV2=EmptyTableRecognitionPipelineV2)
        fallback_result = {
            "text": "| A | B |\n| --- | --- |\n| 1 | 2 |",
            "confidence": 0.82,
            "segments": [],
            "attempts": [{"step": "ocr_table_fallback"}],
            "preprocessing": "ocr_table_fallback_text_detection_clustering",
            "engine": "table_recognition_v2",
            "model": "SLANeXt_wired/SLANeXt_wireless",
            "table_rows": [["A", "B"], ["1", "2"]],
            "table_structured": {
                "rows": [["A", "B"], ["1", "2"]],
                "cells": [
                    {"row": 0, "col": 0, "text": "A", "rowSpan": 1, "colSpan": 1},
                    {"row": 0, "col": 1, "text": "B", "rowSpan": 1, "colSpan": 1},
                    {"row": 1, "col": 0, "text": "1", "rowSpan": 1, "colSpan": 1},
                    {"row": 1, "col": 1, "text": "2", "rowSpan": 1, "colSpan": 1},
                ],
                "headerRowCount": 1,
            },
            "table_debug": {"status": "ocr_table_fallback"},
        }

        with patch.dict(sys.modules, {"paddleocr": fake_paddleocr}), patch(
            "app.table_recognition_v2_adapter.analyze_table_regions",
            return_value={"detected": False, "confidence": 0.0, "regions": [], "reason": "normal"},
        ), patch("app.table_recognition_v2_adapter.cv2.imwrite", return_value=True), patch(
            "app.table_recognition_v2_adapter.Path.unlink"
        ), patch("app.table_recognition_v2_adapter._recognize_ocr_table_fallback", return_value=fallback_result):
            result = recognize_table_v2_local(image)

        self.assertEqual(result["table_selected_method"], "ocr_table_fallback")
        self.assertEqual(result["table_debug"]["status"], "ocr_table_fallback")
        self.assertEqual(result["table_rows"], [["A", "B"], ["1", "2"]])
        self.assertNotEqual(result["table_rows"], [["Column 1"], [""]])


if __name__ == "__main__":
    unittest.main()
