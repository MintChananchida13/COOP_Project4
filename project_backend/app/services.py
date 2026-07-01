from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import uuid4

from .schemas import (
    CustomOcrRequest,
    DocumentUploadRequest,
    ExtractionRequest,
    IgnoreRegionCreate,
    IgnoreRegionUpdate,
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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stub_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


class PageSplitService:
    def create_document_pages(self, document_id: str, payload: DocumentUploadRequest) -> List[Dict[str, Any]]:
        source_pages = payload.pages or [
            {
                "page_number": 1,
                "original_image_url": payload.original_file_url,
                "normalized_image_url": None,
            }
        ]
        return [
            {
                "id": _stub_id("doc_page"),
                "document_id": document_id,
                "page_number": page.page_number if hasattr(page, "page_number") else page["page_number"],
                "original_image_url": page.original_image_url if hasattr(page, "original_image_url") else page["original_image_url"],
                "normalized_image_url": page.normalized_image_url if hasattr(page, "normalized_image_url") else page["normalized_image_url"],
                "status": "uploaded",
            }
            for page in source_pages
        ]


class ImageProcessingService:
    def normalize_pages(self, pages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [{**page, "status": "preprocessing_pending"} for page in pages]


class ImageEncoderService:
    def encode_page(self, page_id: str) -> Dict[str, Any]:
        return {"page_id": page_id, "status": "embedding_pending", "embedding": None}


class QdrantService:
    def upsert_template_page_point(self, template_id: str, page_id: str) -> Dict[str, Any]:
        return {
            "template_id": template_id,
            "template_page_id": page_id,
            "qdrant_point_id": _stub_id("qdrant_point"),
            "status": "stubbed",
        }


class EmbeddingService:
    def __init__(self) -> None:
        self.encoder = ImageEncoderService()
        self.qdrant = QdrantService()

    def generate_for_template(self, template_id: str) -> Dict[str, Any]:
        return {
            "template_id": template_id,
            "status": "embedding_generation_stubbed",
            "scope": "template",
            "pages": [],
        }

    def generate_for_template_page(self, template_id: str, page_id: str) -> Dict[str, Any]:
        return {
            **self.qdrant.upsert_template_page_point(template_id, page_id),
            "status": "embedding_generation_stubbed",
            "scope": "template_page",
        }


class OCRService:
    def ocr_custom_fields(self, document_id: str, payload: CustomOcrRequest) -> Dict[str, Any]:
        return {
            "document_id": document_id,
            "document_page_id": payload.document_page_id,
            "status": "custom_ocr_stubbed",
            "results": [
                {
                    "page_number": field.roi.page_number,
                    "field_name": field.field_name,
                    "display_label": field.display_label,
                    "ocr_text": None,
                    "ocr_confidence": None,
                    "roi": field.roi.model_dump(),
                }
                for field in payload.fields
            ],
        }


class VerificationService:
    def verify_candidate(self, document_page_id: str, template_page_id: str) -> Dict[str, Any]:
        return {
            "document_page_id": document_page_id,
            "template_page_id": template_page_id,
            "verification_score": None,
            "status": "verification_stubbed",
        }


class ConfidenceService:
    def calculate_page_confidence(self, page_number: int) -> Dict[str, Any]:
        return {
            "page_number": page_number,
            "layout_score": None,
            "verification_score": None,
            "final_score": None,
            "status": "confidence_stubbed",
        }


class TemplateDetectionService:
    def __init__(self) -> None:
        self.confidence = ConfidenceService()

    def detect_document(self, document_id: str) -> Dict[str, Any]:
        return {
            "document_id": document_id,
            "status": "detection_stubbed",
            "pages": [],
            "logs": [],
        }

    def get_detection(self, document_id: str) -> Dict[str, Any]:
        return {
            "document_id": document_id,
            "status": "detection_not_run",
            "pages": [],
        }


class ExtractionService:
    def get_selectable_fields(self, document_id: str, page_id: Optional[str] = None) -> Dict[str, Any]:
        return {
            "document_id": document_id,
            "document_page_id": page_id,
            "fields": [],
            "grouped_by_page": True,
        }

    def extract_selected_fields(self, document_id: str, payload: ExtractionRequest) -> Dict[str, Any]:
        return {
            "document_id": document_id,
            "status": "extraction_stubbed",
            "results": [
                {
                    "page_number": field.page_number,
                    "template_field_id": field.template_field_id,
                    "ocr_text": None,
                    "ocr_confidence": None,
                }
                for field in payload.fields
            ],
        }

    def get_results(self, document_id: str) -> Dict[str, Any]:
        return {"document_id": document_id, "results": [], "grouped_by_page": True}


class DocumentService:
    def __init__(self) -> None:
        self.page_split = PageSplitService()
        self.image_processing = ImageProcessingService()

    def upload(self, payload: DocumentUploadRequest) -> Dict[str, Any]:
        document_id = _stub_id("doc")
        pages = self.page_split.create_document_pages(document_id, payload)
        return {
            "id": document_id,
            "uploaded_by": payload.uploaded_by,
            "original_file_url": payload.original_file_url,
            "status": "uploaded",
            "page_count": len(pages),
            "pages": self.image_processing.normalize_pages(pages),
            "created_at": _now(),
        }

    def get_document(self, document_id: str) -> Dict[str, Any]:
        return {"id": document_id, "status": "stubbed", "pages": []}

    def get_pages(self, document_id: str) -> Dict[str, Any]:
        return {"document_id": document_id, "pages": []}

    def get_page(self, document_id: str, page_id: str) -> Dict[str, Any]:
        return {"document_id": document_id, "id": page_id, "page_number": None, "status": "stubbed"}


class TemplateRequestService:
    def create(self, payload: TemplateRequestCreate) -> Dict[str, Any]:
        request_id = _stub_id("tpl_req")
        return {
            "id": request_id,
            **payload.model_dump(),
            "status": "draft",
            "created_at": _now(),
        }

    def list(self) -> Dict[str, Any]:
        return {"template_requests": []}

    def get(self, request_id: str) -> Dict[str, Any]:
        return {"id": request_id, "status": "stubbed", "pages": [], "requested_fields": []}

    def update(self, request_id: str, payload: TemplateRequestUpdate) -> Dict[str, Any]:
        return {"id": request_id, **payload.model_dump(exclude_unset=True), "updated_at": _now()}

    def delete(self, request_id: str) -> Dict[str, Any]:
        return {"id": request_id, "deleted": True}

    def submit(self, request_id: str) -> Dict[str, Any]:
        return {"id": request_id, "status": "submitted", "submitted_at": _now()}

    def pages(self, request_id: str) -> Dict[str, Any]:
        return {"template_request_id": request_id, "pages": []}

    def add_requested_field(self, request_id: str, payload: RequestedFieldCreate) -> Dict[str, Any]:
        return {"id": _stub_id("req_field"), "template_request_id": request_id, **payload.model_dump()}

    def update_requested_field(
        self, request_id: str, field_id: str, payload: RequestedFieldUpdate
    ) -> Dict[str, Any]:
        return {
            "id": field_id,
            "template_request_id": request_id,
            **payload.model_dump(exclude_unset=True),
            "updated_at": _now(),
        }

    def delete_requested_field(self, request_id: str, field_id: str) -> Dict[str, Any]:
        return {"id": field_id, "template_request_id": request_id, "deleted": True}


class AdminTemplateService:
    def dashboard(self) -> Dict[str, Any]:
        return {"template_count": 0, "pending_request_count": 0, "status": "stubbed"}

    def create_template(self, payload: TemplateCreate) -> Dict[str, Any]:
        return {"id": _stub_id("tpl"), **payload.model_dump(), "status": "draft", "created_at": _now()}

    def list_templates(self) -> Dict[str, Any]:
        return {"templates": []}

    def get_template(self, template_id: str) -> Dict[str, Any]:
        return {"id": template_id, "status": "stubbed", "pages": []}

    def update_template(self, template_id: str, payload: TemplateUpdate) -> Dict[str, Any]:
        return {"id": template_id, **payload.model_dump(exclude_unset=True), "updated_at": _now()}

    def delete_template(self, template_id: str) -> Dict[str, Any]:
        return {"id": template_id, "deleted": True}

    def list_template_pages(self, template_id: str) -> Dict[str, Any]:
        return {"template_id": template_id, "pages": []}

    def create_template_page(self, template_id: str, payload: TemplatePageCreate) -> Dict[str, Any]:
        return {"id": _stub_id("tpl_page"), "template_id": template_id, **payload.model_dump()}

    def update_template_page(
        self, template_id: str, page_id: str, payload: TemplatePageUpdate
    ) -> Dict[str, Any]:
        return {"id": page_id, "template_id": template_id, **payload.model_dump(exclude_unset=True)}

    def delete_template_page(self, template_id: str, page_id: str) -> Dict[str, Any]:
        return {"id": page_id, "template_id": template_id, "deleted": True}

    def create_template_field(self, template_id: str, payload: TemplateFieldCreate) -> Dict[str, Any]:
        return {"id": _stub_id("tpl_field"), "template_id": template_id, **payload.model_dump()}

    def update_template_field(
        self, template_id: str, field_id: str, payload: TemplateFieldUpdate
    ) -> Dict[str, Any]:
        return {"id": field_id, "template_id": template_id, **payload.model_dump(exclude_unset=True)}

    def delete_template_field(self, template_id: str, field_id: str) -> Dict[str, Any]:
        return {"id": field_id, "template_id": template_id, "deleted": True}

    def create_ignore_region(self, template_id: str, payload: IgnoreRegionCreate) -> Dict[str, Any]:
        return {"id": _stub_id("ignore_region"), "template_id": template_id, **payload.model_dump()}

    def update_ignore_region(
        self, template_id: str, region_id: str, payload: IgnoreRegionUpdate
    ) -> Dict[str, Any]:
        return {"id": region_id, "template_id": template_id, **payload.model_dump(exclude_unset=True)}

    def delete_ignore_region(self, template_id: str, region_id: str) -> Dict[str, Any]:
        return {"id": region_id, "template_id": template_id, "deleted": True}

    def start_review(self, request_id: str) -> Dict[str, Any]:
        return {"id": request_id, "status": "in_review", "updated_at": _now()}

    def convert_request_to_template(self, request_id: str) -> Dict[str, Any]:
        return {
            "template_request_id": request_id,
            "converted_template_id": _stub_id("tpl"),
            "status": "conversion_stubbed",
        }

    def reject_request(self, request_id: str, reason: Optional[str]) -> Dict[str, Any]:
        return {"id": request_id, "status": "rejected", "rejection_reason": reason}

    def approve_template(self, template_id: str) -> Dict[str, Any]:
        return {"id": template_id, "status": "approved", "approved_at": _now()}

    def reject_template(self, template_id: str, reason: Optional[str]) -> Dict[str, Any]:
        return {"id": template_id, "status": "rejected", "rejection_reason": reason}

    def test_template(self, template_id: str, payload: TemplateTestRequest) -> Dict[str, Any]:
        return {
            "template_id": template_id,
            "status": "test_mode_stubbed",
            "pages": [
                {
                    "page_number": page.page_number,
                    "layout_preview": None,
                    "layout_overlay_preview": None,
                    "top_k_candidates": [],
                    "verification": None,
                    "confidence": None,
                }
                for page in payload.pages
            ],
        }
