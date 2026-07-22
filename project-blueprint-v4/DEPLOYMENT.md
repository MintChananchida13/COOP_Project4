# Deployment Notes

Required:
- Frontend
- Backend API
- Model Runtime Service
- Database
- OCR engine/service
- Layout analysis runtime
- SigLIP image verification runtime
- File storage

Environment variables:
```text
DATABASE_URL
MODEL_SERVICE_URL
OCR_SERVICE_URL
FILE_STORAGE_PATH
```

Recommended background jobs:
- PDF conversion
- page splitting
- image preprocessing
- layout signature generation
- OCR extraction
