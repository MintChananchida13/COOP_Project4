# System Flow

## Template Found

```text
1. User uploads file.
2. System splits file into pages.
3. System preprocesses each page.
4. System generates page embedding.
5. System searches Qdrant Top-K.
6. System OCRs verification fields only.
7. System calculates confidence.
8. System confirms template page.
9. User selects fields grouped by page.
10. System OCRs selected ROI only.
11. System shows results grouped by page.
```

## Template Not Found

```text
1. Detection fails or confidence is too low.
2. System opens Custom OCR Studio.
3. User selects page.
4. User draws ROI.
5. System OCRs selected ROI.
6. User exports results.
7. User may request new template.
```

## Template Request

```text
Case 1: image_only
User uploads sample image/PDF only.
Admin creates everything.

Case 2: image_with_roi
User uploads sample image/PDF and draws requested ROI.
Admin reviews and converts ROI to Template Fields.
```

## Admin Template Creation

```text
1. Review request.
2. Create Template.
3. Create Template Pages.
4. Adjust each sample page.
5. Draw Template Fields.
6. Mark Verification Fields.
7. Draw Ignore Regions.
8. Generate embeddings.
9. Test.
10. Approve.
```
