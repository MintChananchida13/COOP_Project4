# OCR Design

## OCR Policy

Never OCR the whole document by default.

OCR only:
- Verification Fields
- User-selected fields
- Custom ROI fields

## OCR Verification

For candidate template page:
1. Load fields where `use_for_verification = true`.
2. Convert ROI ratio to pixel.
3. Crop ROI from document page.
4. OCR ROI.
5. Compare with expected_text.

## Match Types

```text
exact
contains
fuzzy
```

## Text Normalization

Before matching:
- trim
- collapse whitespace
- normalize case where applicable
- optionally normalize common OCR artifacts

## Extraction OCR

After template is confirmed:
- Show selectable fields.
- User selects fields.
- OCR selected ROI only.
- Return result grouped by page.

## Custom OCR

When no template is found:
- User draws ROI.
- OCR selected ROI only.
- Optional template request.
