import json
import os
import base64
import io
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from .db import connect as connect_db
from .vector_store_adapter import upsert_template_vector
from .vision_embedding_adapter import encode_images


class EmbeddingContextError(Exception):
    pass


@dataclass
class EmbeddingResult:
    vector_id: str
    metadata: Dict[str, Any]
    engine: str
    version: str
    page_count: int
    ignored_region_count: int
    field_count: int
    roi_coverage: float
    ignore_coverage: float


def _project_backend_path() -> Path:
    return Path(__file__).resolve().parents[1]


def _storage_path() -> Path:
    return _project_backend_path() / "storage" / "embedding_previews"


def _connect() -> Any:
    conn = connect_db()
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _row_to_dict(row: Any) -> Dict[str, Any]:
    return dict(row)


def _clamp_ratio(value: float) -> float:
    return max(0.0, min(1.0, value))


def _area(item: Dict[str, Any]) -> float:
    width = float(item.get("roi_width_ratio") or 0)
    height = float(item.get("roi_height_ratio") or 0)
    return max(0.0, width) * max(0.0, height)


def _page_image_source(page: Dict[str, Any]) -> Optional[str]:
    return page.get("normalized_image_url") or page.get("sample_image_url")


def _image_to_data_url(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _load_pillow():
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return None, None
    return Image, ImageDraw


def load_template_embedding_context(template_id: str) -> Dict[str, Any]:
    with _connect() as conn:
        template_row = conn.execute("SELECT * FROM templates WHERE id = ?", (template_id,)).fetchone()
        if template_row is None:
            raise EmbeddingContextError("Template not found")

        page_rows = conn.execute(
            """
            SELECT * FROM template_pages
            WHERE template_id = ?
            ORDER BY page_number ASC
            """,
            (template_id,),
        ).fetchall()
        field_rows = conn.execute(
            """
            SELECT * FROM template_fields
            WHERE template_id = ?
            ORDER BY page_number ASC, sort_order ASC, created_at ASC
            """,
            (template_id,),
        ).fetchall()
        ignore_rows = conn.execute(
            """
            SELECT * FROM ignore_regions
            WHERE template_id = ?
            ORDER BY page_number ASC, created_at ASC
            """,
            (template_id,),
        ).fetchall()

    pages = [_row_to_dict(row) for row in page_rows]
    fields = [_row_to_dict(row) for row in field_rows]
    ignore_regions = [_row_to_dict(row) for row in ignore_rows]
    if not pages:
        raise EmbeddingContextError("Template must have at least one page before embedding")
    if not fields:
        raise EmbeddingContextError("Template must have at least one field before embedding")

    return {
        "template": _row_to_dict(template_row),
        "pages": pages,
        "fields": fields,
        "ignore_regions": ignore_regions,
    }


def calculate_roi_coverage(fields: List[Dict[str, Any]]) -> float:
    return _clamp_ratio(sum(_area(field) for field in fields))


def calculate_ignore_coverage(ignore_regions: List[Dict[str, Any]]) -> float:
    return _clamp_ratio(sum(_area(region) for region in ignore_regions))


def load_page_image(page: Dict[str, Any]):
    Image, _ = _load_pillow()
    if Image is None:
        return None

    source = _page_image_source(page)
    if not source:
        raise EmbeddingContextError(f"Template page image is unavailable for page {page['page_number']}")

    try:
        if source.startswith("data:image"):
            _, encoded = source.split(",", 1)
            image = Image.open(io.BytesIO(base64.b64decode(encoded)))
        else:
            source_path = Path(source)
            if not source_path.is_absolute():
                source_path = _project_backend_path() / source_path
            if not source_path.exists():
                raise EmbeddingContextError(f"Template page image is unavailable for page {page['page_number']}")
            image = Image.open(source_path)
    except EmbeddingContextError:
        raise
    except Exception as error:
        raise EmbeddingContextError(f"Template page image is unavailable for page {page['page_number']}") from error

    if image.mode != "RGB":
        image = image.convert("RGB")
    return image


def apply_ignore_region_mask(image, ignore_regions: List[Dict[str, Any]]):
    _, ImageDraw = _load_pillow()
    if ImageDraw is None:
        return image

    masked = image.copy()
    draw = ImageDraw.Draw(masked)
    width, height = masked.size
    for region in ignore_regions:
        left = int(_clamp_ratio(float(region.get("roi_x_ratio") or 0)) * width)
        top = int(_clamp_ratio(float(region.get("roi_y_ratio") or 0)) * height)
        region_width = int(_clamp_ratio(float(region.get("roi_width_ratio") or 0)) * width)
        region_height = int(_clamp_ratio(float(region.get("roi_height_ratio") or 0)) * height)
        right = max(left + 1, min(width, left + region_width))
        bottom = max(top + 1, min(height, top + region_height))
        left = max(0, min(left, width - 1))
        top = max(0, min(top, height - 1))
        draw.rectangle((left, top, right, bottom), fill=(255, 255, 255))
    return masked


def save_embedding_preview_image(template_id: str, page_index: int, image) -> Path:
    output_dir = _storage_path() / template_id
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"page_{page_index}.png"
    image.save(output_path, format="PNG")
    return output_path


def get_embedding_preview_paths(template_id: str) -> List[Path]:
    preview_dir = _storage_path() / template_id
    if not preview_dir.exists():
        return []
    return sorted(preview_dir.glob("page_*.png"))


def prepare_embedding_input_preview(template_id: str) -> List[Dict[str, Any]]:
    context = load_template_embedding_context(template_id)
    Image, _ = _load_pillow()
    if Image is None:
        return []

    previews = []
    for page in context["pages"]:
        page_index = page["page_number"]
        page_ignores = [region for region in context["ignore_regions"] if region["page_number"] == page_index]
        image = load_page_image(page)
        masked_image = apply_ignore_region_mask(image, page_ignores)
        preview_path = save_embedding_preview_image(template_id, page_index, masked_image)
        width, height = masked_image.size
        previews.append(
            {
                "page_index": page_index,
                "preview_path": str(preview_path),
                "preview_data_url": _image_to_data_url(preview_path),
                "width": width,
                "height": height,
                "ignore_count": len(page_ignores),
            }
        )
    return previews


def build_embedding_metadata(context: Dict[str, Any]) -> Dict[str, Any]:
    pages = context["pages"]
    fields = context["fields"]
    ignore_regions = context["ignore_regions"]
    per_page = []

    for page in pages:
        page_number = page["page_number"]
        page_fields = [field for field in fields if field["page_number"] == page_number]
        page_ignores = [region for region in ignore_regions if region["page_number"] == page_number]
        per_page.append(
            {
                "page_index": page_number,
                "field_count": len(page_fields),
                "ignore_count": len(page_ignores),
                "roi_coverage": calculate_roi_coverage(page_fields),
                "ignore_coverage": calculate_ignore_coverage(page_ignores),
            }
        )

    page_count = len(pages)
    roi_coverage = _clamp_ratio(sum(item["roi_coverage"] for item in per_page) / page_count)
    ignore_coverage = _clamp_ratio(sum(item["ignore_coverage"] for item in per_page) / page_count)

    return {
        "engine": "stub",
        "version": "phase6.4",
        "template_id": context["template"]["id"],
        "template_name": context["template"]["name"],
        "template_status": context["template"]["status"],
        "page_count": page_count,
        "field_count": len(fields),
        "ignored_region_count": len(ignore_regions),
        "roi_coverage": roi_coverage,
        "ignore_coverage": ignore_coverage,
        "per_page": per_page,
    }


def generate_template_embedding(template_id: str) -> EmbeddingResult:
    context = load_template_embedding_context(template_id)
    metadata = build_embedding_metadata(context)
    Image, _ = _load_pillow()
    if Image is None:
        metadata["embedding_input_previews"] = []
        metadata["warning"] = "Pillow unavailable; preview generation skipped."
    else:
        metadata["embedding_input_previews"] = prepare_embedding_input_preview(template_id)
    preview_paths = [
        preview["preview_path"]
        for preview in metadata["embedding_input_previews"]
        if preview.get("preview_path")
    ]
    vision_result = encode_images(preview_paths)
    metadata.update(
        {
            "engine": vision_result.engine,
            "version": vision_result.version,
            "model_name": vision_result.model_name,
            "vector_dimension": vision_result.dimension,
            "input_count": vision_result.input_count,
            "device": vision_result.device,
        }
    )
    vector_store_result = upsert_template_vector(f"vec_{template_id}", vision_result.vector, metadata)
    metadata.update(
        {
            "vector_store_engine": vector_store_result.engine,
            "vector_store_collection": vector_store_result.collection,
            "vector_store_status": vector_store_result.status,
            "vector_dimension": vector_store_result.dimension,
        }
    )
    return EmbeddingResult(
        vector_id=vector_store_result.vector_id,
        metadata=metadata,
        engine=metadata["engine"],
        version=metadata["version"],
        page_count=metadata["page_count"],
        ignored_region_count=metadata["ignored_region_count"],
        field_count=metadata["field_count"],
        roi_coverage=metadata["roi_coverage"],
        ignore_coverage=metadata["ignore_coverage"],
    )


def embedding_result_to_json(result: EmbeddingResult) -> str:
    return json.dumps(result.metadata)
