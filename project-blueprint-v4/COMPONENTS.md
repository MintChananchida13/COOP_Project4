# Component Design

## DocumentPageViewer

```text
DocumentPageViewer
├── PageThumbnailList
├── PageNavigation
└── CurrentPagePreview
```

Responsibilities:
- Show page thumbnails.
- Track selected page.
- Preserve page context.
- Pass selected page to WorkspaceZone.

## WorkspaceZone

Modes:
- custom_roi
- template_field
- ignore_region

Must output ROI with:
- page_number
- roi ratios
- label/name
- mode

## OCRReviewZone

Replacement for GroundTruthEditorZone.

Responsibilities:
- Show ROI preview.
- Show OCR text.
- Allow correction if needed.
- Do not use Ground Truth wording unless dataset mode exists.

## TemplateEditor

```text
TemplateEditor
├── TemplateInfoPanel
├── TemplatePageList
├── AdjustZone
├── WorkspaceZone(mode="template_field")
├── TemplateFieldPanel
├── WorkspaceZone(mode="ignore_region")
├── IgnoreRegionPanel
├── EmbeddingPanel
├── TemplateTestMode
└── ApproveRejectPanel
```

## TemplateTestMode

```text
TemplateTestMode
├── TestImageUpload
├── DocumentPageViewer
├── LayoutPreviewPanel
├── LayoutOverlayPreview
├── TopKCandidatePanel
├── OCRVerificationPreview
├── ROIExtractionPreview
└── ConfidenceScorePanel
```
