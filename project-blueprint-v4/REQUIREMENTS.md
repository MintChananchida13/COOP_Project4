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
- Draw Template Fields per page.
- Mark Template Fields as Verification Fields.
- Draw Ignore Regions per page.
- Generate layout embeddings.
- Run Template Test Mode.
- Approve, reject, disable, duplicate, or delete templates.

### AI

- Split PDFs into pages.
- Preprocess images.
- Generate layout embeddings.
- Search Qdrant Top-K.
- OCR verification fields.
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
- Extensible Image Encoder abstraction.
