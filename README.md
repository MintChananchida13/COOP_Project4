# OCR Template Management Project

โปรเจกต์นี้เป็นระบบ OCR Template Management สำหรับอัปโหลดเอกสาร ตรวจจับประเภทเอกสารด้วย embedding, จัดการ Template/ROI ผ่าน Admin UI และอ่านข้อมูลจาก ROI ด้วย OCR

## ภาพรวมระบบ

ระบบแบ่งเป็น 2 ส่วนหลัก

- `project_frontend`  
  Next.js + TypeScript สำหรับ User OCR Studio และ Admin Template Management

- `project_backend`  
  FastAPI + PostgreSQL + PaddleOCR + OpenCV สำหรับ OCR, Template CRUD, Detection Pipeline และ Layout Signature Matching

Blueprint ใน `project-blueprint-v4` เป็นเอกสารออกแบบ ไม่ใช่ runtime code

## ฟีเจอร์หลักที่มีตอนนี้

### User OCR Studio `/`

Flow ปัจจุบัน:

1. Upload Document
2. เปิด `AdjustZone`
3. ตรวจจับขอบเขตเอกสารเบื้องต้น
4. ผู้ใช้ลากแก้กรอบเอกสารได้
5. Confirm and Detect Template
6. Crop + Perspective Correction จากกรอบที่ยืนยัน
7. Run Document Detection
8. ถ้า match template:
   - โหลด Extraction ROI จาก Template
   - แสดงหน้า `MatchedTemplateWorkspaceZone`
   - ผู้ใช้เลือก checkbox ของ field ที่ต้องการ OCR
   - ปรับตำแหน่ง/ขนาด ROI ได้
   - กด OCR Selected Fields
9. ถ้าไม่ match template:
   - fallback ไป Custom OCR Workspace
10. ตรวจผล OCR ใน Ground Truth
11. ส่ง Template Request ให้ Admin ได้

### Admin Module

Admin routes หลัก:

- `/admin`
  Dashboard

- `/admin/requests`
  รายการ Template Requests

- `/admin/requests/[id]`
  Review request, ดูภาพ/ROI, convert request เป็น template draft, delete request

- `/admin/templates`
  รายการ Templates พร้อม filter แบบย่อ: all, draft, active, nonactive

- `/admin/templates/[id]/edit`
  Template Editor
  - Define Extraction Fields
  - Verification Anchors
  - จัดการ ROI
  - Save ลง backend/database

- `/admin/templates/[id]/test`
  Pre-Publish Template Validation สำหรับ Draft Template

- `/admin/detection-lab`
  Detection Lab สำหรับทดสอบเอกสารกับ Published/Active Templates

### Template Request

User สามารถส่ง Template Request ได้ 2 แบบ:

- `image_only`
- `image_with_roi`

ข้อมูลที่ persist:

- template request
- request pages
- requested fields
- ROI ratio
- field name / display label
- data type
- extraction method

Admin สามารถ convert request เป็น template draft ได้ โดยสร้าง:

- templates
- template_pages
- template_fields

### Detection / Embedding Pipeline

ระบบมี pipeline สำหรับตรวจจับ template:

1. รับภาพหรือ PDF
2. แปลง PDF เป็นภาพถ้ามีหลายหน้า
3. ใช้ภาพที่ normalize/confirmed แล้ว
4. สร้าง embedding ด้วย `vision_embedding_adapter`
5. ค้นหา candidate templates ด้วย `vector_store_adapter`
6. เลือก Top-K candidates
7. ใช้ Verification Anchors ช่วย re-rank
8. คำนวณ final score
9. คืนผล candidate และ best match

โหมดที่รองรับ:

- Stub embedding/vector store สำหรับ dev
- Optional DINOv2 mode
- Optional Qdrant mode

## โครงสร้างโปรเจกต์

```text
COOP_Project4/
  PROJECT_MEMORY.md
  project-blueprint-v4/
  project_frontend/
    src/
      app/
        page.tsx
        admin/
      admin/
        AdminDashboard.tsx
        AdminRequestsPage.tsx
        AdminRequestDetailPage.tsx
        AdminTemplatesPage.tsx
        AdminTemplateEditPage.tsx
        AdminTemplateTestPage.tsx
        AdminDetectionLabPage.tsx
        adminApi.ts
        adminTypes.ts
      admin/workspace/
      shared/workspace/
        WorkspaceCustomEditor.tsx
        RoiBox.tsx
        RoiLayer.tsx
        WorkspaceCanvas.tsx
        roiGeometry.ts
      user/components/
        UploadZone.tsx
        AdjustZone.tsx
        WorkspaceZone.tsx
        MatchedTemplateWorkspaceZone.tsx
        GroundTruthEditorZone.tsx
        TemplateRequestPanel.tsx
      types/
        ocr.ts
    package.json
  project_backend/
    main.py
    app/
      routes.py
      schemas.py
      services.py
      detection_service.py
      embedding_service.py
      vision_embedding_adapter.py
      vector_store_adapter.py
      image_normalization.py
      alignment_service.py
    requirements.txt
    storage/
```

## วิธีรันระบบ

### Production Database: PostgreSQL

ระบบ backend รองรับ PostgreSQL ผ่าน `DATABASE_URL` แล้ว โดยยัง fallback ไป SQLite เดิมได้ถ้าไม่ได้ตั้งค่า env นี้

```powershell
docker run --name ocr-postgres `
  -e POSTGRES_DB=ocr_studio `
  -e POSTGRES_USER=postgres `
  -e POSTGRES_PASSWORD=postgres `
  -p 5432:5432 `
  -d postgres:16
```

ตั้งค่า env ก่อนรัน backend:

```powershell
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ocr_studio"
$env:MODEL_SERVICE_URL="http://127.0.0.1:8010"
uvicorn main:app
```

เมื่อใช้ PostgreSQL ครั้งแรก backend จะสร้างตารางหลักที่จำเป็นให้เอง เช่น `templates`, `template_pages`, `template_fields`, `template_requests`, `embedding_jobs` และ `verification_anchor_embeddings`

### ย้ายข้อมูลเดิมจาก SQLite ไป PostgreSQL

ใช้สคริปต์นี้เมื่อต้องการย้าย template, request, page, ROI, embedding job, verification anchor embedding และ log เดิมจาก `project_frontend/prisma/dev.db`

ตรวจจำนวนข้อมูลก่อน:

```powershell
cd project_backend
.\venv\Scripts\activate
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ocr_studio"
python migrate_sqlite_to_postgres.py --dry-run
```

ย้ายข้อมูลจริง:

```powershell
python migrate_sqlite_to_postgres.py
```

สคริปต์นี้ไม่ลบข้อมูล PostgreSQL ปลายทาง และสามารถรันซ้ำได้โดยจะ upsert ตาม `id`

### 1. Backend

```powershell
cd project_backend
.\venv\Scripts\activate
pip install -r requirements.txt
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ocr_studio"
uvicorn main:app --reload
```

Backend เปิดที่:

```text
http://localhost:8000
```

OCR endpoint หลัก:

```text
POST http://localhost:8000/api/ai/process
```

Detection endpoint:

```text
POST http://localhost:8000/api/templates/detect-dev
```

### 2. Frontend

```powershell
cd project_frontend
npm install
npm run dev
```

Frontend เปิดที่:

```text
http://localhost:3000
```

## Optional: Qdrant + DINOv2

ถ้าต้องการใช้ Qdrant:

```powershell
docker run -p 6333:6333 qdrant/qdrant
```

ตั้งค่า environment:

```powershell
$env:QDRANT_URL="http://localhost:6333"
$env:VISION_EMBEDDING_MODE="dinov2"
$env:VECTOR_STORE_MODE="qdrant"
$env:QDRANT_COLLECTION="templates"
uvicorn main:app
```

ถ้าไม่ตั้งค่า ระบบจะใช้ stub/local mode ตามค่า default

## คำสั่งตรวจสอบ

Frontend TypeScript:

```powershell
cd project_frontend
npx tsc --noEmit --pretty false
```

Backend syntax check:

```powershell
cd project_backend
python -m py_compile main.py app/schemas.py app/services.py app/routes.py app/embedding_service.py app/vision_embedding_adapter.py app/vector_store_adapter.py app/detection_service.py
```

ถ้า Windows มีปัญหา permission จาก `__pycache__` ให้ใช้ compile แบบ in-memory:

```powershell
cd project_backend
@'
from pathlib import Path
files = [
    'main.py',
    'app/schemas.py',
    'app/services.py',
    'app/routes.py',
    'app/embedding_service.py',
    'app/vision_embedding_adapter.py',
    'app/vector_store_adapter.py',
    'app/detection_service.py',
]
for file in files:
    compile(Path(file).read_text(encoding='utf-8'), file, 'exec')
print('syntax ok')
'@ | python -
```

## ข้อมูลสำคัญของระบบ

### ROI

ระบบเก็บ ROI เป็น ratio:

- `xRatio`
- `yRatio`
- `widthRatio`
- `heightRatio`
- `pageNumber`

ห้ามเปลี่ยน source of truth เป็น pixel ถาวร เพราะต้องรองรับหลายขนาดภาพและหลายหน้า

### Extraction Fields

Extraction Fields คือ field ที่ต้องการอ่านข้อมูลและส่งคืนผู้ใช้ เช่น:

- ID Number
- First Name
- Last Name
- Date of Birth
- Invoice Number

ค่าที่เกี่ยวข้อง:

- field name
- display label
- data type
- extraction method
- ROI
- page number

Extraction method ที่รองรับ:

- `ocr_text`
- `ocr_table`
- `extract_image`

### Verification Anchors

Verification Anchors ใช้ยืนยันว่าเอกสารตรงกับ template เท่านั้น ไม่ใช่ output สำหรับผู้ใช้

ตัวอย่าง:

- Fixed text เช่น `Thai National ID Card`
- โลโก้
- ตราประทับ
- สัญลักษณ์ที่อยู่ประจำ template

Anchor types:

- Text Anchor
- Image Anchor

### Template Status

สถานะที่ใช้งานหลัก:

- `draft`
- `active`
- `nonactive`

สถานะอื่นอาจยังมีอยู่เพื่อ backward compatibility หรือ lifecycle เดิม

## Backend API สำคัญ

Template Requests:

- `POST /template-requests`
- `GET /template-requests`
- `GET /template-requests/{id}`
- `POST /template-requests/{id}/submit`
- `POST /template-requests/{id}/requested-fields`
- `DELETE /admin/template-requests/{request_id}`
- `POST /admin/template-requests/{id}/convert-to-template`

Templates:

- `GET /admin/templates`
- `GET /admin/templates/{id}`
- `PUT /admin/templates/{id}`
- `DELETE /admin/templates/{id}`
- `GET /admin/templates/{id}/pages`
- `POST /admin/templates/{id}/pages`
- `PUT /admin/templates/{id}/pages/{pageId}`
- `DELETE /admin/templates/{id}/pages/{pageId}`
- `POST /admin/templates/{id}/fields`
- `PUT /admin/templates/{id}/fields/{fieldId}`
- `DELETE /admin/templates/{id}/fields/{fieldId}`
- `POST /admin/templates/{id}/ignore-regions`
- `PUT /admin/templates/{id}/ignore-regions/{regionId}`
- `DELETE /admin/templates/{id}/ignore-regions/{regionId}`

Embedding / Publish:

- `POST /admin/templates/{template_id}/embedding-jobs`
- `GET /admin/templates/{template_id}/embedding-jobs/latest`
- `POST /admin/embedding-jobs/{job_id}/run-dev`
- `POST /admin/embedding-jobs/{job_id}/complete-dev`
- `POST /admin/embedding-jobs/{job_id}/fail-dev`
- `POST /admin/templates/{template_id}/confirm-publish`

Detection:

- `POST /api/templates/detect-dev`

## ไฟล์สำคัญ

### Frontend

- `src/app/page.tsx`  
  หน้า User OCR Studio หลัก

- `src/user/components/AdjustZone.tsx`  
  ตรวจ/แก้ขอบเขตเอกสารก่อน classification

- `src/user/components/MatchedTemplateWorkspaceZone.tsx`  
  Workspace หลัง match template แล้ว แสดง ROI จาก template และ checkbox เลือก field OCR

- `src/shared/workspace/WorkspaceCustomEditor.tsx`  
  Workspace engine กลางสำหรับ canvas, zoom, pan, ROI overlay, drag/resize

- `src/admin/adminApi.ts`  
  API helper ทั้ง Admin และบางส่วนของ user detection flow

- `src/admin/AdminTemplateEditPage.tsx`  
  หน้าแก้ template

- `src/admin/AdminTemplateTestPage.tsx`  
  Pre-Publish Template Validation

- `src/admin/AdminDetectionLabPage.tsx`  
  Detection Lab สำหรับ active/published templates

### Backend

- `main.py`  
  FastAPI app, CORS, static debug mount, `/api/ai/process`

- `app/routes.py`  
  API routes หลัก

- `app/services.py`  
  Persistence, template service, verification, decision logic

- `app/detection_service.py`  
  Detection pipeline

- `app/embedding_service.py`  
  Template embedding orchestration

- `app/vision_embedding_adapter.py`  
  Stub/DINOv2 embedding adapter

- `app/vector_store_adapter.py`  
  Stub/Qdrant vector store adapter

- `app/image_normalization.py`  
  Document normalization interface

- `app/alignment_service.py`  
  Optional ORB alignment diagnostics/refinement

## ข้อจำกัดปัจจุบัน

- Detection endpoint ยังใช้ชื่อ `detect-dev` แม้บางโหมดจะใช้ DINOv2/Qdrant จริง
- Alignment เป็น optional refinement และไม่ควรเป็นเงื่อนไข reject candidate
- Image normalization ฝั่ง backend เคยมีปัญหา จึงควรระวังการเปิดใช้ crop/normalize อัตโนมัติแบบเต็ม
- Pre-Publish flow ยังเป็นเครื่องมือช่วย Admin ก่อน publish ไม่ใช่ production detection
- Detection Lab ใช้ทดสอบ published/active templates เท่านั้น
- Verification Anchors และ Image Anchors มีโครงรองรับแล้ว แต่ควรทดสอบจริงกับเอกสารหลายรูปแบบก่อนใช้งาน production

## แนวทางพัฒนาต่อ

1. ทำให้ Document Classification หลัง `AdjustZone` เสถียรขึ้นกับ multi-page PDF
2. แยก `adminApi.ts` ที่ user ใช้ออกเป็น shared API helper เพื่อลด coupling ระหว่าง user/admin
3. เพิ่ม UI แสดง candidate/debug แบบย่อใน user flow เมื่อ template detection ไม่มั่นใจ
4. ทำ normalization backend ให้แม่นขึ้น แล้วค่อยเปิดใช้ใน production detection
5. เพิ่ม OCR extraction pipeline หลัง final template selection แบบเต็ม รวมถึง table/image extraction
6. ทำ permission/auth สำหรับ Admin ก่อน deploy จริง
