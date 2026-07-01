# Image Encoder / DINOv2

## Purpose

Convert normalized document page layout image into embedding vector.

## Default Model

DINOv2 is the default Image Encoder.

## Abstraction

Use:

```text
ImageEncoderService
```

Do not hardcode DINOv2 everywhere.

## Template Page Embedding

```text
Normalized Template Page
→ Apply Ignore Regions
→ Optional layout preprocessing
→ Image Encoder
→ Embedding
→ Qdrant point
```

## Uploaded Page Embedding

```text
Normalized Document Page
→ Image Encoder
→ Embedding
→ Qdrant Top-K
```

## Important

Do not use personal data for matching.
