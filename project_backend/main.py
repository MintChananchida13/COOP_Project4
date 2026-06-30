import sys
import io

# Force stdout/stderr to use UTF-8 to prevent Windows UnicodeEncodeError on console print
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import base64
import cv2
import numpy as np
from PIL import Image
import io
import os
import easyocr
import uuid

import psycopg2
from psycopg2.extras import RealDictCursor
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
from sentence_transformers import SentenceTransformer

# =================================================================
# 📝 1. CONFIGURATION & DATABASE SETTINGS
# =================================================================
# 🟢 ใส่รหัสผ่าน PostgreSQL ของเครื่องคุณตรงช่อง password
PG_CONN_STR = "dbname=project4_db user=postgres password=1234 host=localhost port=5432"

# 🔵 เปลี่ยนมาใช้ระบบ Local File (In-Memory Mode) ไม่ต้องพึ่งเน็ต ไม่ต้องใช้ API Key
qdrant_client = QdrantClient(path="qdrant_local_db")

OUTPUT_DIR = "cropped_rois"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# =================================================================
# 📦 2. PYDANTIC MODELS (โครงสร้างข้อมูล)
# =================================================================
class ROIModel(BaseModel):
    fieldName: str
    x: float
    y: float
    width: float
    height: float

class DocumentPayload(BaseModel):
    image: str  
    rois: List[ROIModel]

class ApprovedROI(BaseModel):
    fieldName: str
    text: Optional[str] = ""          # เปิดทางเผื่อหน้าบ้านใช้ชื่ออื่น
    extracted_text: Optional[str] = "" # ดักทางถ้าหน้าบ้านส่ง extracted_text มาแทน
    confidence: Optional[float] = 0.0
    saved_path: Optional[str] = ""

class TemplateSavePayload(BaseModel):
    templateName: Optional[str] = "Unnamed_Template"
    imageWidth: Optional[int] = 1920
    imageHeight: Optional[int] = 1080
    extracted_data: List[ApprovedROI]

# =================================================================
# 🚀 3. APP INITIALIZATION & MODELS LOADING
# =================================================================
app = FastAPI(title="Intelligent OCR AI Engine (EasyOCR Local Prod)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

print("⏳ กำลังสตาร์ทและดาวน์โหลดโมเดล EasyOCR (TH/EN) Local Engine...")
ocr_engine = easyocr.Reader(['th', 'en'], gpu=False)
print("✅ EasyOCR (Thai/English) Engine พร้อมใช้งานแบบออฟไลน์แล้ว!")

print("⏳ กำลังโหลดโมเดลภาษาสำหรับทำ Vector Embedding...")
embedding_model = SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')

try:
    qdrant_client.create_collection(
        collection_name="document_templates",
        vectors_config=VectorParams(size=384, distance=Distance.COSINE),
    )
    print("✅ สร้าง Qdrant Collection เรียบร้อย")
except Exception:
    print("💡 Qdrant Collection พร้อมใช้งานอยู่แล้ว")

# =================================================================
# ⚙️ 4. API ENDPOINTS
# =================================================================
@app.get("/")
def read_root():
    return {"status": "EasyOCR Local Engine Online", "framework": "FastAPI"}

@app.post("/api/ai/process")
async def process_document(payload: DocumentPayload):
    try:
        header, encoded = payload.image.split(",", 1) if "," in payload.image else ("", payload.image)
        image_data = base64.b64decode(encoded)
        image = Image.open(io.BytesIO(image_data))
        
        if image.mode != "RGB":
            image = image.convert("RGB")
            
        opencv_img = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
        h_img, w_img, _ = opencv_img.shape
        
        results = []
        print(f"\n📥 [Request] ภาพขนาด: {w_img}x{h_img} px, จำนวน {len(payload.rois)} กล่อง")
        
        if not payload.rois:
            print("📥 [Full Page OCR] Running EasyOCR on full page image...")
            try:
                ocr_result = ocr_engine.readtext(opencv_img)
                for idx, line in enumerate(ocr_result):
                    bbox, text, conf = line
                    xs = [pt[0] for pt in bbox]
                    ys = [pt[1] for pt in bbox]
                    x = max(0, int(min(xs)))
                    y = max(0, int(min(ys)))
                    w = max(1, int(max(xs) - x))
                    h = max(1, int(max(ys) - y))
                    w = min(w, w_img - x)
                    h = min(h, h_img - y)
                    
                    crop_img = opencv_img[y:y+h, x:x+w]
                    filename = f"line_{idx+1}_{uuid.uuid4().hex[:6]}.png"
                    filepath = os.path.join(OUTPUT_DIR, filename)
                    if crop_img.size > 0:
                        cv2.imwrite(filepath, crop_img)
                    else:
                        filepath = ""
                    
                    results.append({
                        "fieldName": f"line_{idx + 1}",
                        "text": text,
                        "confidence": float(conf),
                        "saved_path": filepath,
                        "x": float(x),
                        "y": float(y),
                        "width": float(w),
                        "height": float(h),
                        "bbox": [[float(pt[0]), float(pt[1])] for pt in bbox]
                    })
            except Exception as ocr_err:
                print(f"⚠️ Full Page EasyOCR Error: {str(ocr_err)}")
        else:
            for idx, roi in enumerate(payload.rois):
                x, y, w, h = int(roi.x), int(roi.y), int(roi.width), int(roi.height)
                x = max(0, x)
                y = max(0, y)
                x_end = min(x + w, w_img)
                y_end = min(y + h, h_img)
                
                crop_img = opencv_img[y:y_end, x:x_end]
                if crop_img.size == 0:
                    continue
                
                crop_img = cv2.copyMakeBorder(crop_img, 15, 15, 15, 15, cv2.BORDER_CONSTANT, value=[255, 255, 255])
                
                filename = f"{roi.fieldName}_{idx}.png"
                filepath = os.path.join(OUTPUT_DIR, filename)
                cv2.imwrite(filepath, crop_img)
                
                extracted_text = ""
                confidence_score = 0.0
                
                try:
                    ocr_result = ocr_engine.readtext(crop_img)
                    if ocr_result:
                        text_list = []
                        conf_list = []
                        for line in ocr_result:
                            text_list.append(str(line[1]))
                            conf_list.append(float(line[2]))
                        
                        if text_list:
                            extracted_text = " ".join(text_list).strip()
                            confidence_score = sum(conf_list) / len(conf_list) if conf_list else 0.90
                except Exception as inner_err:
                    print(f"⚠️ EasyOCR Error ย่อย: {str(inner_err)}")
                    
                if not extracted_text:
                    extracted_text = "(ไม่พบข้อความในกล่องพิกัด)"
                    confidence_score = 0.0
                    
                print(f" 🔎 [Field: {roi.fieldName}] -> '{extracted_text}' ({(confidence_score*100):.1f}%)")
                
                results.append({
                    "fieldName": roi.fieldName,
                    "text": extracted_text,
                    "confidence": confidence_score,
                    "saved_path": filepath
                })
            
        return {
            "success": True,
            "matched_template": "Thai_Receipt_EasyOCR_Local",
            "extracted_data": results
        }
    except Exception as e:
        print("🚨 [CRITICAL ERROR]:")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/templates/approve-and-save")
async def approve_and_save_template(payload: TemplateSavePayload):
    try:
        template_id = str(uuid.uuid4())
        
        # ดึงข้อความมารวมกัน รองรับกุญแจทั้งชื่อ text และ extracted_text
        combined_text = " ".join([
            (roi.text if roi.text else roi.extracted_text) 
            for roi in payload.extracted_data 
            if (roi.text or roi.extracted_text)
        ])
        
        # 🟢 สเตปที่ A: บันทึกข้อมูลละเอียดลง PostgreSQL
        conn = psycopg2.connect(PG_CONN_STR)
        cur = conn.cursor()
        
        cur.execute(
            """
            INSERT INTO document_templates (id, name, img_width, img_height, full_text)
            VALUES (%s, %s, %s, %s, %s);
            """,
            (template_id, payload.templateName, payload.imageWidth, payload.imageHeight, combined_text)
        )
        
        for roi in payload.extracted_data:
            final_text = roi.text if roi.text else roi.extracted_text
            cur.execute(
                """
                INSERT INTO template_rois (template_id, field_name, extracted_text, confidence, image_path)
                VALUES (%s, %s, %s, %s, %s);
                """,
                (template_id, roi.fieldName, final_text, roi.confidence, roi.saved_path)
            )
        
        conn.commit()
        cur.close()
        conn.close()
        print(f"📌 [SQL] บันทึก Metadata ลง PostgreSQL สำเร็จ (ID: {template_id})")

        # 🔵 สเตปที่ B: แปลงข้อความเป็นเวกเตอร์แล้วเก็บลง Qdrant สำหรับเปรียบเทียบภายหลัง
        if combined_text.strip():
            vector_embeddings = embedding_model.encode(combined_text).tolist()
            
            qdrant_client.upsert(
                collection_name="document_templates",
                points=[
                    PointStruct(
                        id=template_id,
                        vector=vector_embeddings,
                        payload={
                            "template_name": payload.templateName,
                            "snippet": combined_text[:200]
                        }
                    )
                ]
            )
            print(f"📌 [Vector] บันทึก Embedding ลง Qdrant Space สำเร็จ")

        return {
            "success": True,
            "message": "Template Approved and Synced successfully!",
            "template_id": template_id
        }
        
    except Exception as e:
        print("🚨 [Database Sync Error]:")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))