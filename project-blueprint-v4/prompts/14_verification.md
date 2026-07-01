Implement VerificationService.

Support:
- exact
- contains
- fuzzy

Rules:
- use only fields where use_for_verification = true
- required fields must pass
- normalize OCR text before matching
- return verification score and details

Stop after this phase.
