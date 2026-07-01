# Service Design

## PageSplitService

- Convert PDF to page images.
- Create document_pages.
- Preserve page order.
- Support multiple image upload.

## ImageProcessingService

- Detect document boundary.
- Crop document.
- Correct perspective.
- Deskew image.
- Resize image.
- Normalize brightness/contrast.
- Convert ROI ratio to pixels.
- Convert ROI pixels to ratio.

## EmbeddingService

- Apply Ignore Regions per page.
- Generate layout preview.
- Generate Image Encoder/DINOv2 embedding.
- Store embedding in Qdrant.
- Search Qdrant Top-K.
- Delete/update Qdrant point.

## TemplateDetectionService

- Detect template per page.
- Retrieve candidates.
- Verify candidates.
- Rank candidates.
- Return confirmed template/page or not found.

## OCRService

- OCR ROI.
- OCR multiple ROI.
- OCR custom ROI.
- Preprocess ROI.
- Cache OCR result if feasible.

## VerificationService

- Exact match.
- Contains match.
- Fuzzy match.
- Required field validation.
- Verification score.

## ConfidenceService

- Calculate page confidence.
- Calculate document confidence.
- Accept/reject candidate.

## ExtractionService

- Get selectable fields by page.
- Extract selected fields.
- Fixed ROI extraction.
- Local anchor extraction.
- Regex extraction.
- Postprocess OCR text.

## AdminTemplateService

- Create template.
- Create template pages.
- Convert request to template.
- Validate approval.
- Generate embeddings.
- Test template.
- Approve/reject template.
