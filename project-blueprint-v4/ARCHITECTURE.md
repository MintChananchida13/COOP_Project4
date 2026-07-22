# Architecture

## System Modules

```text
User Module
Admin Module
AI Engine
Backend API
Database
File Storage
OCR Service
Layout Signature Service
SigLIP Image Verification Service
```

## User Flow

```text
Upload
-> Page Split
-> Preprocess
-> Detect Template
-> Template Found?
   -> Yes: Select Fields -> OCR Selected ROI -> Result
   -> No: Custom OCR Studio -> Draw ROI -> OCR -> Result -> Optional Template Request
```

## Admin Flow

```text
Review Request
-> Create Template
-> Create Template Pages
-> Adjust Sample Pages
-> Create Extraction Fields
-> Create Verification Anchors
-> Generate Layout Signatures
-> Template Test Mode
-> Approve / Reject
```

## AI Flow

```text
Document Page
-> Normalize
-> PP-DocLayoutV3 Layout Signature
-> SQLite Layout Candidate Search
-> Verification Anchors
-> Confidence Score
-> Confirm / Reject Candidate
```

## Key Design Decision

Layout Signature search retrieves candidate template pages. Verification Anchors confirm the candidate. The confidence logic decides the final result.
