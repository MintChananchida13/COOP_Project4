# API Design

## Document APIs

```text
POST /documents/upload
GET /documents/{id}
GET /documents/{id}/pages
GET /documents/{id}/pages/{pageId}
POST /documents/{id}/detect-template
GET /documents/{id}/detection
GET /documents/{id}/selectable-fields
GET /documents/{id}/pages/{pageId}/selectable-fields
POST /documents/{id}/extract
GET /documents/{id}/results
POST /documents/{id}/custom-ocr
```

## Template Request APIs

```text
POST /template-requests
GET /template-requests
GET /template-requests/{id}
PUT /template-requests/{id}
DELETE /template-requests/{id}
POST /template-requests/{id}/submit
GET /template-requests/{id}/pages
POST /template-requests/{id}/requested-fields
PUT /template-requests/{id}/requested-fields/{fieldId}
DELETE /template-requests/{id}/requested-fields/{fieldId}
```

## Admin APIs

```text
GET /admin/dashboard

GET /admin/template-requests
GET /admin/template-requests/{id}
POST /admin/template-requests/{id}/start-review
POST /admin/template-requests/{id}/convert-to-template
POST /admin/template-requests/{id}/reject

POST /admin/templates
GET /admin/templates
GET /admin/templates/{id}
PUT /admin/templates/{id}
DELETE /admin/templates/{id}

GET /admin/templates/{id}/pages
POST /admin/templates/{id}/pages
PUT /admin/templates/{id}/pages/{pageId}
DELETE /admin/templates/{id}/pages/{pageId}

POST /admin/templates/{id}/fields
PUT /admin/templates/{id}/fields/{fieldId}
DELETE /admin/templates/{id}/fields/{fieldId}

POST /admin/templates/{id}/ignore-regions
PUT /admin/templates/{id}/ignore-regions/{regionId}
DELETE /admin/templates/{id}/ignore-regions/{regionId}

POST /admin/templates/{id}/generate-layout-embedding
POST /admin/templates/{id}/pages/{pageId}/generate-layout-embedding
POST /admin/templates/{id}/test
POST /admin/templates/{id}/approve
POST /admin/templates/{id}/reject
```

## Error Shape

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "ROI is outside image boundary",
    "details": {}
  }
}
```
