from typing import Any, Dict, List, Optional

from pydantic import AliasChoices, BaseModel, Field


class ApiResponse(BaseModel):
    ok: bool = True
    data: Dict[str, Any]
    error: Optional[Dict[str, Any]] = None


class RoiRatio(BaseModel):
    page_number: int = Field(..., ge=1)
    x_ratio: float = Field(..., ge=0, le=1)
    y_ratio: float = Field(..., ge=0, le=1)
    width_ratio: float = Field(..., gt=0, le=1)
    height_ratio: float = Field(..., gt=0, le=1)


class PageInput(BaseModel):
    page_number: int = Field(..., ge=1)
    original_image_url: Optional[str] = None
    normalized_image_url: Optional[str] = None


class DocumentUploadRequest(BaseModel):
    uploaded_by: Optional[str] = None
    original_file_url: Optional[str] = None
    pages: List[PageInput] = Field(default_factory=list)


class ExtractFieldSelection(BaseModel):
    template_field_id: str
    page_number: int = Field(..., ge=1)


class ExtractionRequest(BaseModel):
    fields: List[ExtractFieldSelection] = Field(default_factory=list)


class CustomOcrField(BaseModel):
    field_name: str
    display_label: str
    roi: RoiRatio


class CustomOcrRequest(BaseModel):
    document_page_id: Optional[str] = None
    fields: List[CustomOcrField] = Field(default_factory=list)


class TemplateRequestCreate(BaseModel):
    requested_by: Optional[str] = None
    request_title: str
    document_type: Optional[str] = None
    sample_file_url: Optional[str] = None
    request_mode: str = "image_only"
    page_count: int = Field(default=1, ge=1)
    user_note: Optional[str] = None
    pages: List[PageInput] = Field(default_factory=list)


class TemplateRequestUpdate(BaseModel):
    request_title: Optional[str] = None
    document_type: Optional[str] = None
    sample_file_url: Optional[str] = None
    request_mode: Optional[str] = None
    status: Optional[str] = None
    user_note: Optional[str] = None
    admin_note: Optional[str] = None
    page_count: Optional[int] = Field(default=None, ge=1)


class RequestedFieldCreate(BaseModel):
    template_request_page_id: str
    page_number: int = Field(..., ge=1)
    field_name: str
    display_label: str
    roi: RoiRatio
    data_type: Optional[str] = Field(default=None, validation_alias=AliasChoices("data_type", "dataType"))
    extraction_method: Optional[str] = Field(default=None, validation_alias=AliasChoices("extraction_method", "extractionMethod"))
    user_note: Optional[str] = None


class RequestedFieldUpdate(BaseModel):
    field_name: Optional[str] = None
    display_label: Optional[str] = None
    roi: Optional[RoiRatio] = None
    data_type: Optional[str] = Field(default=None, validation_alias=AliasChoices("data_type", "dataType"))
    extraction_method: Optional[str] = Field(default=None, validation_alias=AliasChoices("extraction_method", "extractionMethod"))
    user_note: Optional[str] = None


class TemplateCreate(BaseModel):
    name: str
    document_type: Optional[str] = None
    category: Optional[str] = None
    page_count: int = Field(default=1, ge=1)
    similarity_threshold: float = Field(default=0.75, ge=0, le=1)
    final_confidence_threshold: float = Field(default=0.8, ge=0, le=1)
    created_by: Optional[str] = None


class TemplateUpdate(BaseModel):
    name: Optional[str] = None
    document_type: Optional[str] = None
    category: Optional[str] = None
    status: Optional[str] = None
    page_count: Optional[int] = Field(default=None, ge=1)
    similarity_threshold: Optional[float] = Field(default=None, ge=0, le=1)
    final_confidence_threshold: Optional[float] = Field(default=None, ge=0, le=1)
    rejection_reason: Optional[str] = None


class TemplatePageCreate(BaseModel):
    page_number: int = Field(..., ge=1)
    page_name: Optional[str] = None
    sample_image_url: Optional[str] = None
    normalized_image_url: Optional[str] = None


class TemplatePageUpdate(BaseModel):
    page_number: Optional[int] = Field(default=None, ge=1)
    page_name: Optional[str] = None
    sample_image_url: Optional[str] = None
    normalized_image_url: Optional[str] = None
    similarity_threshold: Optional[float] = Field(default=None, ge=0, le=1)
    final_confidence_threshold: Optional[float] = Field(default=None, ge=0, le=1)


class TemplateFieldCreate(BaseModel):
    template_page_id: str
    page_number: int = Field(..., ge=1)
    field_name: str
    display_label: str
    roi: RoiRatio
    data_type: Optional[str] = None
    user_selectable: bool = True
    default_selected: bool = False
    use_for_verification: bool = False
    expected_text: Optional[str] = None
    match_type: Optional[str] = None
    required_for_verification: bool = False
    extraction_method: str = "fixed_roi"
    anchor_text: Optional[str] = None
    regex_pattern: Optional[str] = None
    roi_padding: Optional[float] = None
    sort_order: int = 0


class TemplateFieldUpdate(BaseModel):
    template_page_id: Optional[str] = None
    page_number: Optional[int] = Field(default=None, ge=1)
    field_name: Optional[str] = None
    display_label: Optional[str] = None
    roi: Optional[RoiRatio] = None
    data_type: Optional[str] = None
    user_selectable: Optional[bool] = None
    default_selected: Optional[bool] = None
    use_for_verification: Optional[bool] = None
    expected_text: Optional[str] = None
    match_type: Optional[str] = None
    required_for_verification: Optional[bool] = None
    extraction_method: Optional[str] = None
    anchor_text: Optional[str] = None
    regex_pattern: Optional[str] = None
    roi_padding: Optional[float] = None
    sort_order: Optional[int] = None


class IgnoreRegionCreate(BaseModel):
    template_page_id: str
    page_number: int = Field(..., ge=1)
    field_name: str
    roi: RoiRatio


class IgnoreRegionUpdate(BaseModel):
    template_page_id: Optional[str] = None
    page_number: Optional[int] = Field(default=None, ge=1)
    field_name: Optional[str] = None
    roi: Optional[RoiRatio] = None


class RejectRequest(BaseModel):
    reason: Optional[str] = None


class TemplateTestRequest(BaseModel):
    original_file_url: Optional[str] = None
    pages: List[PageInput] = Field(default_factory=list)
