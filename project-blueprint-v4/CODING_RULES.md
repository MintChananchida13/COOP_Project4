# Coding Rules

## General

- Follow existing project architecture.
- Prefer refactoring over rewriting.
- Keep business logic in services.
- Keep UI components focused.
- Avoid hardcoded document-specific logic.
- Never remove existing working Custom OCR flow.
- Add loading, empty, and error states.

## Type Safety

Avoid `any` when possible.

Create shared types:
- Template
- TemplatePage
- TemplateField
- IgnoreRegion
- TemplateRequest
- RequestedField
- Document
- DocumentPage
- ROI
- OCRResult
- DetectionResult
- ConfidenceResult

## ROI Rules

All ROI must be page-aware:

```ts
type RoiRatio = {
  pageNumber: number;
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
}
```

## Backend Rules

- Controllers/routes only handle HTTP.
- Services handle business logic.
- Repositories/models handle data.
- AI integrations must be behind service interfaces.

## Frontend Rules

- WorkspaceZone must support modes.
- WorkspaceZone must preserve page context.
- OCRReviewZone should not mention Ground Truth unless dataset mode exists.
- Page navigation must not lose ROI.
