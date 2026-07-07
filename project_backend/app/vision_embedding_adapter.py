import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional


@dataclass
class VisionEmbeddingResult:
    vector: List[float]
    dimension: int
    engine: str
    version: str
    model_name: str
    input_count: int
    device: Optional[str] = None


DINOV2_MODEL_NAME = "facebook/dinov2-small"


def _hash_inputs(image_paths: List[str]) -> bytes:
    digest = hashlib.sha256()
    for image_path in sorted(image_paths):
        path = Path(image_path)
        if not path.exists():
            raise ValueError(f"Embedding input image not found: {image_path}")
        digest.update(str(path).encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.digest()


def _expand_digest_to_vector(seed: bytes, dimension: int) -> List[float]:
    values: List[float] = []
    counter = 0
    while len(values) < dimension:
        block = hashlib.sha256(seed + counter.to_bytes(4, "big")).digest()
        values.extend(byte / 255 for byte in block)
        counter += 1
    return values[:dimension]


def _encode_images_stub(image_paths: List[str]) -> VisionEmbeddingResult:
    if not image_paths:
        raise ValueError("No embedding input images were provided")

    dimension = 384
    seed = _hash_inputs(image_paths)
    return VisionEmbeddingResult(
        vector=_expand_digest_to_vector(seed, dimension),
        dimension=dimension,
        engine="stub",
        version="phase6.5",
        model_name="dinov2-adapter-stub",
        input_count=len(image_paths),
    )


def _normalize_vector(vector: List[float]) -> List[float]:
    norm = sum(value * value for value in vector) ** 0.5
    if norm == 0:
        return vector
    return [value / norm for value in vector]


def _encode_images_dinov2(image_paths: List[str]) -> VisionEmbeddingResult:
    if not image_paths:
        raise ValueError("No embedding input images were provided")

    try:
        import torch
        from PIL import Image
        from transformers import AutoImageProcessor, AutoModel
    except ImportError as error:
        raise RuntimeError("DINOv2 mode requires torch and transformers.") from error

    device = "cuda" if torch.cuda.is_available() else "cpu"
    processor = AutoImageProcessor.from_pretrained(DINOV2_MODEL_NAME)
    model = AutoModel.from_pretrained(DINOV2_MODEL_NAME).to(device)
    model.eval()

    page_vectors = []
    with torch.no_grad():
        for image_path in image_paths:
            path = Path(image_path)
            if not path.exists():
                raise ValueError(f"Embedding input image not found: {image_path}")
            image = Image.open(path).convert("RGB")
            inputs = processor(images=image, return_tensors="pt")
            inputs = {key: value.to(device) for key, value in inputs.items()}
            outputs = model(**inputs)
            if hasattr(outputs, "pooler_output") and outputs.pooler_output is not None:
                embedding = outputs.pooler_output[0]
            else:
                embedding = outputs.last_hidden_state[:, 0, :][0]
            page_vectors.append(embedding.detach().cpu())

    mean_vector = torch.stack(page_vectors, dim=0).mean(dim=0)
    vector = _normalize_vector(mean_vector.tolist())
    return VisionEmbeddingResult(
        vector=vector,
        dimension=len(vector),
        engine="dinov2",
        version="phase6.8",
        model_name=DINOV2_MODEL_NAME,
        input_count=len(image_paths),
        device=device,
    )


def encode_images(image_paths: List[str]) -> VisionEmbeddingResult:
    mode = os.getenv("VISION_EMBEDDING_MODE", "stub").strip().lower()
    if mode == "dinov2":
        return _encode_images_dinov2(image_paths)
    if mode != "stub":
        raise ValueError("VISION_EMBEDDING_MODE must be 'stub' or 'dinov2'")
    return _encode_images_stub(image_paths)
