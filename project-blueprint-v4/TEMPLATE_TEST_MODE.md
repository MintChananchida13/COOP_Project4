# Template Test Mode

## Purpose

Admin tests template before approval.

## Input

- image
- PDF
- multiple images

## Flow

```text
Upload Test File
→ Split into Pages
→ Preprocess Each Page
→ Generate Embedding per Page
→ Qdrant Top-K per Page
→ OCR Verification per Page
→ Confidence per Page
→ Extraction Preview per Page
```

## Required Preview Per Page

- Original Image Preview
- Normalized Image Preview
- Ignore Region Preview
- Layout Skeleton Preview
- Layout Overlay Preview
- Top-K Candidate Preview
- OCR Verification Preview
- ROI Extraction Preview
- Final Confidence Preview

## Summary

Show:

```text
Page 1: PASS
Page 2: PASS
Page 3: WARNING
Document Confidence: 0.88
```

## Admin Can Fix

- sample page adjustment
- fields
- verification settings
- ignore regions
- thresholds
- embeddings
