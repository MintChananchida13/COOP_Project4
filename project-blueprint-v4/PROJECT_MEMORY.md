# Project Memory

## Project Name

Intelligent Document Template Management System

## Main Goal

Detect document templates by layout using Image Encoder/DINOv2 and Qdrant, verify using OCR, and extract only selected ROI fields.

## Core Principles

- Layout first, OCR second.
- Never OCR the whole document by default.
- Template means layout, not personal data.
- Verification Field is a Template Field.
- Extraction Field is a Template Field.
- ROI is stored as ratios.
- ROI must include page context.
- Ignore Regions mask dynamic content before embedding.
- Qdrant stores template page embeddings.
- Custom OCR is fallback when no template is found.
- Admin must test templates before approval.
- Multi-page documents are first-class.

## Existing Components

Reuse/refactor:
- UploadZone.tsx
- AdjustZone.tsx
- WorkspaceZone.tsx
- GroundTruthEditorZone.tsx → OCRReviewZone.tsx

## Never Remove

- Relative ROI
- Multi-page support
- Ignore Regions
- OCR Verification
- Confidence Engine
- Template Test Mode
- Layout Preview
- Layout Overlay Preview
- Custom OCR fallback
- User Template Request
