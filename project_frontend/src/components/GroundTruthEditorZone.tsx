"use client";

import React, { useState, useRef, useMemo, useEffect } from 'react';
import { ArrowLeft, Save, ZoomIn, ZoomOut, Maximize2, CheckCircle, Edit3, ChevronLeft, ChevronRight, ChevronDown, Copy, FilePlus, Table, Image as ImageIcon, FileText, Eye, EyeOff } from 'lucide-react';
import { ROI, OCRResult } from '../types/ocr';

const renderTypeIcon = (type?: 'text' | 'table' | 'image', size = 11) => {
  if (type === 'table') return <Table size={size} className="shrink-0 text-slate-400" />;
  if (type === 'image') return <ImageIcon size={size} className="shrink-0 text-slate-400" />;
  return <FileText size={size} className="shrink-0 text-slate-400" />;
};

// ✨ เพิ่มสเปกให้ ROI และ OCRResult รองรับ pageIndex 
const CroppedRoiPreview = ({
  previewUrl,
  roi,
  maxWidth = 140
}: {
  previewUrl: string;
  roi: ROI;
  maxWidth?: number;
}) => {
  const [cropSrc, setCropSrc] = useState<string>("");

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const scaleX = img.naturalWidth / 750;
      const scaleY = img.naturalHeight / ((img.naturalHeight / img.naturalWidth) * 750);
      
      const realX = roi.x * scaleX;
      const realY = roi.y * scaleY;
      const realW = roi.width * scaleX;
      const realH = roi.height * scaleY;

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(realW));
      canvas.height = Math.max(1, Math.round(realH));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.save();
      if (roi.points && roi.points.length > 2) {
        ctx.beginPath();
        roi.points.forEach((p, idx) => {
          const px = p.x * scaleX - realX;
          const py = p.y * scaleY - realY;
          if (idx === 0) {
            ctx.moveTo(px, py);
          } else {
            ctx.lineTo(px, py);
          }
        });
        ctx.closePath();
        ctx.clip();
      }

      ctx.drawImage(
        img,
        Math.max(0, realX),
        Math.max(0, realY),
        Math.max(1, realW),
        Math.max(1, realH),
        0,
        0,
        Math.max(1, realW),
        Math.max(1, realH)
      );
      ctx.restore();
      
      setCropSrc(canvas.toDataURL("image/jpeg", 0.9));
    };
    img.src = previewUrl;
  }, [previewUrl, roi]);

  if (!cropSrc) {
    return <div className="animate-pulse bg-slate-100 rounded-lg" style={{ width: `${maxWidth}px`, height: `${maxWidth * 0.7}px` }} />;
  }

  const displayScale = roi.width > maxWidth ? maxWidth / roi.width : 1;
  const displayW = roi.width * displayScale;
  const displayH = roi.height * displayScale;

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden bg-white shadow-inner" style={{ width: `${displayW}px`, height: `${displayH}px` }}>
      <img src={cropSrc} alt="Cropped segment" className="w-full h-full object-contain" />
    </div>
  );
};

interface GroundTruthEditorZoneProps {
  previewUrl: string;
  rois: (ROI & { pageIndex?: number })[]; 
  ocrResults: (OCRResult & { pageIndex?: number })[];
  setOcrResults: React.Dispatch<React.SetStateAction<(OCRResult & { pageIndex?: number })[]>>;
  onBackToStudio: () => void;
  onApproveAndSave: () => Promise<void>;
  
  imageList?: string[];              
  currentImageIndex?: number;         
  onImageIndexChange?: (index: number) => void; 
}

export default function GroundTruthEditorZone({
  previewUrl,
  rois,
  ocrResults,
  setOcrResults,
  onBackToStudio,
  onApproveAndSave,
  imageList = [previewUrl], 
  currentImageIndex = 0,
  onImageIndexChange,
}: GroundTruthEditorZoneProps) {
  
  const [activeFieldId, setActiveFieldId] = useState<number | null>(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState<boolean>(false);
  const [isSubmittingRequest, setIsSubmittingRequest] = useState<boolean>(false);
  const [showLabels, setShowLabels] = useState<boolean>(true);

  // 🛡️ ตั้งค่า originalText เริ่มต้นจาก extractedText หากยังไม่ระบุ เพื่อคงค่าดั้งเดิมของ OCR
  useEffect(() => {
    let changed = false;
    const updated = ocrResults.map(item => {
      if (item.originalText === undefined) {
        changed = true;
        return { ...item, originalText: item.extractedText };
      }
      return item;
    });
    if (changed) {
      setOcrResults(updated);
    }
  }, [ocrResults, setOcrResults]);

  const handleRequestTemplate = async (option: number) => {
    setIsDropdownOpen(false);
    setIsSubmittingRequest(true);

    try {
      let roisToSend: any[] = [];
      let docNameSuffix = "";
      let flagMessage = "";

      if (option === 1) {
        roisToSend = rois.map(roi => ({
          fieldName: roi.fieldName,
          x: roi.x,
          y: roi.y,
          width: roi.width,
          height: roi.height,
          pageIndex: roi.pageIndex !== undefined ? roi.pageIndex : 0,
          type: roi.type || 'text',
          dataType: roi.dataType || 'string',
          role: roi.role || 'data_extraction',
          weight: roi.weight !== undefined ? roi.weight : 1.0,
          verificationRule: roi.verificationRule || ''
        }));
        docNameSuffix = " (ROI Spec)";
        flagMessage = "สร้างเทมเพลตจากพิกัด ROI ต้นแบบ";

        if (roisToSend.length === 0) {
          alert("ไม่พบพิกัด ROI ในระบบ กรุณาวาดกล่องข้อความก่อนส่งคำขอตัวเลือกนี้");
          setIsSubmittingRequest(false);
          return;
        }
      } else {
        roisToSend = [];
        docNameSuffix = " [New Template Request]";
        flagMessage = "ร้องขอเทมเพลตสำหรับเอกสารประเภทใหม่ (New Document Type)";
      }

      const docName = `Request_Page_${currentImageIndex + 1}${docNameSuffix}`;

      const response = await fetch("/api/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: JSON.stringify(imageList), // เซอร์เรียลไลซ์รายการทุกหน้า
          rois: roisToSend,
          documentName: docName,
          userId: "user-request-template"
        })
      });

      const data = await response.json();
      if (response.ok && data.success) {
        alert(`ส่งคำขอไปยังผู้ดูแลระบบเรียบร้อยแล้ว\n\nประเภทคำขอ: ${flagMessage}\nรหัสคำขอ: #${data.requestId}`);
      } else {
        alert(`เกิดข้อผิดพลาด: ${data.error || "ไม่สามารถดำเนินงานได้"}`);
      }
    } catch (err) {
      console.error(err);
      alert("เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์");
    } finally {
      setIsSubmittingRequest(false);
    }
  };
  const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
  const [zoomIndex, setZoomIndex] = useState<number>(2); 
  const currentZoom = ZOOM_STEPS[zoomIndex];
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // 🛡️ กรองกรอบ ROI ให้ดึงมาเฉพาะของหน้าปัจจุบัน
  const currentPageRois = useMemo(() => {
    return rois.filter(roi => roi.pageIndex === currentImageIndex);
  }, [rois, currentImageIndex]);

  // 🛡️ กรองผลลัพธ์ OCR ให้แสดงในตารางเฉพาะของหน้าปัจจุบันเท่านั้น
  const currentPageOcrResults = useMemo(() => {
    return ocrResults.filter(res => res.pageIndex === currentImageIndex);
  }, [ocrResults, currentImageIndex]);

  const getRoiByFieldName = (fieldName: string) => {
    return currentPageRois.find(roi => roi.fieldName === fieldName);
  };

  const handlePrevImage = () => {
    if (onImageIndexChange && currentImageIndex > 0) {
      onImageIndexChange(currentImageIndex - 1);
      setActiveFieldId(null); // เคลียร์ฟิลด์ที่เลือกเมื่อย้ายหน้า
    }
  };

  const handleNextImage = () => {
    if (onImageIndexChange && currentImageIndex < imageList.length - 1) {
      onImageIndexChange(currentImageIndex + 1);
      setActiveFieldId(null); // เคลียร์ฟิลด์ที่เลือกเมื่อย้ายหน้า
    }
  };

  const autoResizeTextarea = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    target.style.height = "auto";
    target.style.height = `${target.scrollHeight}px`;
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-20 animate-fade-in">
      
      {/* 📊 STEP PROCESS PROGRESS BAR */}
      <div className="w-full bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3 w-full max-w-3xl mx-auto justify-between relative">
          <div className="flex items-center gap-2.5 bg-white pr-4 z-10">
            <div className="w-6 h-6 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-600 font-bold text-xs flex items-center justify-center">✓</div>
            <p className="text-xs font-semibold text-slate-400">Pre-processing</p>
          </div>
          <div className="flex items-center gap-2.5 bg-white px-4 z-10">
            <div className="w-6 h-6 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-600 font-bold text-xs flex items-center justify-center">✓</div>
            <p className="text-xs font-semibold text-slate-400">ROI Studio</p>
          </div>
          <div className="flex items-center gap-2.5 bg-white pl-4 z-10">
            <div className="w-6 h-6 rounded-full bg-indigo-600 text-white font-bold text-xs flex items-center justify-center ring-4 ring-indigo-100">3</div>
            <p className="text-xs font-bold text-slate-800">Ground Truth Editor</p>
          </div>
        </div>
      </div>

      {/* 💻 LAYOUT */}
      <div className="grid grid-cols-12 gap-6 h-[720px]">
        
        {/* 🎨 👈 ฝั่งซ้าย: กระดานแสดงภาพเอกสาร */}
        <div className="col-span-5 bg-[#edf2f7] border border-slate-200 rounded-xl overflow-hidden flex flex-col h-full relative shadow-md">
          {/* Header controls for left canvas */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-white border-b border-slate-200">
            <span className="text-xs font-black text-slate-600 uppercase tracking-wider">เอกสารพรีวิว</span>
            <button
              type="button"
              onClick={() => setShowLabels(prev => !prev)}
              className={`p-1.5 rounded-lg border transition-all flex items-center gap-1.5 text-[10px] font-bold cursor-pointer ${
                !showLabels 
                  ? 'bg-amber-50 text-amber-600 border-amber-250 shadow-sm' 
                  : 'bg-slate-50 text-slate-500 hover:bg-slate-100 border-slate-200'
              }`}
              title={showLabels ? "ซ่อนชื่อฟิลด์บนภาพ" : "แสดงชื่อฟิลด์บนภาพ"}
            >
              {showLabels ? <Eye size={12} /> : <EyeOff size={12} />}
              <span>{showLabels ? "ซ่อนป้ายชื่อ" : "แสดงป้ายชื่อ"}</span>
            </button>
          </div>

          <div 
            ref={viewportRef}
            className="w-full flex-1 overflow-auto p-4 flex items-start justify-start shadow-inner relative"
          >
            <div 
              className="relative inline-block"
              style={{ 
                transform: `scale(${currentZoom * 0.6})`, 
                transformOrigin: "top left",
                transition: "transform 0.1s ease-out"
              }}
            >
              <div className="relative w-[750px] h-auto bg-transparent">
                <img 
                  src={previewUrl} 
                  alt="Review Target" 
                  className="w-full h-auto block select-none rounded bg-white border border-slate-700 shadow-sm"
                />

                {/* 🎯 เลเยอร์วาดกล่องไฮไลต์เชื่อมโยงข้อมูล (กรองเฉพาะหน้าปัจจุบัน) */}
                <div className="absolute inset-0 top-0 left-0 w-full h-full pointer-events-none">
                  {currentPageOcrResults.map((res) => {
                    const matchedRoi = getRoiByFieldName(res.fieldName);
                    if (!matchedRoi) return null;
                    const isCurrentActive = activeFieldId === res.id;
                    const hasPoints = matchedRoi.points && matchedRoi.points.length > 0;

                    return (
                      <div
                        key={res.id}
                        onClick={() => setActiveFieldId(res.id)}
                        className={`absolute border cursor-pointer transition-all duration-300 pointer-events-auto ${
                          hasPoints 
                            ? 'border-transparent bg-transparent shadow-none' 
                            : (isCurrentActive 
                                ? "border-orange-500 bg-orange-500/15 ring-4 ring-orange-500/20 z-30 shadow-lg scale-[1.01]" 
                                : "border-slate-300 bg-slate-100/5 hover:border-slate-400 hover:bg-slate-100/10 z-10")
                        }`}
                        style={{
                          left: matchedRoi.x,
                          top: matchedRoi.y,
                          width: matchedRoi.width,
                          height: matchedRoi.height,
                        }}
                      >
                        {/* SVG Polygon overlay for Quad/Polygon ROIs */}
                        {matchedRoi.points && matchedRoi.points.length > 0 && (
                          <svg className="absolute inset-0 w-full h-full pointer-events-none z-10 overflow-visible">
                            <polygon
                              points={matchedRoi.points.map(p => `${p.x - matchedRoi.x},${p.y - matchedRoi.y}`).join(' ')}
                              fill={isCurrentActive ? "rgba(249, 115, 22, 0.16)" : "rgba(148, 163, 184, 0.05)"}
                              stroke={isCurrentActive ? "#f97316" : "#94a3b8"}
                              strokeWidth="2"
                              strokeDasharray={isCurrentActive ? "0" : "3,3"}
                            />
                          </svg>
                        )}

                        {showLabels && (
                          <span className={`absolute -top-5 left-0 px-1.5 py-0.5 text-[9px] font-sans rounded shadow font-bold border transition-all ${
                            isCurrentActive 
                              ? "bg-orange-600 border-orange-600 text-white font-extrabold z-40" 
                              : "bg-white border-slate-300 text-slate-500 font-semibold"
                          }`}>
                            {res.fieldName}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* แผงควบคุมซูม */}
          <div className="absolute bottom-24 right-4 bg-white border border-slate-200 rounded-lg p-1 flex items-center gap-2 shadow-md z-20 text-slate-700">
            <button type="button" onClick={() => zoomIndex > 0 && setZoomIndex(prev => prev - 1)} className="p-1 hover:bg-slate-100 rounded text-slate-500"><ZoomOut size={12} /></button>
            <span className="text-[10px] font-mono font-bold w-10 text-center text-slate-650">{Math.round(currentZoom * 100)}%</span>
            <button type="button" onClick={() => zoomIndex < ZOOM_STEPS.length - 1 && setZoomIndex(prev => prev + 1)} className="p-1 hover:bg-slate-100 rounded text-slate-500"><ZoomIn size={12} /></button>
            <button type="button" onClick={() => setZoomIndex(2)} className="p-1 hover:bg-slate-100 rounded text-slate-400"><Maximize2 size={10} /></button>
          </div>

          {/* 🎞️ Carousel แถบเลือกหน้า */}
          <div className="bg-[#edf2f7] border-t border-slate-200 p-3 flex flex-col gap-2 select-none">
            <div className="flex items-center justify-between px-1">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">เอกสารทั้งหมด ({imageList.length} ไฟล์)</span>
              <span className="text-[10px] font-mono bg-white text-slate-700 border border-slate-200 px-1.5 py-0.5 rounded font-bold">
                หน้า {currentImageIndex + 1} / {imageList.length}
              </span>
            </div>
            
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePrevImage}
                disabled={currentImageIndex === 0}
                className="p-1.5 rounded-lg bg-white border border-slate-250 text-slate-650 hover:bg-slate-50 disabled:opacity-30 transition-all flex items-center justify-center"
              >
                <ChevronLeft size={16} />
              </button>

              <div className="flex-1 flex gap-2 overflow-x-auto py-1 scrollbar-thin scrollbar-thumb-slate-300">
                {imageList.map((imgUrl, idx) => {
                  const isCurrent = idx === currentImageIndex;
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        if (onImageIndexChange) onImageIndexChange(idx);
                        setActiveFieldId(null);
                      }}
                      className={`relative flex-shrink-0 w-12 h-14 rounded border-2 transition-all overflow-hidden bg-white ${
                        isCurrent ? 'border-indigo-500 ring-2 ring-indigo-500/30 scale-105' : 'border-slate-250 opacity-60 hover:opacity-100'
                      }`}
                    >
                      <img src={imgUrl} alt={`Page ${idx + 1}`} className="w-full h-full object-cover" />
                      <div className="absolute bottom-0 inset-x-0 bg-slate-200/90 text-[8px] text-slate-700 text-center py-0.5 font-mono">
                        #{idx + 1}
                      </div>
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={handleNextImage}
                disabled={currentImageIndex === imageList.length - 1}
                className="p-1.5 rounded-lg bg-white border border-slate-250 text-slate-650 hover:bg-slate-50 disabled:opacity-30 transition-all flex items-center justify-center"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </div>

        {/* 📊 👉 ฝั่งขวา: ตารางข้อมูล (กรองผลลัพธ์เฉพาะหน้าปัจจุบัน) */}
        <div className="col-span-7 bg-white border border-slate-200 rounded-xl shadow-sm flex flex-col h-full overflow-hidden">
          <div className="p-4 border-b flex justify-between items-center bg-slate-50/50">
            <button
              type="button"
              onClick={onBackToStudio}
              className="py-1.5 px-3 hover:bg-slate-200/70 text-slate-600 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all"
            >
              <ArrowLeft size={14} /> กลับไปปรับกล่อง
            </button>
            <h3 className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
              <CheckCircle size={15} className="text-indigo-600" /> ตรวจสอบความถูกต้องและอนุมัติผลลัพธ์
            </h3>
          </div>

          <div className="overflow-y-auto flex-1">
            <table className="min-w-full text-xs text-left text-slate-600 table-fixed border-collapse">
              <thead className="bg-slate-50 font-sans text-slate-500 font-semibold border-b border-slate-100 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-3 w-[22%]">Field Channel</th>
                  <th className="px-4 py-3 w-[39%]">ช่องที่ OCR อ่านได้</th>
                  <th className="px-4 py-3 w-[39%]">ช่องที่แก้คำได้</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {currentPageOcrResults.map((res) => {
                  const isSelected = activeFieldId === res.id;
                  const matchedRoi = getRoiByFieldName(res.fieldName);
                  return (
                    <tr 
                      key={res.id} 
                      onClick={() => setActiveFieldId(res.id)} 
                      className={`group cursor-pointer transition-all ${isSelected ? 'bg-indigo-50/40 border-l-4 border-l-indigo-500 font-medium' : 'hover:bg-slate-50/50'}`}
                    >
                      {/* คอลัมน์ 1: ฟิลด์ */}
                      <td className="px-4 py-4 align-top" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-center gap-1 bg-transparent border border-transparent rounded px-1 group-hover:border-slate-200 focus-within:border-indigo-400 focus-within:bg-white transition-all">
                            <input
                              type="text"
                              value={res.fieldName}
                              onFocus={() => setActiveFieldId(res.id)}
                              onChange={(e) => setOcrResults(p => p.map(item => item.id === res.id ? { ...item, fieldName: e.target.value } : item))}
                              className="w-full bg-transparent font-bold text-slate-700 focus:outline-none py-1 text-xs truncate"
                              placeholder="ระบุชื่อฟิลด์..."
                            />
                            <Edit3 size={12} className="text-slate-300 group-hover:text-slate-400 flex-shrink-0" />
                          </div>
                          {matchedRoi && (
                            <div className="flex items-center gap-1.5 px-1 text-[9px] font-bold text-slate-400 uppercase select-none">
                              {renderTypeIcon(matchedRoi.type, 10)}
                              <span>Type: {matchedRoi.type || 'text'}</span>
                            </div>
                          )}
                        </div>
                      </td>
                      
                      {/* คอลัมน์ 2: ช่องที่ OCR อ่านได้ */}
                      <td className="px-4 py-4 align-top w-[39%]">
                        <div className="flex flex-col gap-1.5 h-full justify-between">
                          {matchedRoi?.type === 'image' ? (
                            <div className="flex flex-col gap-1 bg-white border border-slate-200 p-1.5 rounded-xl w-fit shadow-xs">
                              <CroppedRoiPreview previewUrl={previewUrl} roi={matchedRoi} />
                              <span className="text-[9px] font-bold text-slate-400">รูปภาพพิกัดครอบตัด</span>
                            </div>
                          ) : (
                            <div className="w-full bg-slate-50 border border-slate-200/80 rounded-xl px-3 py-2 text-slate-650 font-medium text-xs break-words leading-relaxed shadow-sm">
                              {res.originalText || <span className="text-slate-400 italic">(ไม่มีข้อความ)</span>}
                            </div>
                          )}
                          <span className={`w-fit px-1.5 py-0.5 rounded text-[10px] font-mono font-bold mt-1 ${res.confidence >= 0.8 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                            Confidence: {(res.confidence * 100).toFixed(1)}%
                          </span>
                        </div>
                      </td>
                      
                      {/* คอลัมน์ 3: ช่องที่แก้คำได้ */}
                      <td className="px-4 py-4 align-top w-[39%]" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-col gap-1.5 h-full justify-between">
                          {matchedRoi?.type === 'image' ? (
                            <div className="w-full bg-slate-50/50 border border-dashed border-slate-200 rounded-xl px-3 py-3 text-slate-400 font-bold text-center text-xs">
                              รูปภาพอ้างอิง (ไม่มีข้อความ)
                            </div>
                          ) : (
                            <textarea 
                              value={res.extractedText} 
                              onFocus={() => setActiveFieldId(res.id)} 
                              onInput={autoResizeTextarea}
                              ref={(el) => {
                                if (el) {
                                  el.style.height = "auto";
                                  el.style.height = `${el.scrollHeight}px`;
                                }
                              }}
                              onChange={(e) => setOcrResults(p => p.map(item => item.id === res.id ? { ...item, extractedText: e.target.value } : item))} 
                              className="w-full bg-slate-50/50 border border-slate-200 rounded-xl px-3 py-2 text-slate-800 font-medium text-xs leading-relaxed resize-none overflow-hidden focus:outline-none focus:border-indigo-500 focus:bg-white transition-all shadow-inner" 
                              placeholder="พิมพ์เพื่อแก้ไขคำคัดลอก..."
                              rows={1}
                            />
                          )}
                          <div className="text-[10px] py-0.5 opacity-0 select-none pointer-events-none mt-1" aria-hidden="true">
                            Spacer
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {/* ℹ️ กรณีหน้านี้ไม่มีการสลักกล่อง OCR ไว้เลย */}
                {currentPageOcrResults.length === 0 && (
                  <tr>
                    <td colSpan={3} className="text-center py-20 text-slate-400 font-medium bg-slate-50/50">
                      ไม่พบกล่องข้อมูล OCR บนหน้าปัจจุบัน <br />
                      <span className="text-[11px] font-normal text-slate-400">โปรดย้อนกลับไปลากกล่องดักจับที่ขั้นตอน ROI Studio</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="p-4 border-t bg-slate-50/50 flex gap-3 relative">
            <button 
              type="button"
              onClick={onApproveAndSave} 
              className="flex-grow py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-indigo-600/10 flex items-center justify-center gap-2"
            >
              <Save size={15} /> Approve & Commit Sync
            </button>

            {/* Dropdown Action Menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsDropdownOpen(prev => !prev)}
                disabled={isSubmittingRequest}
                className="h-full px-4 py-3 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-xl text-xs font-bold transition-all shadow-sm flex items-center justify-center gap-1.5 active:scale-98 disabled:opacity-50"
              >
                Request New Template
                <ChevronDown size={14} className={`transition-transform duration-200 ${isDropdownOpen ? 'rotate-180' : ''}`} />
              </button>

              {isDropdownOpen && (
                <>
                  {/* Overlay background to close dropdown on click outside */}
                  <div className="fixed inset-0 z-30" onClick={() => setIsDropdownOpen(false)} />
                  
                  <div className="absolute right-0 bottom-full mb-2 w-72 bg-white border border-slate-200 rounded-2xl shadow-xl z-40 p-1.5 animate-fade-in origin-bottom-right">
                    <button
                      type="button"
                      onClick={() => handleRequestTemplate(1)}
                      className="w-full text-left p-3 rounded-xl hover:bg-slate-50 transition-colors flex items-start gap-2.5 group"
                    >
                      <div className="p-2 rounded-lg bg-indigo-50 text-indigo-600 group-hover:bg-indigo-100 transition-colors shrink-0">
                        <Copy size={15} />
                      </div>
                      <div>
                        <p className="text-[11px] font-bold text-slate-800">Request Template from Current ROI</p>
                        <p className="text-[9px] text-slate-400 font-medium leading-relaxed mt-0.5">
                          ส่งค่าพิกัดกล่อง (ROI) ที่วาดไว้ตอนนี้ เพื่อใช้เป็นโครงร่างเทมเพลตมาตรฐาน
                        </p>
                      </div>
                    </button>
                    
                    <div className="h-[1px] bg-slate-100 my-1.5" />
                    
                    <button
                      type="button"
                      onClick={() => handleRequestTemplate(2)}
                      className="w-full text-left p-3 rounded-xl hover:bg-slate-50 transition-colors flex items-start gap-2.5 group"
                    >
                      <div className="p-2 rounded-lg bg-amber-50 text-amber-600 group-hover:bg-amber-100 transition-colors shrink-0">
                        <FilePlus size={15} />
                      </div>
                      <div>
                        <p className="text-[11px] font-bold text-slate-800">Request for New Document Type</p>
                        <p className="text-[9px] text-slate-400 font-medium leading-relaxed mt-0.5">
                          ร้องขอสร้างเทมเพลตประเภทใหม่ด้วยภาพต้นฉบับ โดยไม่ใช้พิกัดที่วาด
                        </p>
                      </div>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}