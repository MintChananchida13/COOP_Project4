import json
import unittest
from unittest.mock import patch

from app.layout_signature_service import build_layout_signature
from app.layout_template_matcher import search_layout_candidates


def _layout(regions):
    return {
        "engine": "test",
        "model": "layout",
        "image_width": 1000,
        "image_height": 500,
        "regions": regions,
    }


def _region(label, x, y, width, height):
    return {
        "type": label,
        "confidence": 0.9,
        "roi": {
            "x_ratio": x,
            "y_ratio": y,
            "width_ratio": width,
            "height_ratio": height,
        },
    }


class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class _Connection:
    def __init__(self, reference_rows, fallback_rows):
        self.reference_rows = reference_rows
        self.fallback_rows = fallback_rows
        self.page_filters = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return None

    def execute(self, sql, params=()):
        normalized = " ".join(sql.split()).lower()
        if normalized.startswith("pragma"):
            return _Cursor([])
        if normalized.startswith("create") or normalized.startswith("alter"):
            return _Cursor([])
        if "from template_layout_references" in normalized and "join templates" in normalized:
            self.page_filters.append(params[0])
            return _Cursor([row for row in self.reference_rows if row["page_number"] == params[0]])
        if "from template_pages" in normalized and "join templates" in normalized:
            self.page_filters.append(params[0])
            return _Cursor([row for row in self.fallback_rows if row["page_number"] == params[0]])
        return _Cursor([])

    def commit(self):
        return None


class LayoutTemplateMatcherPageRoutingTest(unittest.TestCase):
    def test_search_layout_candidates_filters_references_by_query_page_number(self):
        page_one_signature = build_layout_signature(_layout([_region("text", 0.1, 0.1, 0.3, 0.08)]))
        page_two_signature = build_layout_signature(_layout([_region("table", 0.1, 0.4, 0.75, 0.3)]))
        connection = _Connection(
            reference_rows=[
                {
                    "template_id": "template_a",
                    "template_name": "Template A",
                    "template_status": "active",
                    "page_count": 2,
                    "final_confidence_threshold": 0.8,
                    "layout_weight": 0.4,
                    "text_anchor_weight": 0.3,
                    "image_anchor_weight": 0.3,
                    "template_page_id": "page_1",
                    "layout_reference_id": "ref_1",
                    "page_number": 1,
                    "layout_reference_image_url": "page_1.png",
                    "layout_reference_source": "template_page",
                    "layout_reference_is_canonical": 1,
                    "layout_signature_json": json.dumps(page_one_signature),
                },
                {
                    "template_id": "template_a",
                    "template_name": "Template A",
                    "template_status": "active",
                    "page_count": 2,
                    "final_confidence_threshold": 0.8,
                    "layout_weight": 0.4,
                    "text_anchor_weight": 0.3,
                    "image_anchor_weight": 0.3,
                    "template_page_id": "page_2",
                    "layout_reference_id": "ref_2",
                    "page_number": 2,
                    "layout_reference_image_url": "page_2.png",
                    "layout_reference_source": "template_page",
                    "layout_reference_is_canonical": 1,
                    "layout_signature_json": json.dumps(page_two_signature),
                },
            ],
            fallback_rows=[],
        )

        with patch("app.layout_template_matcher.connect_db", return_value=connection):
            results = search_layout_candidates(page_two_signature, page_number=1)

        self.assertEqual(connection.page_filters, [1, 1])
        self.assertEqual(len(results), 1)
        metadata = results[0]["metadata"]
        self.assertEqual(metadata["matched_layout_reference_page_number"], 1)
        self.assertEqual(metadata["matched_layout_reference_id"], "ref_1")


if __name__ == "__main__":
    unittest.main()
