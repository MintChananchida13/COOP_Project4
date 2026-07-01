# Template Request

## User Request Modes

### image_only

User uploads sample image/PDF only.

Admin creates all fields manually.

### image_with_roi

User uploads sample image/PDF and draws requested ROI per page.

Requested ROI becomes draft fields for Admin.

## Request Data

- request title
- document type
- sample file
- page count
- user note
- requested fields per page

## Admin Review

Admin can:
- start review
- reject
- convert to template

When converted:
- template is created
- template_pages are created
- requested_fields can be copied to template_fields as draft fields
