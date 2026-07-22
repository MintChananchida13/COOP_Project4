# Service Design

## PageSplitService

- Convert PDF to page images.
- Create document pages.
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

## LayoutSignatureService

- Apply Ignore Regions per page.
- Generate layout preview.
- Generate PP-DocLayoutV3 layout signature.
- Store layout signature per template reference/page.
- Search layout candidates.
- Regenerate layout signature when a reference page changes.

## TemplateDetectionService

- Detect template per page.
- Retrieve layout candidates.
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
- Text anchor validation.
- Image category validation with SigLIP.
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
- Generate layout signatures.
- Test template.
- Approve/reject template.
