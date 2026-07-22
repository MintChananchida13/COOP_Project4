# Multi-page Support

## Rule

Do not merge pages into one image.

## Upload

Image -> one page.
PDF -> many pages.
Multiple images -> many pages.

## Database

Required page tables:
- document_pages
- template_pages
- template_request_pages

## ROI

Every ROI must include page context.

## Detection

Detection runs per page.

## Layout Signature

Each Template Page has one or more page-level layout signatures.

## UI

All page-aware screens need:
- thumbnails
- page navigation
- current page indicator
- results grouped by page

## Admin

Admin manages:
- Template Pages
- Fields per page
- Verification Anchors per page
- Layout signatures per page
- Test Mode per page
