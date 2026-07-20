This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.



.\venv\Scripts\activate

# Terminal 1: Model Runtime Service
# โหลดโมเดลค้างไว้ เช่น PP-DocLayoutV3, PP-OCRv5_server_det,
# th_PP-OCRv5_mobile_rec และ DINOv2 สำหรับ Image Anchor
$env:VISION_EMBEDDING_MODE="dinov2"
uvicorn model_server:app --host 127.0.0.1 --port 8010

# Terminal 2: Main Backend
# backend หลักจะเรียก model service ผ่าน HTTP และไม่ warm-up โมเดลเอง
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ocr_studio"
$env:MODEL_SERVICE_URL="http://127.0.0.1:8010"

# ปรับความเร็วของ Template Detection
# ค้นหา Top 5 แต่ประเมินหนักเฉพาะ Top 2 และ align เฉพาะ Top 1
$env:DETECTION_RETRIEVAL_LIMIT="5"
$env:DETECTION_FULL_EVAL_LIMIT="2"
$env:DETECTION_ALIGNMENT_LIMIT="1"

# ถ้าต้องการโหมดเร็วมากสำหรับพรีวิว ROI ให้ใช้:
# $env:DETECTION_FULL_EVAL_LIMIT="1"
# $env:DETECTION_ALIGNMENT_LIMIT="0"
uvicorn main:app

# ถ้าไม่ต้องการแยก service สามารถไม่ตั้ง MODEL_SERVICE_URL
# แล้วรัน backend แบบ local model fallback ได้
uvicorn main:app --reload

## ย้ายข้อมูลเดิมจาก SQLite ไป PostgreSQL

```powershell
cd ..\project_backend
.\venv\Scripts\activate
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ocr_studio"
python migrate_sqlite_to_postgres.py --dry-run
python migrate_sqlite_to_postgres.py
```

สคริปต์จะย้ายข้อมูลจาก `project_frontend/prisma/dev.db` ไป PostgreSQL และรันซ้ำได้โดย upsert ตาม `id`

docker run -p 6333:6333 qdrant/qdrant



cd D:\coop\COOP_Project4\project_backend
.\venv\Scripts\activate
$env:VISION_EMBEDDING_MODE="dinov2"
uvicorn model_server:app --host 127.0.0.1 --port 8010


cd D:\coop\COOP_Project4\project_backend
.\venv\Scripts\activate
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ocr_studio"
$env:MODEL_SERVICE_URL="http://127.0.0.1:8010"
uvicorn main:app

docker start ocr-postgres-dev

.\venv\Scripts\activate
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:55432/ocr_studio" 
$env:MODEL_SERVICE_URL="http://127.0.0.1:8010"
uvicorn main:app

.\venv\Scripts\activate
$env:VISION_EMBEDDING_MODE="dinov2"
uvicorn model_server:app --host 127.0.0.1 --port 8010