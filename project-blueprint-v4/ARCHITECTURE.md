# Architecture

## System Modules

```text
User Module
Admin Module
AI Engine
Backend API
Database
File Storage
Qdrant Vector Database
OCR Service
Image Encoder Service
```

## User Flow

```text
Upload
→ Page Split
→ Preprocess
→ Detect Template
→ Template Found?
   ├─ Select Fields
   ├─ OCR Selected ROI
   └─ Result

Template Not Found
→ Custom OCR Studio
→ Draw ROI
→ OCR
→ Result
→ Optional Template Request
```

## Admin Flow

```text
Review Request
→ Create Template
→ Create Template Pages
→ Adjust Sample Pages
→ Create Template Fields
→ Mark Verification Fields
→ Create Ignore Regions
→ Generate Page Embeddings
→ Template Test Mode
→ Approve / Reject
```

## AI Flow

```text
Document Page
→ Normalize
→ Embedding
→ Qdrant Top-K
→ OCR Verification
→ Confidence Score
→ Confirm / Reject Candidate
```

## Key Design Decision

Qdrant retrieves candidate template pages. OCR Verification confirms. Confidence Engine decides final result.
