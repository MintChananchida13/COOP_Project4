# UI Guidelines

## User Pages

```text
/documents/upload
/documents/:id/detection
/documents/:id/extract
/documents/:id/result
/documents/:id/custom
/template-requests/new
/template-requests
/template-requests/:id
```

## Admin Pages

```text
/admin
/admin/template-requests
/admin/template-requests/:id
/admin/templates
/admin/templates/new
/admin/templates/:id/edit
/admin/templates/:id/test
/admin/settings
```

## Required Components

```text
DocumentPageViewer
PageThumbnailList
PageNavigation
TemplateDetectionResult
SelectableFieldsZone
ExtractionResultZone
CustomOCRStudioPage
TemplateRequestForm
RequestedFieldEditor
MyTemplateRequests
AdminDashboard
TemplateRequestReview
TemplateList
TemplateEditor
TemplatePageList
TemplateInfoPanel
TemplateFieldPanel
IgnoreRegionPanel
EmbeddingPanel
TemplateTestMode
OCRPreviewPanel
ConfidenceScorePanel
LayoutPreviewPanel
LayoutOverlayPreview
```

## Multi-page UI Rules

- Always show current page.
- Provide page thumbnails.
- Group fields by page.
- Group results by page.
- Keep ROI tied to selected page.
- Allow user to continue even if some pages are template_not_found.

## Custom OCR Message

```text
No matching template found. You can manually select areas to OCR.
```
