import unittest
from unittest.mock import patch

from app.services import AdminTemplateService


class PrepublishMultiPageMatchingTest(unittest.TestCase):
    def test_search_layout_candidates_for_pages_queries_every_page_and_averages_scores(self) -> None:
        service = AdminTemplateService()
        called_pages = []

        def fake_search(query_signature, page_number=1, limit=10, include_template_id=None):
            called_pages.append(page_number)
            return [
                {
                    "vector_id": "layout_template_a_ref",
                    "score": {1: 0.9, 2: 0.8, 3: 0.7}[page_number],
                    "metadata": {
                        "template_id": "template_a",
                        "matched_layout_reference_page_number": page_number,
                    },
                }
            ]

        with patch("app.services.search_layout_candidates", side_effect=fake_search):
            results = service._search_layout_candidates_for_pages(
                {
                    1: {"version": "test", "regions": []},
                    2: {"version": "test", "regions": []},
                    3: {"version": "test", "regions": []},
                },
                "draft_template",
                limit=10,
            )

        self.assertEqual(called_pages, [1, 2, 3])
        self.assertEqual(len(results), 1)
        self.assertAlmostEqual(results[0]["score"], 0.8)
        self.assertEqual(results[0]["matched_pages"], 3)
        self.assertEqual(
            [item["template_page_number"] for item in results[0]["page_match_details"]],
            [1, 2, 3],
        )


if __name__ == "__main__":
    unittest.main()
