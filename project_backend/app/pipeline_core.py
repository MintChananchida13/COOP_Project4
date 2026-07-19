import os
from dataclasses import asdict, dataclass
from typing import Any, Dict


@dataclass(frozen=True)
class PipelineCoreConfig:
    version: str = "layout-signature-v1"
    layout_analyzer: str = "pp_doclayout_v3"
    text_detector: str = "pp_ocrv5_server_det"
    ocr_engine: str = "paddle_thai_ocr"
    ocr_model: str = "th_PP-OCRv5_mobile_rec"
    image_embedding: str = "dinov2"
    template_matcher: str = "layout_signature_sql"
    alignment_engine: str = "layout_signature_alignment_with_orb_fallback"
    roi_refiner: str = "adaptive_roi"
    model_runtime: str = "local"
    model_service_url: str = ""

    def to_debug_dict(self) -> Dict[str, Any]:
        return asdict(self)


def get_pipeline_core_config() -> PipelineCoreConfig:
    model_service_url = os.getenv("MODEL_SERVICE_URL", "").strip()
    return PipelineCoreConfig(
        image_embedding=os.getenv("VISION_EMBEDDING_MODE", "dinov2").strip().lower() or "dinov2",
        model_runtime="model_service" if model_service_url else "local",
        model_service_url=model_service_url,
        ocr_model=os.getenv("PADDLE_THAI_OCR_MODEL_NAME", "th_PP-OCRv5_mobile_rec"),
    )
