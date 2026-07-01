# Project Blueprint v4 — Production Ready

This folder is the Source of Truth for the Intelligent Document Template Management System.

## Project Goal

Build a production-ready document OCR platform that detects templates by document layout, verifies with OCR, and extracts only selected ROI fields.

## Core Architecture

```text
Upload Document
→ Split into Pages
→ Image Preprocessing per Page
→ Image Encoder Embedding per Page
→ Qdrant Top-K Template Page Search
→ OCR Verification
→ Confidence Engine
→ Template Found?
   ├─ Yes: Selectable Fields → OCR Selected ROI → Result
   └─ No: Custom OCR Studio → Draw ROI → OCR → Optional Template Request
```

## How to Use with Codex

1. Put this folder in the project root.
2. Start every Codex task with `prompts/00_read_first.md`.
3. Implement one phase at a time.
4. Stop and review after every phase.
5. Do not ask Codex to build the whole project in one run.

## Must Read First

- `PROJECT_MEMORY.md`
- `ARCHITECTURE.md`
- `CODING_RULES.md`
- `MULTI_PAGE.md`
- `prompts/MASTER_PROMPT.md`
