# Project Memory

## Project Name

Intelligent Document Template Management System

## Main Goal

Detect document templates by layout signatures, verify using anchors, and extract only selected ROI fields.

## Core Principles

- Layout first, OCR second.
- Never OCR the whole document by default.
- Template means layout, not personal data.
- Verification Anchors are separate from Extraction Fields.
- Extraction Fields are returned to the user.
- ROI is stored as ratios.
- ROI must include page context.
- Ignore Regions mask dynamic content before layout signature generation.
- Template references store page-level layout signatures.
- Custom OCR is fallback when no template is found.
- Admin must test templates before approval.
- Multi-page documents are first-class.

## Existing Components

Reuse/refactor:
- UploadZone.tsx
- AdjustZone.tsx
- WorkspaceZone.tsx
- GroundTruthEditorZone.tsx

## Never Remove

- Relative ROI
- Multi-page support
- OCR Verification
- Confidence Engine
- Template Test Mode
- Layout Preview
- Layout Overlay Preview
- Custom OCR fallback
- User Template Request
