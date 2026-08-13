# OCR Template Management Project

โปรเจกต์นี้เป็นระบบ OCR Template Management สำหรับอัปโหลดเอกสาร ค้นหา Template ที่ตรงกับเอกสาร จัดการ Template/ROI ผ่าน Admin UI และอ่านข้อมูลจาก ROI ด้วย OCR, Table Recognition และ Image Extraction

## ภาพรวมระบบ

ระบบแบ่งเป็น 2 ส่วนหลัก

- `project_frontend`  
  Next.js + TypeScript สำหรับ User OCR Studio และ Admin Template Management

- `project_backend`  
  FastAPI + PostgreSQL + PaddleOCR + OpenCV สำหรับ OCR, Template CRUD, Detection Pipeline, Layout Reference/Signature Matching และ Table Recognition

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
10. ตรวจผล OCR/Ground Truth
11. ตารางแสดงเป็น structured table editor รองรับ merged cell, rowSpan, colSpan และ empty rows
12. Export ผ่านปุ่ม Export เดียว รองรับ Word, Excel, JSON และ Images ZIP
13. ส่ง Template Request ให้ Admin ได้

### Admin Module

Admin routes หลัก:

- `/admin`
  Dashboard

- `/admin/requests`
  รายการ Template Requests

- `/admin/requests/[id]`
  Review request, ดูภาพ/ROI, เลือก Create New Template หรือ Add New Version, convert request เป็น template draft/version, delete request

- `/admin/templates`
  คลัง Template แบบโฟลเดอร์ แสดง Template/Versions ค้นหาชื่อ เปลี่ยนชื่อโฟลเดอร์หลักและ Template ย่อยได้

- `/admin/templates/[id]/edit`
  Template Editor
  - 2.0 ปรับภาพ
  - 2.1 กำหนด Extraction ROI
  - 2.2 กำหนด Verification ROI
  - Test Extraction / Test Verification ก่อนเข้าสู่ขั้นต่อไป
  - จัดการ ROI, field name, type และลำดับ field

- `/admin/templates/[id]/test`
  Pre-Publish Template Validation สำหรับ Draft Template

- `/admin/detection-lab`
  Detection Lab สำหรับทดสอบเอกสารกับ Published/Active Templates

### Template Request

User สามารถส่ง Template Request ได้จากหน้า Ground Truth โดยใช้ไฟล์และ ROI/Ground Truth ปัจจุบัน

Admin รับ request แล้วเลือกได้ 2 แบบ:

- `Create New Template`
- `Add New Version`

ข้อมูลที่ persist:

- template request
- request pages
- requested fields
- ROI ratio
- field name / display label
- data type
- extraction method
- source file/page information
- Ground Truth ที่ผู้ใช้แก้ไขแล้ว

Admin สามารถ convert request เป็น template draft/version ได้ โดยสร้าง:

- templates
- template_pages
- template_fields
- template version/reference data ตาม flow ปัจจุบัน

### Detection / Layout Signature Pipeline

ระบบมี pipeline สำหรับตรวจจับ template:

1. รับภาพหรือ PDF
2. แปลง PDF เป็นภาพถ้ามีหลายหน้า
3. ใช้ภาพที่ normalize/confirmed แล้ว
4. สร้าง Layout Signature ด้วย `layout_signature_service`
5. ค้นหา candidate templates ด้วย `layout_template_matcher`
6. เลือก candidate ที่คะแนนดีที่สุดตาม threshold
7. ใช้ Verification Anchors ช่วยยืนยัน/re-rank
8. คำนวณ final confidence
9. ถ้า `matched=true` โหลด Template bundle และ ROI เข้าหน้า `MatchedTemplateWorkspaceZone`

โหมดที่รองรับ:

- Layout Signature matching
- SigLIP Image Anchor verification
- PaddleOCR Thai OCR/Text Recognition
- Table Recognition สำหรับ field type table

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
      layout_signature_service.py
      layout_template_matcher.py
      layout_analysis_service.py
      paddle_thai_ocr_adapter.py
      table_recognition_v2_adapter.py
      table_grid_analyzer.py
      ocr_postprocess.py
      siglip_image_verification_adapter.py
      image_normalization.py
      alignment_service.py
      model_runtime_client.py
    requirements.txt
    storage/
```

## วิธีรันระบบ

### Production Database: PostgreSQL

ระบบ backend ใช้ PostgreSQL เป็นฐานข้อมูลหลักและจำเป็นต้องตั้งค่า `DATABASE_URL` ก่อนรันระบบ ไม่มี SQLite fallback แล้ว

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

เมื่อใช้ PostgreSQL ครั้งแรก backend จะสร้างตารางหลักที่จำเป็นให้เอง เช่น `templates`, `template_pages`, `template_fields`, `template_requests`, `template_layout_references`, `embedding_jobs` และ `image_verification_categories`

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

## Model Runtime

ระบบใช้ `model_server.py` สำหรับโหลดโมเดลหนักค้างไว้ และ backend จะเรียกผ่าน `MODEL_SERVICE_URL` เมื่อ config ไว้

ถ้า `MODEL_SERVICE_URL` มีค่า:

- Backend ทำหน้าที่เป็น API gateway
- OCR/Layout/Table ใช้ Remote Model Runtime เท่านั้น
- ไม่มี fallback กลับไป local PaddleOCR

ถ้า `MODEL_SERVICE_URL` ว่าง:

- จึงอนุญาตให้ใช้ local PaddleOCR/local pipeline

โมเดล/เครื่องมือหลัก:

- `PP-DocLayoutV3`  
  ใช้วิเคราะห์ layout, auto ROI และสร้าง/เทียบ Layout Reference ของ Template

- `PP-OCRv5_server_det`  
  ใช้ Text Detection หา bbox ข้อความ

- `th_PP-OCRv5_mobile_rec`  
  ใช้ Thai OCR/Text Recognition

- `TableRecognitionPipelineV2`
  - `SLANeXt_wired` สำหรับตารางมีเส้น
  - `SLANeXt_wireless` สำหรับตารางไม่มีเส้น
  - ใช้ร่วมกับ `th_PP-OCRv5_mobile_rec`

- `OpenCV`  
  ใช้ช่วยตรวจเส้น/โครงสร้างตาราง, auto ROI และ semi-table analysis

- `SigLIP`  
  ใช้ Image Verification Anchor

- `PyThaiNLP`  
  ใช้ OCR post-process / Thai text normalization

- `BeautifulSoup4` + `lxml`  
  ใช้ parse HTML table output จาก Table Recognition

### Table Recognition Flow

สำหรับ field type `table`:

1. ลอง `SLANeXt_wired` / `SLANeXt_wireless` ก่อน
2. ถ้า SLANeXt ให้ผล usable และผ่าน quality gate จะใช้ผลนี้เลย
3. ถ้าไม่มั่นใจหรือไม่มีข้อมูล จึงใช้ Semi Table / OCR geometry fallback
4. ต้องรักษา structured schema เช่น `row`, `col`, `rowSpan`, `colSpan`, `hidden`, `bbox`, `ocrText`, `groundTruth`
5. ถ้ามี OCR text ห้ามคืนตารางว่างโดยไม่พยายามสร้าง table fallback

Semi Table ไม่ใช่ default path สำหรับทุกตาราง และไม่ควรแทนที่ SLANeXt เมื่อ SLANeXt อ่านโครงสร้างได้ดี

## คำสั่งตรวจสอบ

Frontend TypeScript:

```powershell
cd project_frontend
npx tsc --noEmit --pretty false
```

Backend syntax check:

```powershell
cd project_backend
python -m py_compile main.py model_server.py app/schemas.py app/services.py app/routes.py app/layout_signature_service.py app/layout_template_matcher.py app/siglip_image_verification_adapter.py app/detection_service.py
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
    'app/layout_signature_service.py',
    'app/layout_template_matcher.py',
    'app/siglip_image_verification_adapter.py',
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
- `paddle_thai_ocr`
- `table_recognition_v2`
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

Image Anchor ต้องใช้ image verification ตามประเภทภาพ ไม่ใช่ OCR text แทน

### Template Status

สถานะที่ใช้งานหลัก:

- `draft`
- `active`
- `nonactive`

สถานะอื่นอาจยังมีอยู่เพื่อ backward compatibility หรือ lifecycle เดิม

## Export

หน้า Ground Truth ใช้ปุ่ม Export เดียว แล้วเลือก format ภายใน popup

Format ที่รองรับ:

- Word: รวม text, table, image
- Excel: สร้างเฉพาะ sheet ของ type ที่มีอยู่จริงในเอกสาร
- JSON: ส่ง text/table และ image field ตาม policy ที่กำหนด
- Images ZIP: crop image fields เป็น ZIP ตามชื่อ field

Table export รองรับ 2 mode:

- `structure` ใช้โครงสร้างตารางเดิม
- `key_value` ใช้ resolved header เป็น key และ data rows เป็น records

Key-Value รองรับ:

- Multi-level header
- เลือก row/column ที่จะ export
- Summary Region แยกจาก Data Region
- Preview ก่อนดาวน์โหลด

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

- `app/layout_analysis_service.py`  
  Layout analysis, auto ROI และ remote/local layout runtime gateway

- `app/layout_signature_service.py`  
  Template layout signature orchestration

- `app/layout_template_matcher.py`  
  Layout signature candidate matcher

- `app/paddle_thai_ocr_adapter.py`  
  Thai OCR adapter และ remote/local OCR runtime gateway

- `app/table_recognition_v2_adapter.py`  
  Table Recognition V2 adapter, SLANeXt wired/wireless, table fallback และ remote/local table runtime gateway

- `app/table_grid_analyzer.py`  
  OpenCV helper สำหรับ semi-table/grid analysis

- `app/ocr_postprocess.py`  
  OCR text normalization/noise cleanup

- `app/siglip_image_verification_adapter.py`  
  SigLIP image category verification adapter

- `app/image_normalization.py`  
  Document normalization interface

- `app/alignment_service.py`  
  Optional ORB alignment diagnostics/refinement

## ข้อจำกัดปัจจุบัน

- Detection endpoint ยังใช้ชื่อ `detect-dev` แต่ flow หลักใช้ Layout Signature + Verification Anchors
- PDF หลายหน้าและ Template หลาย version ต้องทดสอบด้วยเอกสารจริงต่อเนื่อง เพราะเกี่ยวกับ page mapping และ layout reference โดยตรง
- Table Recognition มี fallback หลายชั้น แต่คุณภาพขึ้นกับ ROI, เส้นตาราง, OCR geometry และผลจาก SLANeXt
- Semi Table ควรใช้เฉพาะเมื่อ SLANeXt ไม่มั่นใจ เพื่อไม่ให้ตารางปกติถูก reconstruct เกินจำเป็น
- Image normalization/alignment ควรใช้แบบระวัง โดยเฉพาะ PDF ที่เป็นต้นฉบับและ ROI ไม่ควรถูกบิดผิดตำแหน่ง

## แนวทางพัฒนาต่อ

1. เพิ่ม regression test สำหรับ multi-page template detection ทั้งฝั่ง user และ Admin Detection Lab
2. แยก `adminApi.ts` ที่ user ใช้ออกเป็น shared API helper เพื่อลด coupling ระหว่าง user/admin
3. เพิ่ม debug view แบบย่อสำหรับ Template matching เมื่อหา template ไม่เจอ
4. เพิ่ม QA ชุดเอกสารจริงสำหรับ table มีเส้น/ไม่มีเส้น/semi-structured
5. ปรับ OCR post-process ให้ conservative ขึ้นกับชื่อคน บริษัท รหัส และข้อมูลเฉพาะ
6. ทำ permission/auth และ role policy ให้ครบก่อน deploy production จริง
