# Error Handling

## Common Errors

Upload:
- unsupported file
- file too large
- PDF conversion failed
- page conversion failed

Preprocessing:
- document boundary not found
- blurry image
- perspective correction failed

Detection:
- layout matcher unavailable
- no candidates
- low similarity
- required verification failed
- page mismatch

OCR:
- OCR unavailable
- ROI out of bounds
- empty OCR result

Admin:
- approval without layout signature
- no verification anchor
- invalid ROI
- missing template page

## Fallback

If template is not found, route to Custom OCR Studio.
