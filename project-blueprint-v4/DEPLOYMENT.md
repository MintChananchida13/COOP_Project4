# Deployment Notes

Required:
- Frontend
- Backend API
- Database
- Qdrant
- OCR engine/service
- Image Encoder runtime
- File storage

Environment variables:
```text
DATABASE_URL
QDRANT_URL
QDRANT_API_KEY
QDRANT_COLLECTION
OCR_SERVICE_URL
IMAGE_ENCODER_MODEL
FILE_STORAGE_PATH
```

Recommended background jobs:
- PDF conversion
- page splitting
- image preprocessing
- embedding generation
- OCR extraction
