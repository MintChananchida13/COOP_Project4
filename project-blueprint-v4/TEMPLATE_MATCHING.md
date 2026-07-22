# Template Matching

## Step 1: Candidate Retrieval

```text
Document Page Layout Signature
-> Layout Candidate Search
-> Candidate Template Pages
```

## Step 2: Verification Anchors

Run only candidate verification anchors.

## Step 3: Confidence

```text
final_score =
layout_score * 0.5
+ verification_score * 0.5
```

## Step 4: Decision

Accept if:
- final_score >= final_confidence_threshold

Reject otherwise.

## Important

Layout similarity alone does not confirm a template. Verification Anchors provide candidate confirmation.
