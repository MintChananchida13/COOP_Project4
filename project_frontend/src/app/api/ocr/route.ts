import { NextResponse } from "next/server";
import { db } from "../../../src/lib/db";// ถอยพาร์ทกลับตามโครงสร้างโฟลเดอร์จริง

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { image, rois, documentName, userId } = body;

    // 1. ตรวจสอบข้อมูลเบื้องต้น
    if (!image || !rois || rois.length === 0) {
      return NextResponse.json(
        { error: "ข้อมูลรูปภาพหรือพิกัด ROI ไม่ถูกต้อง" },
        { status: 400 }
      );
    }

    // สมมติ userId ชั่วคราวถ้ายังไม่ได้เชื่อมระบบ Login จริง (เดี๋ยวเราไปผูกกับระบบ Login อีกที)
    const activeUserId = userId || "mock-user-id-123";

    // ตรวจสอบว่ามีผู้ใช้คนนี้ในระบบไหม ถ้าไม่มีให้สร้างเพื่อไม่ให้ Foreign Key พัง
    const userExists = await db.user.findUnique({ where: { id: activeUserId } });
    if (!userExists) {
      await db.user.create({
        data: {
          id: activeUserId,
          email: "user@ocr.com",
          passwordHash: "hashed_password_here",
          role: "USER"
        }
      });
    }

    // 2. บันทึกคำขอ (Request) และกล่องพิกัด (RoiField) ลง SQLite ผ่าน Prisma Transaction
    const newRequest = await db.request.create({
      data: {
        documentName: documentName || "Unclassified Document",
        imageUrl: image, // ตัวแปรเก็บภาพ Base64 หรือ Link รูป
        status: "PENDING", // ตั้งค่าเริ่มต้นให้ไปโผล่ที่หน้า Admin Pending Queue
        userId: activeUserId,
        // เสกสร้างพิกัด ROI ย่อยๆ พร้อมกันในคำสั่งเดียว (Nested Writes)
        roiFields: {
          create: rois.map((roi: any) => ({
            fieldName: roi.fieldName,
            x: parseFloat(roi.x),
            y: parseFloat(roi.y),
            width: parseFloat(roi.width),
            height: parseFloat(roi.height),
          }))
        }
      },
      include: {
        roiFields: true // ดึงข้อมูลที่สร้างเสร็จกลับมาเช็กด้วย
      }
    });

    console.log(`[Database Sync] บันทึกคำขอสำเร็จรหัส ID: ${newRequest.id}`);

    // คืนค่ากลับไปบอกหน้าบ้านว่าบันทึกสำเร็จ เพื่อให้หน้าบ้านรีเฟรชหรือแจ้งเตือน
    return NextResponse.json({
      success: true,
      requestId: newRequest.id,
      message: "บันทึกพิกัดโครงสร้างลงระบบฐานข้อมูลสำเร็จแล้ว"
    }, { status: 200 });

  } catch (error) {
    console.error("Database Save Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}