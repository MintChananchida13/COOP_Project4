# Requirements

## Functional Requirements

### User

- Upload image, PDF, or multiple images.
- View document pages.
- Detect template automatically.
- See template detection result per page.
- Select fields to extract.
- OCR selected fields only.
- Use Custom OCR if no template is found.
- Draw ROI manually in Custom OCR.
- Submit Template Request.
- View Template Request status.
- Export OCR results.

### Admin

- View dashboard.
- Review Template Requests.
- Convert request to Template.
- Create Template manually.
- Create/manage Template Pages.
- Adjust sample images.
- Draw Extraction Fields per page.
- Create Verification Anchors per page.
- Generate layout signatures.
- Run Template Test Mode.
- Approve, reject, disable, duplicate, or delete templates.

### AI

- Split PDFs into pages.
- Preprocess images.
- Generate layout signatures.
- Search layout candidates.
- Run verification anchors.
- Calculate confidence.
- Extract selected ROI.

## Non-Functional Requirements

- Modular architecture.
- Page-aware data model.
- Type-safe code.
- Error handling.
- Loading states.
- Logs for detection failures.
- Privacy-aware OCR handling.
- Scalable for many templates.
- Extensible model adapter abstraction.
