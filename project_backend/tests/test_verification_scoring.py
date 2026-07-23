import unittest

from app.services import VerificationService


class VerificationScoringTest(unittest.TestCase):
    def setUp(self) -> None:
        self.service = VerificationService()

    def test_short_substring_does_not_pass_contains_match(self) -> None:
        result = self.service._score_match(
            expected_text="Thai National ID Card",
            actual_text="i",
            match_type="contains",
            ocr_confidence=0.99,
            verification_threshold=0.70,
        )

        self.assertFalse(result["passed"])
        self.assertLess(result["text_similarity_score"], 0.25)
        self.assertEqual(result["field_score"], 0.0)
        self.assertEqual(result["failure_reason"], "low_text_similarity")

    def test_near_full_substring_still_scores_as_partial_ocr_match(self) -> None:
        result = self.service._score_match(
            expected_text="PASSPORT",
            actual_text="assport",
            match_type="contains",
            ocr_confidence=0.69,
            verification_threshold=0.70,
        )

        self.assertTrue(result["passed"])
        self.assertGreaterEqual(result["text_similarity_score"], 0.90)
        self.assertGreaterEqual(result["field_score"], 0.90)
        self.assertEqual(result["text_match_score"], result["field_score"])

    def test_text_score_stays_continuous_when_below_threshold(self) -> None:
        result = self.service._score_match(
            expected_text="PASSPORT",
            actual_text="assport",
            match_type="contains",
            ocr_confidence=0.69,
            verification_threshold=0.95,
        )

        self.assertFalse(result["passed"])
        self.assertGreater(result["field_score"], 0.0)
        self.assertLess(result["field_score"], 1.0)
        self.assertEqual(result["score"], result["field_score"])
        self.assertEqual(result["text_match_score"], result["field_score"])
        self.assertEqual(result["failure_reason"], "below_threshold")


if __name__ == "__main__":
    unittest.main()
