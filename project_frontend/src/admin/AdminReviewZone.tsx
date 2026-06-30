"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { ArrowLeft, ChevronRight, ShieldAlert } from 'lucide-react';
import AdminReviewStep1 from './AdminReviewStep1';
import AdminReviewStep2 from './AdminReviewStep2';
import AdminReviewStep3 from './AdminReviewStep3';

interface AdminReviewZoneProps {
  requestId: string | number | null;
  requestData: any; 
  onBack: () => void;
  onResolveStatus: (id: string | number, nextStatus: 'Approved' | 'Rejected') => void;
}

export default function AdminReviewZone({ requestId, requestData, onBack, onResolveStatus }: AdminReviewZoneProps) {
  // 🗂️ ขั้นตอนการตรวจสอบของแอดมิน: 'adjust' (ปรับแต่งภาพ) -> 'workspace' (ตีกรอบ ROI) -> 'config' (ตั้งค่าและบันทึก)
  const [reviewStep, setReviewStep] = useState<'adjust' | 'workspace' | 'config'>('adjust');

  // 🛠️ CONFIG ภาพดึงมาจาก AdjustZone
  const [rotation, setRotation] = useState<number>(0);
  const [brightness, setBrightness] = useState<number>(100);
  const [contrast, setContrast] = useState<number>(100);
  const [sharpness, setSharpness] = useState<number>(0);
  const [flipH, setFlipH] = useState<boolean>(false);
  const [flipV, setFlipV] = useState<boolean>(false);

  // 🎯 STATE คุมกล่อง ROI ของแอดมิน (Active ROI Layer)
  const [rois, setRois] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // 👻 STATE เลือกกล่อง Ghost ROI ของผู้ใช้
  const [selectedGhostId, setSelectedGhostId] = useState<number | null>(null);

  // 📝 STATE ข้อมูลบันทึก
  const [templateName, setTemplateName] = useState("");
  const [anchorKeywords, setAnchorKeywords] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 📄 STATE คุมหลายหน้า
  const [currentPageIndex, setCurrentPageIndex] = useState<number>(0);

  // 🎯 แปลงค่าภาพเดี่ยว/หลายหน้า
  const imagesList = useMemo<string[]>(() => {
    if (!requestData?.image) return [];
    if (requestData.image.startsWith('[')) {
      try {
        return JSON.parse(requestData.image) as string[];
      } catch (err) {
        console.error("Failed to parse imagesList JSON:", err);
      }
    }
    return [requestData.image];
  }, [requestData]);

  const documentImage = imagesList[currentPageIndex] || null;
  const userRois = requestData?.rois || []; // พิกัดเดิมของผู้ใช้ (Ghost Layer)

  // โหลดข้อมูลเริ่มต้นจากคำขอ
  useEffect(() => {
    if (requestData) {
      setTemplateName(requestData.docName ? `${requestData.docName.split('.')[0]}_TEMPLATE` : "");
      setCurrentPageIndex(0);
      if (requestData.rois) {
        // คัดลอกพิกัดจาก User เป็น Active ROIs ตั้งต้น เพื่อความสะดวกในการแก้ไขต่อ
        setRois(requestData.rois.map((roi: any) => ({
          ...roi,
          id: roi.id || Date.now() + Math.random(),
          type: roi.type || 'text',
          dataType: roi.dataType || 'string',
          role: roi.role || 'data_extraction',
          weight: roi.weight !== undefined ? roi.weight : 1.0,
          verificationRule: roi.verificationRule || '',
          pageIndex: roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0
        })));
      }
    }
  }, [requestData]);

  // 🪄 คำนวณ CSS Style ผสมผสาน Filters พลิกภาพ และหมุนองศา
  const imageStyle = useMemo(() => {
    let transformStr = `rotate(${rotation}deg)`;
    if (flipH) transformStr += ` scaleX(-1)`;
    if (flipV) transformStr += ` scaleY(-1)`;
    
    return {
      transform: transformStr,
      filter: `brightness(${brightness}%) contrast(${contrast}%) blur(${sharpness < 0 ? Math.abs(sharpness)/10 : 0}px)`,
      transition: 'transform-all 0.2s ease, filter 0.1s ease',
    };
  }, [rotation, brightness, contrast, sharpness, flipH, flipV]);

  // บันทึกเทมเพลตลง Vector Database & PostgreSQL
  const handleApproveAndRegister = async () => {
    if (!templateName) {
      alert("กรุณากรอกชื่อ Template Identity Name ก่อนดำเนินการ");
      return;
    }

    setIsSubmitting(true);
    try {
      const payload = {
        templateName: templateName,
        imageWidth: 1920,
        imageHeight: 1080,
        extracted_data: rois.map(roi => ({
          fieldName: roi.fieldName,
          text: "", 
          extracted_text: "",
          confidence: 1.0,
          saved_path: "",
          type: roi.type || "text",
          dataType: roi.dataType || "string",
          role: roi.role || "data_extraction",
          weight: roi.weight !== undefined ? parseFloat(roi.weight) : 1.0,
          verificationRule: roi.verificationRule || "",
          pageIndex: roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0,
          x: roi.x,
          y: roi.y,
          width: roi.width,
          height: roi.height
        }))
      };

      // 1. บันทึกข้อมูลเทมเพลตลง SQL + Qdrant ของเอนจิน FastAPI
      const response = await fetch("http://localhost:8000/api/templates/approve-and-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error("Failed to register template at FastAPI AI Engine");
      }

      // 2. อัปเดตสถานะของคำขอร้องเรียนในระบบหลังบ้าน SQLite
      if (requestId) {
        await fetch(`/api/ocr?id=${requestId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "APPROVED" })
        });
      }

      alert(`อนุมัติและบันทึกโครงสร้างข้อมูลเทมเพลต "${templateName}" เข้า Qdrant เรียบร้อยแล้ว`);
      onResolveStatus(requestId!, 'Approved');
    } catch (error) {
      console.error(error);
      alert("เกิดข้อผิดพลาดในการลงทะเบียนระบบเวกเตอร์เทมเพลต");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-5 relative animate-fade-in text-slate-800">
      
      {/* 🔼 แถบหัวข้อนำทางและบอกขั้นตอนการรีวิวแบบ Step Progress Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white border border-slate-200/80 px-6 py-4 rounded-2xl shadow-sm">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="px-3.5 py-1.5 text-xs font-bold text-slate-600 hover:text-indigo-600 bg-white border border-slate-200 rounded-xl transition-all flex items-center gap-1.5 active:scale-98"
          >
            <ArrowLeft size={14} /> กลับ Dashboard
          </button>
          <span className="text-xs font-mono text-indigo-600 font-bold bg-indigo-50 border border-indigo-100 px-3 py-1 rounded-xl">
            Request ID: #{requestId}
          </span>
        </div>

        {/* Step Progress Wizard */}
        <div className="flex items-center gap-2 text-xs font-bold text-slate-400 select-none">
          <span className={`px-3 py-1.5 rounded-lg border transition-all ${reviewStep === 'adjust' ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
            1. ปรับแต่งภาพ
          </span>
          <ChevronRight size={14} className="text-slate-300" />
          <span className={`px-3 py-1.5 rounded-lg border transition-all ${reviewStep === 'workspace' ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
            2. จัดวาง ROI
          </span>
          <ChevronRight size={14} className="text-slate-300" />
          <span className={`px-3 py-1.5 rounded-lg border transition-all ${reviewStep === 'config' ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
            3. บันทึกเทมเพลต
          </span>
        </div>
      </div>

      {/* Render Steps */}
      {reviewStep === 'adjust' && (
        <AdminReviewStep1 
          imagesList={imagesList}
          currentPageIndex={currentPageIndex}
          setCurrentPageIndex={setCurrentPageIndex}
          documentImage={documentImage}
          imageStyle={imageStyle}
          brightness={brightness}
          setBrightness={setBrightness}
          contrast={contrast}
          setContrast={setContrast}
          sharpness={sharpness}
          setSharpness={setSharpness}
          rotation={rotation}
          setRotation={setRotation}
          flipH={flipH}
          setFlipH={setFlipH}
          flipV={flipV}
          setFlipV={setFlipV}
          onNext={() => setReviewStep('workspace')}
          onReject={() => setShowRejectModal(true)}
        />
      )}

      {reviewStep === 'workspace' && (
        <AdminReviewStep2 
          documentImage={documentImage}
          imageStyle={imageStyle}
          rois={rois}
          setRois={setRois}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          selectedGhostId={selectedGhostId}
          setSelectedGhostId={setSelectedGhostId}
          currentPageIndex={currentPageIndex}
          setCurrentPageIndex={setCurrentPageIndex}
          imagesList={imagesList}
          userRois={userRois}
          onPrev={() => setReviewStep('adjust')}
          onNext={() => setReviewStep('config')}
        />
      )}

      {reviewStep === 'config' && (
        <AdminReviewStep3 
          documentImage={documentImage}
          imageStyle={imageStyle}
          rois={rois}
          setRois={setRois}
          templateName={templateName}
          setTemplateName={setTemplateName}
          anchorKeywords={anchorKeywords}
          setAnchorKeywords={setAnchorKeywords}
          isSubmitting={isSubmitting}
          currentPageIndex={currentPageIndex}
          setCurrentPageIndex={setCurrentPageIndex}
          imagesList={imagesList}
          onPrev={() => setReviewStep('workspace')}
          onSubmit={handleApproveAndRegister}
        />
      )}

      {/* Pop-up Modal ระบุเหตุผลการยกเลิกคำขอ */}
      {showRejectModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-slate-200 w-full max-w-md p-5 rounded-2xl shadow-xl space-y-4">
            <div className="flex items-center gap-2 text-rose-600 font-bold border-b border-slate-100 pb-2">
              <ShieldAlert size={16} />
              <h4 className="text-xs uppercase tracking-wide">ระบุเหตุผลการปฏิเสธคำขอ</h4>
            </div>
            <textarea
              rows={3}
              placeholder="เช่น ภาพถ่ายสแกนเอียง หรือ กล่องพิกัดไม่ครอบคลุมตัวอักษรจริง..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs font-semibold text-slate-800 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all shadow-sm"
            />
            <div className="flex justify-end gap-2 text-xs font-bold">
              <button type="button" onClick={() => setShowRejectModal(false)} className="px-3.5 py-1.5 bg-slate-100 text-slate-600 rounded-xl">ยกเลิก</button>
              <button type="button" onClick={async () => { 
                if (requestId) {
                  await fetch(`/api/ocr?id=${requestId}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ status: "REJECTED" })
                  });
                }
                alert('ปฏิเสธคำขอเสร็จสิ้น'); 
                onResolveStatus(requestId!, 'Rejected'); 
                setShowRejectModal(false); 
              }} className="px-3.5 py-1.5 bg-rose-600 text-white rounded-xl shadow-sm">ยืนยันปฏิเสธ</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}