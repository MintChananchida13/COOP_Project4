Implement Phase 1: Database.

Create/update schema for:
- templates
- template_pages
- template_fields
- ignore_regions
- template_requests
- template_request_pages
- requested_fields
- documents
- document_pages
- extraction_results
- detection_logs

Rules:
- ROI fields are ratios.
- ROI includes page_number.
- No verification_fields table.
- No extraction_fields table.
- Qdrant point belongs to template_page.
Stop after this phase.
