# OCR Template Management Project

ระบบ OCR Template Management สำหรับอัปโหลดเอกสาร ค้นหา Template ที่ตรงกับเอกสาร กำหนด ROI ผ่าน User/Admin UI และอ่านข้อมูลด้วย OCR, Table Recognition และ Image Extraction

## Current Snapshot

- Frontend: `project_frontend` ใช้ Next.js + TypeScript
- Backend: `project_backend` ใช้ FastAPI + PostgreSQL + PaddleOCR/OpenCV
- Model Runtime: ใช้ `MODEL_SERVICE_URL` เป็น source of truth เมื่อมี remote runtime
- Database หลัก: PostgreSQL ผ่าน `DATABASE_URL`
- User flow หลัก: Upload -> Adjust -> Detect Template -> OCR fields -> Ground Truth -> Export
- Admin flow หลัก: Request/Manual Create -> Adjust -> Extraction ROI -> Verification ROI -> Pre-Publish/Test/Update

## Project Structure

```text
COOP_Project4/
  README.md
  PROJECT_MEMORY.md
  project_frontend/
    src/
      app/page.tsx
      user/components/
      admin/
      admin/workspace/
      shared/workspace/
      types/ocr.ts
  project_backend/
    main.py
    model_server.py
    app/
      db.py
      routes.py
      schemas.py
      services.py
      detection_service.py
      layout_analysis_service.py
      layout_signature_service.py
      layout_template_matcher.py
      ocr_adapter.py
      paddle_thai_ocr_adapter.py
      table_recognition_v2_adapter.py
      table_grid_analyzer.py
      ocr_postprocess.py
      model_runtime_client.py
      siglip_image_verification_adapter.py
    tests/
    requirements.txt
```

## User Flow

1. ผู้ใช้อัปโหลดเอกสาร ครั้งละ 1 ไฟล์
2. เข้า `AdjustZone` เพื่อตรวจภาพและครอปเอกสาร
3. Backend เรียก Template Detection
4. ถ้า `matched=true`
   - โหลด Template bundle
   - แสดง `MatchedTemplateWorkspaceZone`
   - แสดง ROI จาก Template
   - ถ้าเป็น Flexible ROI จะซ่อนกรอบแม่ และแสดงเฉพาะ ROI ย่อยที่ตรวจพบจริง
5. ผู้ใช้เลือก field ที่ต้องการ OCR
6. Backend ประมวลผล OCR ผ่าน `/api/ai/process`
7. แสดงผลใน `GroundTruthEditorZone`
8. ผู้ใช้แก้ Ground Truth ได้แบบ auto-update
9. Export ผ่านปุ่ม Export เดียว

## Admin Flow

Admin มี 2 ช่องทางสร้าง Template:

- รับ Template Request จาก User
- Admin สร้าง Template เองจากคลัง Template

Flow หลัก:

1. เลือก Create New Template หรือ Add New Version
2. อัปโหลดไฟล์ต้นฉบับ
3. เข้า `AdminRequestDetailPage` หรือ Template creation flow
4. เข้า `AdminTemplateEditPage`
5. ขั้นตอนเตรียม Template:
   - `2.0` ปรับภาพ
   - `2.1` กำหนด Extraction ROI
   - `2.2` กำหนด Verification ROI
   - `2.3` ตั้งค่า Final Score/Matching Weights เฉพาะกรณีอัปเดต Template ที่ publish แล้ว
6. Draft Template ไปหน้า Pre-Publish Template Validation
7. Published Template ที่แก้ไขแล้วใช้ปุ่ม Update Template

## ROI Types

### Fix ROI

ใช้สำหรับข้อมูลตำแหน่งคงที่

```text
Template ROI
-> Align/Map document
-> Crop ROI
-> OCR/Table/Image pipeline
-> Field result
```

### Flexible ROI

Flexible ROI เป็น Search Boundary ไม่ใช่กรอบ OCR โดยตรง

```text
Search Boundary
-> PP-DocLayoutV3 หา Text/Table/Image region
-> Text Detection หา text line
-> Paragraph Grouper รวม line เป็น paragraph ROI
-> OCR ตาม type ของ ROI ย่อย
-> Field result
```

กติกาปัจจุบัน:

- กรอบแม่ Flexible ไม่ถูกนับให้ user กด OCR โดยตรง
- แสดงเฉพาะกรอบย่อยที่ระบบเจอจริง
- ROI ย่อยแก้ชื่อ เลือก/ไม่เลือก และจัดลำดับได้
- Paragraph Grouper ใช้ geometry เท่านั้น ไม่ใช้ keyword หรือ OCR text
- ถ้าไม่มั่นใจให้ merge line ไว้ก่อน ลด false split

## Auto ROI

Auto ROI ใช้ `PP-DocLayoutV3` + `PP-OCRv5_server_det`

การกรองปัจจุบัน:

- กรอง text ROI ที่ซ้อนใน text ROI ใหญ่กว่า
- กรอง text fragment จิ๋ว เช่น วรรณยุกต์/เศษตัวอักษร
- กรอง text ที่อยู่ใน table region
- กรอง image region ที่มี text อยู่ภายใน
- Table ROI มี padding เล็กน้อยเพื่อกันตัดเส้นขอบตาราง

ทั้ง user และ admin ใช้ backend auto ROI/filter กลางเดียวกันผ่าน `layout_analysis_service.py`

## OCR Pipeline

Text field:

```text
ROI crop
-> TextDetection
-> Crop text boxes
-> Thai OCR
-> Join by reading order
-> Post-process
```

Fallback:

- ถ้า TextDetection ไม่เจอ box จะ OCR ทั้ง ROI
- ถ้า TextDetection เจอ box แต่ OCR ย่อยว่าง/สั้นผิดปกติ จะ fallback ไป OCR ทั้ง ROI
- Confidence รวมคิดจาก segment ที่มีข้อความจริง ไม่เอา segment ว่างมาถัวให้คะแนนตก

ข้อมูล debug ที่ส่งกลับบางส่วน:

- `text_detection.box_count`
- `recognized_segment_count`
- `empty_segment_count`
- `detected_text_length`
- `fallback_reason`
- `full_roi_confidence`

## Table Recognition

สำหรับ field type `table` ต้องคืนข้อมูลตารางเสมอถ้ามี OCR text

Fallback order:

1. SLANeXt / TableRecognitionPipelineV2
2. Semi Table / geometry path เมื่อ SLANeXt ไม่มั่นใจ
3. Geometry Reconstruction
4. OCR-to-Table
5. Raw OCR Geometry Table

หลักการสำคัญ:

- ตารางปกติให้ SLANeXt เป็นหลัก
- Semi Table ไม่ควรเข้าเร็วเกินไป
- ต้องรักษา schema กลาง:
  - `row`
  - `col`
  - `rowSpan`
  - `colSpan`
  - `hidden`
  - `bbox`
  - `text`
  - `ocrText`
  - `groundTruth`
- ห้ามลดทอนแถวว่างที่ model อ่านโครงสร้างมาได้
- Ground Truth Table Editor ต้องแสดง merged cell/empty row ตาม structured data

## Model Runtime

เมื่อ `MODEL_SERVICE_URL` มีค่า:

- Backend เป็น API gateway เท่านั้น
- OCR/Layout/Table ใช้ remote runtime
- ห้าม fallback ไป local PaddleOCR
- remote error ต้องถูกส่งออกมาตรงๆ

เมื่อ `MODEL_SERVICE_URL` ว่าง:

- อนุญาตให้ใช้ local PaddleOCR

โมเดลหลัก:

- `PP-DocLayoutV3`: Layout, auto ROI, layout signature
- `PP-OCRv5_server_det`: Text Detection
- `th_PP-OCRv5_mobile_rec`: Thai OCR
- `TableRecognitionPipelineV2`
  - `SLANeXt_wired`
  - `SLANeXt_wireless`
- `SigLIP`: Image Verification
- `OpenCV`: geometry/table/grid utilities

## Export

Export อยู่ใน popup เดียวใน `GroundTruthEditorZone`

Formats:

- Word
- Excel
- JSON
- Images ZIP

Content:

- Text
- Tables
- Images

Table export modes:

- `structure`: ส่งออกตามโครงสร้างตารางเดิม
- `key_value`: ใช้ resolved multi-level header เป็น key และ data rows เป็น records

Key-Value รองรับ:

- Multi-level header
- เลือก row/column
- Summary Region แยกจาก Data Region
- Preview ก่อน export

Excel:

- สร้างเฉพาะ sheet ของ type ที่มีอยู่จริง
- image field ใส่ภาพจริงใน cell และรักษา aspect ratio

JSON:

- ส่ง text/table ตามข้อมูลที่ผู้ใช้แก้แล้ว
- image field รองรับ policy ปัจจุบันตาม export option

## Database

ระบบปัจจุบันใช้ PostgreSQL ผ่าน `DATABASE_URL`

ตารางหลักที่เกี่ยวข้อง:

- `templates`
- `template_pages`
- `template_fields`
- `template_requests`
- `template_request_pages`
- `requested_fields`
- `template_layout_references`
- `embedding_jobs`
- `ocr_jobs`
- `image_verification_categories`

ข้อสังเกตปัจจุบัน:

- schema โตตาม feature หลายรอบ ทำให้อ่าน relationship ยาก
- `templates` ยังทำหน้าที่ทั้ง template/version/group ในบาง flow
- ควรทำ Data Dictionary/ERD ก่อน refactor
- ควรแยก concept ระยะยาวเป็น:
  - Template Group / Document Type
  - Template Version
  - Version Pages
  - Version Fields
  - Request / Request Pages / Requested Fields
  - OCR Jobs

ยังไม่ควรรื้อ database ทีเดียว ควรทำ migration-safe refactor พร้อม compatibility layer

## Important Backend APIs

OCR:

- `POST /api/ai/process`
- `GET /api/ai/jobs/{job_id}`

Layout:

- `POST /api/layout/analyze`

Template Detection:

- `POST /api/templates/detect-dev`

Template Requests:

- `GET /template-requests`
- `GET /template-requests/{id}`
- `POST /template-requests`
- `POST /template-requests/{id}/submit`
- `POST /template-requests/{id}/requested-fields`
- `DELETE /admin/template-requests/{request_id}`
- `POST /admin/template-requests/{id}/convert-to-template`

Templates:

- `GET /admin/templates`
- `GET /admin/templates/{id}`
- `PUT /admin/templates/{id}`
- `DELETE /admin/templates/{id}`
- `POST /admin/templates/{id}/pages`
- `PUT /admin/templates/{id}/pages/{pageId}`
- `POST /admin/templates/{id}/fields`
- `PUT /admin/templates/{id}/fields/{fieldId}`
- `DELETE /admin/templates/{id}/fields/{fieldId}`

Publish/Layout Reference:

- `POST /admin/templates/{template_id}/embedding-jobs`
- `GET /admin/templates/{template_id}/embedding-jobs/latest`
- `POST /admin/embedding-jobs/{job_id}/run-dev`
- `POST /admin/templates/{template_id}/confirm-publish`

## Local Setup

### PostgreSQL

```powershell
docker run --name ocr-postgres `
  -e POSTGRES_DB=ocr_studio `
  -e POSTGRES_USER=postgres `
  -e POSTGRES_PASSWORD=postgres `
  -p 5432:5432 `
  -d postgres:16
```

### Backend

```powershell
cd project_backend
.\venv\Scripts\activate
pip install -r requirements.txt
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ocr_studio"
$env:MODEL_SERVICE_URL="http://127.0.0.1:8010"
uvicorn main:app --reload
```

Backend:

```text
http://localhost:8000
```

### Model Runtime

```powershell
cd project_backend
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ocr_studio"
$env:PADDLE_TABLE_DEVICE="cpu"
uvicorn model_server:app --host 0.0.0.0 --port 8010
```

Warmup endpoint:

```text
POST /runtime/warmup
```

### Frontend

```powershell
cd project_frontend
npm install
npm run dev
```

Frontend:

```text
http://localhost:3000
```

## Validation Commands

Frontend:

```powershell
cd project_frontend
npx tsc --noEmit --pretty false
```

Backend syntax:

```powershell
cd project_backend
python -m py_compile main.py model_server.py app/db.py app/schemas.py app/services.py app/routes.py app/detection_service.py app/layout_analysis_service.py app/ocr_adapter.py app/paddle_thai_ocr_adapter.py app/table_recognition_v2_adapter.py
```

Backend tests:

```powershell
cd project_backend
python -m unittest tests.test_ocr_adapter
python -m unittest tests.test_layout_analysis_remote_routing
python -m unittest tests.test_table_recognition_v2_adapter
```

## Key Files

Frontend:

- `src/app/page.tsx`: User OCR Studio, detection flow, export logic
- `src/user/components/AdjustZone.tsx`: image adjust/crop step
- `src/user/components/MatchedTemplateWorkspaceZone.tsx`: matched template ROI workspace
- `src/user/components/GroundTruthEditorZone.tsx`: Ground Truth, table editor, export preview
- `src/shared/workspace/WorkspaceCustomEditor.tsx`: shared ROI canvas/editor
- `src/admin/AdminTemplateEditPage.tsx`: admin 2.0/2.1/2.2/2.3 editor
- `src/admin/AdminTemplateTestPage.tsx`: pre-publish validation
- `src/admin/AdminDetectionLabPage.tsx`: detection lab
- `src/admin/adminApi.ts`: admin/shared API mapper

Backend:

- `main.py`: FastAPI app and OCR API
- `model_server.py`: remote model runtime
- `app/db.py`: database bootstrap/schema
- `app/services.py`: template/request/admin service layer
- `app/detection_service.py`: template detection pipeline
- `app/layout_analysis_service.py`: layout/auto ROI/text detection gateway
- `app/ocr_adapter.py`: OCR ROI pipeline and fallback
- `app/paddle_thai_ocr_adapter.py`: Thai OCR remote/local adapter
- `app/table_recognition_v2_adapter.py`: table recognition and fallback
- `app/ocr_postprocess.py`: OCR text cleanup

## Known Risks / TODO

- Database needs ERD/Data Dictionary and migration-safe cleanup
- `detect-dev` endpoint name is legacy even though used by real flow
- Multi-page template detection needs more document-level regression tests
- Table OCR quality still depends heavily on ROI, table lines, SLANeXt output and OCR geometry
- Semi Table should remain fallback, not default for normal wired tables
- Admin/user API coupling should eventually move shared user calls out of `adminApi.ts`
- Production auth/role policy exists but still needs a final security review before public deployment
