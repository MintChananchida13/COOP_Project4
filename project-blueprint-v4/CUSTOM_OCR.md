# Custom OCR

## Purpose

Fallback mode when no template is confirmed.

## Flow

```text
Template Not Found
→ Custom OCR Studio
→ Select Page
→ Draw ROI
→ OCR
→ Result
→ Optional Request Template
```

## User Actions

- Select page.
- Draw ROI.
- Rename ROI.
- Delete ROI.
- OCR selected ROI.
- Export result.
- Request template.

## Data Rule

Custom ROI must include:
- document_page_id
- page_number
- ROI ratios
- display label

## Optional Template Request

Custom OCR ROI can be submitted as requested_fields.
