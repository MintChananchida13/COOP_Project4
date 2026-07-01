# Template Matching

## Step 1: Candidate Retrieval

```text
Document Page Embedding
→ Qdrant Top-K
→ Candidate Template Pages
```

## Step 2: OCR Verification

OCR only candidate verification fields.

## Step 3: Confidence

```text
final_score =
layout_score * 0.5
+ verification_score * 0.4
+ required_pass_score * 0.1
```

## Step 4: Decision

Accept if:
- layout_score >= similarity_threshold
- required verification fields pass
- final_score >= final_confidence_threshold

Reject otherwise.

## Important

Qdrant alone does not confirm a template. OCR Verification is required.
