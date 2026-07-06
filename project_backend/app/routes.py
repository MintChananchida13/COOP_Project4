from fastapi import APIRouter

from .schemas import (
    ApiResponse,
    CustomOcrRequest,
    DocumentUploadRequest,
    ExtractionRequest,
    IgnoreRegionCreate,
    IgnoreRegionUpdate,
    RejectRequest,
    RequestedFieldCreate,
    RequestedFieldUpdate,
    TemplateCreate,
    TemplateFieldCreate,
    TemplateFieldUpdate,
    TemplatePageCreate,
    TemplatePageUpdate,
    TemplateRequestCreate,
    TemplateRequestUpdate,
    TemplateTestRequest,
    TemplateUpdate,
)
from .services import (
    AdminTemplateService,
    DocumentService,
    EmbeddingService,
    ExtractionService,
    OCRService,
    TemplateDetectionService,
    TemplateRequestService,
)

router = APIRouter()

documents = DocumentService()
detection = TemplateDetectionService()
extraction = ExtractionService()
custom_ocr = OCRService()
template_requests = TemplateRequestService()
admin_templates = AdminTemplateService()
embeddings = EmbeddingService()


def ok(data: dict) -> ApiResponse:
    return ApiResponse(data=data)


@router.post("/documents/upload", response_model=ApiResponse)
def upload_document(payload: DocumentUploadRequest) -> ApiResponse:
    return ok(documents.upload(payload))


@router.get("/documents/{document_id}", response_model=ApiResponse)
def get_document(document_id: str) -> ApiResponse:
    return ok(documents.get_document(document_id))


@router.get("/documents/{document_id}/pages", response_model=ApiResponse)
def get_document_pages(document_id: str) -> ApiResponse:
    return ok(documents.get_pages(document_id))


@router.get("/documents/{document_id}/pages/{page_id}", response_model=ApiResponse)
def get_document_page(document_id: str, page_id: str) -> ApiResponse:
    return ok(documents.get_page(document_id, page_id))


@router.post("/documents/{document_id}/detect-template", response_model=ApiResponse)
def detect_template(document_id: str) -> ApiResponse:
    return ok(detection.detect_document(document_id))


@router.get("/documents/{document_id}/detection", response_model=ApiResponse)
def get_detection(document_id: str) -> ApiResponse:
    return ok(detection.get_detection(document_id))


@router.get("/documents/{document_id}/selectable-fields", response_model=ApiResponse)
def get_selectable_fields(document_id: str) -> ApiResponse:
    return ok(extraction.get_selectable_fields(document_id))


@router.get("/documents/{document_id}/pages/{page_id}/selectable-fields", response_model=ApiResponse)
def get_page_selectable_fields(document_id: str, page_id: str) -> ApiResponse:
    return ok(extraction.get_selectable_fields(document_id, page_id))


@router.post("/documents/{document_id}/extract", response_model=ApiResponse)
def extract_fields(document_id: str, payload: ExtractionRequest) -> ApiResponse:
    return ok(extraction.extract_selected_fields(document_id, payload))


@router.get("/documents/{document_id}/results", response_model=ApiResponse)
def get_results(document_id: str) -> ApiResponse:
    return ok(extraction.get_results(document_id))


@router.post("/documents/{document_id}/custom-ocr", response_model=ApiResponse)
def run_custom_ocr(document_id: str, payload: CustomOcrRequest) -> ApiResponse:
    return ok(custom_ocr.ocr_custom_fields(document_id, payload))


@router.post("/template-requests", response_model=ApiResponse)
def create_template_request(payload: TemplateRequestCreate) -> ApiResponse:
    return ok(template_requests.create(payload))


@router.get("/template-requests", response_model=ApiResponse)
def list_template_requests() -> ApiResponse:
    return ok(template_requests.list())


@router.get("/template-requests/{request_id}", response_model=ApiResponse)
def get_template_request(request_id: str) -> ApiResponse:
    return ok(template_requests.get(request_id))


@router.put("/template-requests/{request_id}", response_model=ApiResponse)
def update_template_request(request_id: str, payload: TemplateRequestUpdate) -> ApiResponse:
    return ok(template_requests.update(request_id, payload))


@router.delete("/template-requests/{request_id}", response_model=ApiResponse)
def delete_template_request(request_id: str) -> ApiResponse:
    return ok(template_requests.delete(request_id))


@router.post("/template-requests/{request_id}/submit", response_model=ApiResponse)
def submit_template_request(request_id: str) -> ApiResponse:
    return ok(template_requests.submit(request_id))


@router.get("/template-requests/{request_id}/pages", response_model=ApiResponse)
def get_template_request_pages(request_id: str) -> ApiResponse:
    return ok(template_requests.pages(request_id))


@router.post("/template-requests/{request_id}/requested-fields", response_model=ApiResponse)
def create_requested_field(request_id: str, payload: RequestedFieldCreate) -> ApiResponse:
    return ok(template_requests.add_requested_field(request_id, payload))


@router.put("/template-requests/{request_id}/requested-fields/{field_id}", response_model=ApiResponse)
def update_requested_field(
    request_id: str, field_id: str, payload: RequestedFieldUpdate
) -> ApiResponse:
    return ok(template_requests.update_requested_field(request_id, field_id, payload))


@router.delete("/template-requests/{request_id}/requested-fields/{field_id}", response_model=ApiResponse)
def delete_requested_field(request_id: str, field_id: str) -> ApiResponse:
    return ok(template_requests.delete_requested_field(request_id, field_id))


@router.get("/admin/dashboard", response_model=ApiResponse)
def admin_dashboard() -> ApiResponse:
    return ok(admin_templates.dashboard())


@router.get("/admin/template-requests", response_model=ApiResponse)
def admin_list_template_requests() -> ApiResponse:
    return ok(template_requests.list())


@router.get("/admin/template-requests/{request_id}", response_model=ApiResponse)
def admin_get_template_request(request_id: str) -> ApiResponse:
    return ok(template_requests.get(request_id))


@router.post("/admin/template-requests/{request_id}/start-review", response_model=ApiResponse)
def admin_start_review(request_id: str) -> ApiResponse:
    return ok(admin_templates.start_review(request_id))


@router.post("/admin/template-requests/{request_id}/convert-to-template", response_model=ApiResponse)
def admin_convert_request_to_template(request_id: str) -> ApiResponse:
    return ok(admin_templates.convert_request_to_template(request_id))


@router.post("/admin/template-requests/{request_id}/reject", response_model=ApiResponse)
def admin_reject_template_request(request_id: str, payload: RejectRequest) -> ApiResponse:
    return ok(template_requests.reject(request_id, payload.reason))


@router.post("/admin/templates", response_model=ApiResponse)
def create_template(payload: TemplateCreate) -> ApiResponse:
    return ok(admin_templates.create_template(payload))


@router.get("/admin/templates", response_model=ApiResponse)
def list_templates() -> ApiResponse:
    return ok(admin_templates.list_templates())


@router.get("/admin/templates/{template_id}", response_model=ApiResponse)
def get_template(template_id: str) -> ApiResponse:
    return ok(admin_templates.get_template(template_id))


@router.put("/admin/templates/{template_id}", response_model=ApiResponse)
def update_template(template_id: str, payload: TemplateUpdate) -> ApiResponse:
    return ok(admin_templates.update_template(template_id, payload))


@router.delete("/admin/templates/{template_id}", response_model=ApiResponse)
def delete_template(template_id: str) -> ApiResponse:
    return ok(admin_templates.delete_template(template_id))


@router.get("/admin/templates/{template_id}/pages", response_model=ApiResponse)
def list_template_pages(template_id: str) -> ApiResponse:
    return ok(admin_templates.list_template_pages(template_id))


@router.post("/admin/templates/{template_id}/pages", response_model=ApiResponse)
def create_template_page(template_id: str, payload: TemplatePageCreate) -> ApiResponse:
    return ok(admin_templates.create_template_page(template_id, payload))


@router.put("/admin/templates/{template_id}/pages/{page_id}", response_model=ApiResponse)
def update_template_page(template_id: str, page_id: str, payload: TemplatePageUpdate) -> ApiResponse:
    return ok(admin_templates.update_template_page(template_id, page_id, payload))


@router.delete("/admin/templates/{template_id}/pages/{page_id}", response_model=ApiResponse)
def delete_template_page(template_id: str, page_id: str) -> ApiResponse:
    return ok(admin_templates.delete_template_page(template_id, page_id))


@router.post("/admin/templates/{template_id}/fields", response_model=ApiResponse)
def create_template_field(template_id: str, payload: TemplateFieldCreate) -> ApiResponse:
    return ok(admin_templates.create_template_field(template_id, payload))


@router.put("/admin/templates/{template_id}/fields/{field_id}", response_model=ApiResponse)
def update_template_field(template_id: str, field_id: str, payload: TemplateFieldUpdate) -> ApiResponse:
    return ok(admin_templates.update_template_field(template_id, field_id, payload))


@router.delete("/admin/templates/{template_id}/fields/{field_id}", response_model=ApiResponse)
def delete_template_field(template_id: str, field_id: str) -> ApiResponse:
    return ok(admin_templates.delete_template_field(template_id, field_id))


@router.post("/admin/templates/{template_id}/ignore-regions", response_model=ApiResponse)
def create_ignore_region(template_id: str, payload: IgnoreRegionCreate) -> ApiResponse:
    return ok(admin_templates.create_ignore_region(template_id, payload))


@router.put("/admin/templates/{template_id}/ignore-regions/{region_id}", response_model=ApiResponse)
def update_ignore_region(
    template_id: str, region_id: str, payload: IgnoreRegionUpdate
) -> ApiResponse:
    return ok(admin_templates.update_ignore_region(template_id, region_id, payload))


@router.delete("/admin/templates/{template_id}/ignore-regions/{region_id}", response_model=ApiResponse)
def delete_ignore_region(template_id: str, region_id: str) -> ApiResponse:
    return ok(admin_templates.delete_ignore_region(template_id, region_id))


@router.post("/admin/templates/{template_id}/generate-layout-embedding", response_model=ApiResponse)
def generate_template_embedding(template_id: str) -> ApiResponse:
    return ok(embeddings.generate_for_template(template_id))


@router.post("/admin/templates/{template_id}/pages/{page_id}/generate-layout-embedding", response_model=ApiResponse)
def generate_template_page_embedding(template_id: str, page_id: str) -> ApiResponse:
    return ok(embeddings.generate_for_template_page(template_id, page_id))


@router.post("/admin/templates/{template_id}/test", response_model=ApiResponse)
def test_template(template_id: str, payload: TemplateTestRequest) -> ApiResponse:
    return ok(admin_templates.test_template(template_id, payload))


@router.post("/admin/templates/{template_id}/approve", response_model=ApiResponse)
def approve_template(template_id: str) -> ApiResponse:
    return ok(admin_templates.approve_template(template_id))


@router.post("/admin/templates/{template_id}/reject", response_model=ApiResponse)
def reject_template(template_id: str, payload: RejectRequest) -> ApiResponse:
    return ok(admin_templates.reject_template(template_id, payload.reason))
