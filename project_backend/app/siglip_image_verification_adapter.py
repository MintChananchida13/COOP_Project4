from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .model_runtime_client import ModelRuntimeUnavailableError, remote_verify_image_category


SIGLIP_MODEL_NAME = "google/siglip-so400m-patch14-384"
SIGLIP_VERSION = "siglip-image-category-v1"
DEFAULT_SIGLIP_IMAGE_CATEGORY_THRESHOLD = 0.70

IMAGE_CATEGORY_THRESHOLDS: Dict[str, float] = {
    "company_logo": 0.50,
    "official_stamp": 0.50,
    "signature": 0.45,
    "qr_code": 0.55,
    "barcode": 0.55,
    "portrait": 0.45,
    "government_emblem": 0.40,
    "thailand_symbol": 0.40,
    "other": 0.35,
}

IMAGE_CATEGORY_PROMPTS: Dict[str, str] = {
    "company_logo": "This is a company logo.",
    "official_stamp": "This is an official ink stamp.",
    "signature": "This is a handwritten signature.",
    "qr_code": "This is a QR code.",
    "barcode": "This is a barcode.",
    "portrait": "This is a portrait photograph of a person.",
    "government_emblem": "This is the Thai Garuda government emblem.",
    "thailand_symbol": "This is a symbol of Thailand.",
    "other": "This is another type of image on a document.",
}

IMAGE_CATEGORY_LABELS_TH: Dict[str, str] = {
    "company_logo": "โลโก้บริษัท",
    "official_stamp": "ตราประทับ",
    "signature": "ลายเซ็น",
    "qr_code": "QR Code",
    "barcode": "บาร์โค้ด",
    "portrait": "รูปถ่ายบุคคล",
    "government_emblem": "ตราครุฑ",
    "thailand_symbol": "สัญลักษณ์ประเทศไทย",
    "other": "อื่น ๆ",
}

_THAI_TO_CATEGORY = {label: key for key, label in IMAGE_CATEGORY_LABELS_TH.items()}
_ALIASES = {
    # Company Logo
    "logo": "company_logo",
    "company logo": "company_logo",
    "corporate logo": "company_logo",
    "business logo": "company_logo",

    # Official Stamp
    "stamp": "official_stamp",
    "official stamp": "official_stamp",
    "ink stamp": "official_stamp",
    "seal": "official_stamp",

    # Signature
    "signature": "signature",
    "handwritten signature": "signature",
    "autograph": "signature",

    # QR Code
    "qr": "qr_code",
    "qr code": "qr_code",
    "qrcode": "qr_code",

    # Barcode
    "barcode": "barcode",
    "bar code": "barcode",

    # Portrait
    "photo": "portrait",
    "portrait": "portrait",
    "portrait photograph": "portrait",
    "portrait photo": "portrait",
    "person photo": "portrait",

    # Government Emblem
    "emblem": "government_emblem",
    "government emblem": "government_emblem",
    "thai garuda": "government_emblem",
    "garuda": "government_emblem",
    
    "thailand": "thailand_symbol",
    "thailand symbol": "thailand_symbol",
    "symbol of thailand": "thailand_symbol",
    "thai symbol": "thailand_symbol",

    # Other
    "other": "other",
}

_SIGLIP_PROCESSOR = None
_SIGLIP_MODEL = None
_SIGLIP_DEVICE: Optional[str] = None


@dataclass
class SiglipImageVerificationResult:
    score: float
    passed: bool
    image_category: str
    image_category_label: str
    prompt: str
    predicted_category: str
    predicted_label: str
    predicted_prompt: str
    target_rank: int
    score_margin: float
    verification_threshold: float
    model_name: str
    version: str
    device: str
    labels: List[Dict[str, Any]]


def normalize_image_category(value: Optional[str]) -> str:
    raw = str(value or "").strip()
    if not raw:
        return "other"
    if raw in IMAGE_CATEGORY_PROMPTS:
        return raw
    if raw in _THAI_TO_CATEGORY:
        return _THAI_TO_CATEGORY[raw]
    return _ALIASES.get(raw.lower(), "other")


def image_category_prompt(value: Optional[str]) -> str:
    return IMAGE_CATEGORY_PROMPTS[normalize_image_category(value)]


def image_category_label(value: Optional[str]) -> str:
    return IMAGE_CATEGORY_LABELS_TH[normalize_image_category(value)]


def image_category_threshold(value: Optional[str], default: float = DEFAULT_SIGLIP_IMAGE_CATEGORY_THRESHOLD) -> float:
    category = normalize_image_category(value)
    category_env_key = f"SIGLIP_IMAGE_CATEGORY_THRESHOLD_{category.upper()}"
    for env_key in (category_env_key, "SIGLIP_IMAGE_CATEGORY_THRESHOLD"):
        raw = os.getenv(env_key)
        if raw is None or not raw.strip():
            continue
        try:
            return float(raw)
        except (TypeError, ValueError):
            continue
    return IMAGE_CATEGORY_THRESHOLDS.get(category, default)


def verify_image_category(image_path: str, image_category: Optional[str], threshold: float = 0.70) -> SiglipImageVerificationResult:
    category = normalize_image_category(image_category)
    configured_threshold = image_category_threshold(category, threshold)
    runtime_configured = (
        os.getenv("MODEL_RUNTIME_ROLE", "").strip().lower() != "service"
        and bool(os.getenv("MODEL_SERVICE_URL", "").strip())
    )
    try:
        remote_result = remote_verify_image_category(image_path, category)
    except ModelRuntimeUnavailableError as error:
        if runtime_configured:
            raise RuntimeError(f"SigLIP model runtime unavailable: {error}") from error
        remote_result = None

    if remote_result:
        score = round(float(remote_result.get("score") or 0.0), 4)
        normalized_category = normalize_image_category(str(remote_result.get("image_category") or category))
        labels = list(remote_result.get("labels") or [])
        predicted_category = normalize_image_category(str(remote_result.get("predicted_category") or ""))
        if not predicted_category or predicted_category == "other":
            top_label = labels[0] if labels else {}
            predicted_category = normalize_image_category(str(top_label.get("image_category") or normalized_category))
        target_rank = int(remote_result.get("target_rank") or 0)
        if not target_rank and labels:
            target_rank = next(
                (index + 1 for index, item in enumerate(labels) if item.get("image_category") == normalized_category),
                len(labels),
            )
        result_threshold = round(float(remote_result.get("verification_threshold") or configured_threshold), 4)
        return SiglipImageVerificationResult(
            score=score,
            passed=bool(remote_result.get("passed")) if "passed" in remote_result else (score >= result_threshold and target_rank == 1),
            image_category=normalized_category,
            image_category_label=image_category_label(normalized_category),
            prompt=str(remote_result.get("prompt") or image_category_prompt(normalized_category)),
            predicted_category=predicted_category,
            predicted_label=str(remote_result.get("predicted_label") or image_category_label(predicted_category)),
            predicted_prompt=str(remote_result.get("predicted_prompt") or image_category_prompt(predicted_category)),
            target_rank=target_rank,
            score_margin=round(float(remote_result.get("score_margin") or 0.0), 4),
            verification_threshold=result_threshold,
            model_name=str(remote_result.get("model_name") or SIGLIP_MODEL_NAME),
            version=str(remote_result.get("version") or SIGLIP_VERSION),
            device=str(remote_result.get("device") or "remote"),
            labels=labels,
        )

    return _verify_image_category_local(image_path, category, configured_threshold)


def _load_siglip_runtime():
    global _SIGLIP_PROCESSOR, _SIGLIP_MODEL, _SIGLIP_DEVICE
    try:
        import torch
        from PIL import Image
        from transformers import AutoModelForZeroShotImageClassification, AutoProcessor
    except ImportError as error:
        raise RuntimeError("SigLIP image verification requires torch, transformers and pillow.") from error

    if _SIGLIP_PROCESSOR is None or _SIGLIP_MODEL is None or _SIGLIP_DEVICE is None:
        _SIGLIP_PROCESSOR = AutoProcessor.from_pretrained(SIGLIP_MODEL_NAME)
        device_map = os.getenv("SIGLIP_DEVICE_MAP", "").strip()
        device = os.getenv("SIGLIP_DEVICE", "").strip().lower() or ("cuda" if torch.cuda.is_available() else "cpu")
        load_kwargs: Dict[str, Any] = {}
        if device_map:
            load_kwargs["device_map"] = device_map
        _SIGLIP_MODEL = AutoModelForZeroShotImageClassification.from_pretrained(SIGLIP_MODEL_NAME, **load_kwargs)
        if not device_map:
            _SIGLIP_MODEL.to(device)
        _SIGLIP_MODEL.eval()
        try:
            _SIGLIP_DEVICE = str(next(_SIGLIP_MODEL.parameters()).device)
        except Exception:
            _SIGLIP_DEVICE = "auto"
    return _SIGLIP_PROCESSOR, _SIGLIP_MODEL, _SIGLIP_DEVICE, torch, Image


def _verify_image_category_local(image_path: str, image_category: str, threshold: float) -> SiglipImageVerificationResult:
    processor, model, device, torch, Image = _load_siglip_runtime()
    prompts = [IMAGE_CATEGORY_PROMPTS[key] for key in IMAGE_CATEGORY_PROMPTS.keys()]
    categories = list(IMAGE_CATEGORY_PROMPTS.keys())
    image = Image.open(image_path).convert("RGB")
    inputs = processor(text=prompts, images=image, padding=True, return_tensors="pt")

    model_device = next(model.parameters()).device
    inputs = {key: value.to(model_device) if hasattr(value, "to") else value for key, value in inputs.items()}
    with torch.no_grad():
        outputs = model(**inputs)
        logits = outputs.logits_per_image[0]
        softmax_probabilities = torch.softmax(logits, dim=-1)
        siglip_probabilities = torch.sigmoid(logits)

    logits_cpu = logits.detach().float().cpu()
    softmax_cpu = softmax_probabilities.detach().float().cpu()
    siglip_cpu = siglip_probabilities.detach().float().cpu()

    labels = [
        {
            "image_category": category_key,
            "label": IMAGE_CATEGORY_LABELS_TH[category_key],
            "prompt": prompt,
            "score": round(float(softmax_probability), 4),
            "confidence": round(float(softmax_probability), 4),
            "siglip_probability": round(float(siglip_probability), 4),
            "softmax_probability": round(float(softmax_probability), 4),
            "logit": round(float(logit), 4),
        }
        for category_key, prompt, siglip_probability, softmax_probability, logit in zip(
            categories,
            prompts,
            siglip_cpu.tolist(),
            softmax_cpu.tolist(),
            logits_cpu.tolist(),
        )
    ]
    labels.sort(key=lambda item: float(item["score"]), reverse=True)
    target_index = categories.index(image_category)
    score = round(float(softmax_cpu[target_index].item()), 4)
    target_rank = next((index + 1 for index, item in enumerate(labels) if item["image_category"] == image_category), len(labels))
    top_label = labels[0] if labels else None
    second_label = labels[1] if len(labels) > 1 else None
    predicted_category = normalize_image_category(top_label["image_category"] if top_label else image_category)
    score_margin = round(
        float(top_label["score"]) - float(second_label["score"]) if top_label and second_label else 0.0,
        4,
    )
    passed = score >= threshold and target_rank == 1
    return SiglipImageVerificationResult(
        score=score,
        passed=passed,
        image_category=image_category,
        image_category_label=IMAGE_CATEGORY_LABELS_TH[image_category],
        prompt=IMAGE_CATEGORY_PROMPTS[image_category],
        predicted_category=predicted_category,
        predicted_label=IMAGE_CATEGORY_LABELS_TH[predicted_category],
        predicted_prompt=IMAGE_CATEGORY_PROMPTS[predicted_category],
        target_rank=target_rank,
        score_margin=score_margin,
        verification_threshold=round(float(threshold), 4),
        model_name=SIGLIP_MODEL_NAME,
        version=SIGLIP_VERSION,
        device=device,
        labels=[
            {
                **item,
                "rank": index + 1,
                "target": item["image_category"] == image_category,
                "top_label": top_label["image_category"] if top_label else None,
                "target_rank": target_rank if item["image_category"] == image_category else None,
            }
            for index, item in enumerate(labels)
        ],
    )
