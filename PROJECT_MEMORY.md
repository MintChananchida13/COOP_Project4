# PROJECT_MEMORY.md

# Intelligent Document Template Management System

## Project Goal

Build a production-ready OCR platform that detects document templates by document layout, verifies them using OCR, and extracts only user-selected information.

The system must support any structured document (ID cards, passports, invoices, receipts, forms, certificates, etc.) without hardcoding any document type.

---

# Core Workflow

Upload Document

↓

Split into Pages

↓

Image Preprocessing

↓

Generate Layout Embedding

↓

Qdrant Top-K Search

↓

OCR Verification

↓

Confidence Engine

↓

Template Found?

├── YES → Show Selectable Fields → OCR Selected ROI → Result

└── NO → Custom OCR → Optional Template Request

---

# Core Principles

## 1. Layout First

Document templates are identified by layout, not by OCR.

---

## 2. OCR Second

OCR is used only for:

- Verification Fields
- User-selected Extraction Fields
- Custom OCR

Never OCR the entire document by default.

---

## 3. Relative ROI

Store ROI as ratios.

Never store pixel coordinates.

Every ROI must include:

- page_number
- x_ratio
- y_ratio
- width_ratio
- height_ratio

---

## 4. Multi-page Support

Everything must support:

- Single image
- PDF
- Multiple images

Detection, Extraction, Template Request, Admin Editor and Test Mode must all be page-aware.

---

## 5. Template Fields

Use only one table:

template_fields

Verification Fields are Template Fields where:

use_for_verification = true

Do not create separate verification_fields or extraction_fields tables.

---

## 6. Ignore Regions

Ignore Regions mask dynamic content before generating layout embeddings.

Their purpose is to preserve document structure while ignoring personal information.

---

## 7. Image Encoder

Use ImageEncoderService.

Default implementation:

DINOv2

Do not hardcode the model throughout the project.

---

## 8. Qdrant

Each Template Page generates one embedding.

One Qdrant point represents one Template Page.

---

## 9. Template Detection

Detection pipeline:

Layout Embedding

↓

Qdrant Top-K

↓

OCR Verification

↓

Confidence Engine

↓

Template Confirmation

---

## 10. Extraction

After template confirmation:

- Show selectable fields.
- User selects fields.
- OCR only selected ROI.

---

## 11. Custom OCR

If no template is confirmed:

- Open Custom OCR Studio.
- User manually draws ROI.
- OCR selected ROI.
- User may submit a Template Request.

---

## 12. Admin Workflow

Review Request

↓

Create Template

↓

Create Template Pages

↓

Adjust Sample Pages

↓

Create Template Fields

↓

Mark Verification Fields

↓

Create Ignore Regions

↓

Generate Embeddings

↓

Run Test Mode

↓

Approve / Reject

---

# Existing Components

Reuse and refactor whenever possible:

- UploadZone.tsx
- AdjustZone.tsx
- WorkspaceZone.tsx
- GroundTruthEditorZone.tsx → OCRReviewZone.tsx

WorkspaceZone must support:

- custom_roi
- template_field
- ignore_region

---

# Required Services

- PageSplitService
- ImageProcessingService
- ImageEncoderService
- EmbeddingService
- QdrantService
- OCRService
- VerificationService
- ConfidenceService
- TemplateDetectionService
- ExtractionService
- AdminTemplateService

---

# Coding Rules

- Keep the architecture unchanged.
- Prefer refactoring over rewriting.
- Keep AI logic inside services.
- Do not hardcode document types.
- Preserve page context in every ROI and OCR result.

---

# Never Remove

- Relative ROI
- Multi-page Support
- Ignore Regions
- OCR Verification
- Confidence Engine
- Template Test Mode
- Layout Preview
- Layout Overlay Preview
- Custom OCR
- Template Request
- Admin Approval
- Qdrant Search
- Image Encoder
- Selectable Extraction Fields