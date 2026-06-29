"use client";

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { 
  ArrowLeft, Check, X, ShieldAlert, KeyRound, FileText, 
  RotateCw, RotateCcw, RefreshCw, Square, Trash2, Sliders, Layers,
  Plus, Minus, FlipHorizontal, FlipVertical
} from 'lucide-react';
import { Rnd } from 'react-rnd';

interface AdminReviewZoneProps {
  requestId: number | null;
  requestData: any; 
  onBack: () => void;
  onResolveStatus: (id: number, nextStatus: 'Approved' | 'Rejected') => void;
}

export default function AdminReviewZone({ requestId, requestData, onBack, onResolveStatus }: AdminReviewZoneProps) {
  // 🗂️ แท็บหลักของแอดมิน: 'workspace' (จัดการกล่องพิกัด) หรือ 'adjust' (ปรับแต่งภาพ)
  const [activeTab, setActiveTab] = useState<'workspace' | 'adjust'>('workspace');

  // 🛠️ CONFIG ภาพดึงมาจาก AdjustZone ครบทุกตัวแปร
  const [rotation, setRotation] = useState<number>(0);
  const [brightness, setBrightness] = useState<number>(100);
  const [contrast, setContrast] = useState<number>(100);
  const [sharpness, setSharpness] = useState<number>(0);
  const [flipH, setFlipH] = useState<boolean>(false);
  const [flipV, setFlipV] = useState<boolean>(false);

  // 🎯 STATE คุมกล่อง ROI ดึงมาจาก WorkspaceZone 
  const [rois, setRois] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // 📝 STATE ข้อมูลบันทึก
  const [templateName, setTemplateName] = useState("");
  const [anchorKeywords, setAnchorKeywords] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const documentImage = requestData?.image || null;
  const canvasRef = useRef<HTMLDivElement>(null);

  // โหลดข้อมูลเริ่มต้นจากคำขอ
  useEffect(() => {
    if (requestData) {
      setTemplateName(requestData.docName ? `${requestData.docName.split('.')[0]}_TEMPLATE` : "");
      if (requestData.rois) {
        setRois(requestData.rois);
      }
    }
  }, [requestData]);

  // 🪄 คำนวณ CSS Style ผสมผสาน Filters พลิกภาพ และหมุนองศาแบบละเอียดยิบ
  const imageStyle = useMemo(() => {
    let transformStr = `rotate(${rotation}deg)`;
    if (flipH) transformStr += ` scaleX(-1)`;
    if (flipV) transformStr += ` scaleY(-1)`;
    
    return {
      transform: transformStr,
      filter: `brightness(${brightness}%) contrast(${contrast}%) blur(${sharpness < 0 ? Math.abs(sharpness)/10 : 0}px)`,
      transition: 'transform 0.2s ease, filter 0.1s ease',
    };
  }, [rotation, brightness, contrast, sharpness, flipH, flipV]);

  // ➕ ฟังก์ชันเพิ่มกล่องพิกัด ROI ใหม่บนหน้าจอ
  const handleAddNewROI = () => {
    const newId = Date.now();
    const newRoi = {
      id: newId,
      fieldName: `field_${rois.length + 1}`,
      x: 60,
      y: 60,
      width: 140,
      height: 40
    };
    setRois([...rois, newRoi]);
    setSelectedId(newId);
  };

  const handleUpdateROI = (id: number, updatedFields: any) => {
    setRois(prev => prev.map(roi => roi.id === id ? { ...roi, ...updatedFields } : roi));
  };

  const handleDeleteROI = (id: number) => {
    setRois(prev => prev.filter(roi => roi.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const handleApproveAndRegister = async () => {
    if (!templateName) {
      alert("กรุณากรอกชื่อ Template Identity Name ก่อนครับ!");
      return;
    }

    setIsSubmitting(true);
    setTimeout(() => {
      setIsSubmitting(false);
      alert(`🎉 อนุมัติและบันทึกโครงสร้างข้อมูลเทมเพลต "${templateName}" (${rois.length} ฟิลด์) เรียบร้อย!`);
      onResolveStatus(requestId!, 'Approved');
    }, 1000);
  };

  // แผงลิสต์ข้อมูลสำหรับ Render แถบ Adjust สไลเดอร์ ดึงโครงสร้างมาจาก AdjustZone เป๊ะๆ
  const adjustControls = [
    { label: "ความสว่างภาพ (Brightness)", key: "brightness", min: 50, max: 150, value: brightness, setVal: setBrightness, step: 5, resetVal: 100 },
    { label: "ความคมชัดตัดโทน (Contrast)", key: "contrast", min: 50, max: 150, value: contrast, setVal: setContrast, step: 5, resetVal: 100 },
    { label: "ความเบลอภาพนวล (Softness Blur)", key: "sharpness", min: 0, max: 10, value: sharpness, setVal: setSharpness, step: 1, resetVal: 0 }
  ];

  return (
    <div className="space-y-5 relative">
      {/* 🔼 TOP BAR: เมนูย้อนกลับ และ แถบควบคุม Tabs สลับหน้าจอดีไซน์เนียนตา */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white border border-slate-200/80 px-5 py-3 rounded-2xl shadow-sm">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="px-3.5 py-1.5 text-xs font-bold text-slate-600 hover:text-indigo-600 bg-white border border-slate-200 hover:border-indigo-100 rounded-xl transition-all flex items-center gap-1.5 active:scale-98"
          >
            <ArrowLeft size={14} /> กลับหน้า Dashboard
          </button>
          <span className="text-xs font-mono text-indigo-600 font-bold bg-indigo-50 border border-indigo-100 px-3 py-1 rounded-xl">
            แก้ไขคำขอ ID: #{requestId}
          </span>
        </div>

        {/* ปุ่มสลับโหมด แท็บเครื่องมือ */}
        <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200/50 text-xs font-bold">
          <button
            type="button"
            onClick={() => setActiveTab('workspace')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg transition-all ${activeTab === 'workspace' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            <Layers size={13} /> โหมดคุมกล่องข้อความ (Workspace)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('adjust')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg transition-all ${activeTab === 'adjust' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            <Sliders size={13} /> โหมดปรับแต่งภาพ (Adjust)
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* 💻 ซีกซ้าย: INTERACTIVE LIVE CANVAS STUDIO แสดงผลและลากวางวัตถุ */}
        <div className="lg:col-span-7 bg-white border border-slate-200/80 rounded-2xl overflow-hidden shadow-sm p-5 flex flex-col items-center">
          <div className="w-full border-b border-slate-100 pb-3 mb-4 flex items-center justify-between">
            <span className="text-xs font-bold text-slate-800">
              {activeTab === 'workspace' ? 'Interactive Workspace Canvas (750px standard)' : 'Image Enhancement Studio Preview'}
            </span>
            {activeTab === 'workspace' && (
              <button
                type="button"
                onClick={handleAddNewROI}
                className="px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-black uppercase rounded-lg shadow-sm flex items-center gap-1 transition-all"
              >
                <Square size={11} /> ลากกล่องข้อความเพิ่ม +
              </button>
            )}
          </div>

          {/* กระดานแคนวาสจำลองสำหรับแก้ไขงาน */}
          <div 
            ref={canvasRef}
            className="relative w-full max-w-[450px] aspect-[1/1.4] bg-slate-50 border border-slate-200/60 rounded-xl flex items-center justify-center overflow-hidden shadow-inner"
          >
            {documentImage ? (
              <img 
                src={documentImage} 
                alt="Admin Live Workspace" 
                style={imageStyle}
                className="w-full h-full object-contain select-none pointer-events-none"
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 p-6 text-center select-none">
                <FileText size={38} className="stroke-[1.5] mb-2 text-slate-300" />
                <p className="text-xs font-bold text-slate-500">ไฟล์ทดสอบด่วน</p>
              </div>
            )}

            {/* ระบบพิกัดลากวางสไตล์ WorkspaceZone ทำงานเฉพาะแท็บ Workspace */}
            {activeTab === 'workspace' && rois.map((roi) => {
              const isSelected = selectedId === roi.id;
              return (
                <Rnd
                  key={roi.id}
                  bounds="parent"
                  size={{ width: roi.width, height: roi.height }}
                  position={{ x: roi.x, y: roi.y }}
                  onDragStop={(e, d) => handleUpdateROI(roi.id, { x: d.x, y: d.y })}
                  onResizeStop={(e, direction, ref, delta, position) => {
                    handleUpdateROI(roi.id, {
                      width: parseInt(ref.style.width),
                      height: parseInt(ref.style.height),
                      ...position
                    });
                  }}
                  onMouseDown={() => setSelectedId(roi.id)}
                  className={`absolute border-2 rounded shadow-sm flex items-center justify-center group ${isSelected ? 'border-indigo-600 bg-indigo-600/15 z-20' : 'border-slate-400 bg-slate-400/5 z-10'}`}
                >
                  <div className="relative w-full h-full flex items-center justify-center text-center p-0.5 select-none">
                    <input
                      type="text"
                      value={roi.fieldName || ""}
                      onChange={(e) => handleUpdateROI(roi.id, { fieldName: e.target.value })}
                      className="w-full bg-white/95 border border-slate-200 rounded text-[9px] font-bold text-slate-800 text-center focus:outline-none focus:border-indigo-500 px-0.5"
                    />
                    {/* ปุ่มกดลบกล่องติดมุม */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteROI(roi.id);
                      }}
                      className="absolute -top-1.5 -right-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-full p-0.5 shadow-sm transition-opacity"
                    >
                      <Trash2 size={9} />
                    </button>
                  </div>
                </Rnd>
              );
            })}
          </div>
        </div>

        {/* ⚙️ ซีกขวา: CONTROL PANEL แผงฟังก์ชันควบคุม (ถอดแบบกลไกลูกเล่นมาครบถ้วน) */}
        <div className="lg:col-span-5 space-y-5">
          <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-5">
            
            {/* 🛠️ RENDER: แผงควบคุมฟิลเตอร์ภาพ (กรณี Active แท็บ AdjustZone) */}
            {activeTab === 'adjust' ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <h3 className="text-xs font-black text-slate-800 uppercase tracking-wide">เครื่องมือปรับโครงสร้างรูปภาพ</h3>
                  <button 
                    onClick={() => { setRotation(0); setBrightness(100); setContrast(100); setSharpness(0); setFlipH(false); setFlipV(false); }}
                    className="text-[10px] font-bold text-slate-400 hover:text-indigo-600 flex items-center gap-1"
                  >
                    <RefreshCw size={10} /> รีเซ็ตแต่งภาพทั้งหมด
                  </button>
                </div>

                {/* ส่วนหมุนและกลับฝั่งรูปภาพ ดึงมาจากกล่องด้านบนของ AdjustZone */}
                <div className="space-y-1.5">
                  <span className="text-[11px] font-bold text-slate-500 block">หมุนภาพและการกลับด้านสลับฝั่ง (Transform)</span>
                  <div className="grid grid-cols-4 gap-1.5">
                    <button onClick={() => setRotation(r => (r - 90) % 360)} className="py-2 border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-xl flex flex-col items-center justify-center text-[10px] font-bold gap-1"><RotateCcw size={14} /> -90°</button>
                    <button onClick={() => setRotation(r => (r + 90) % 360)} className="py-2 border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-xl flex flex-col items-center justify-center text-[10px] font-bold gap-1"><RotateCw size={14} /> +90°</button>
                    <button onClick={() => setFlipH(f => !f)} className={`py-2 border rounded-xl flex flex-col items-center justify-center text-[10px] font-bold gap-1 ${flipH ? 'bg-indigo-50 border-indigo-200 text-indigo-600':'border-slate-200 hover:bg-slate-50 text-slate-600'}`}><FlipHorizontal size={14} /> กลับแนวนอน</button>
                    <button onClick={() => setFlipV(f => !f)} className={`py-2 border rounded-xl flex flex-col items-center justify-center text-[10px] font-bold gap-1 ${flipV ? 'bg-indigo-50 border-indigo-200 text-indigo-600':'border-slate-200 hover:bg-slate-50 text-slate-600'}`}><FlipVertical size={14} /> กลับแนวตั้ง</button>
                  </div>
                </div>

                {/* สไลเดอร์สเกลค่าฟิลเตอร์ ดึงตัวควบคุมบวกลบสเต็ปมาจาก AdjustZone */}
                <div className="space-y-4 pt-2">
                  {adjustControls.map((item) => (
                    <div key={item.key} className="space-y-1.5 bg-slate-50/60 p-3 rounded-xl border border-slate-100">
                      <div className="flex justify-between text-[11px] font-bold text-slate-700">
                        <span>{item.label}</span>
                        <span className="text-indigo-600 font-mono font-bold">{item.value}%</span>
                      </div>
                      <input 
                        type="range" min={item.min} max={item.max} value={item.value} 
                        onChange={(e) => item.setVal(parseInt(e.target.value))}
                        className="w-full accent-indigo-600 h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer"
                      />
                      <div className="flex items-center gap-1 pt-1.5">
                        <button type="button" onClick={() => item.setVal(v => Math.max(item.min, v - item.step))} className="text-[10px] font-bold bg-white border border-slate-200 px-2 py-0.5 rounded text-slate-600 hover:bg-slate-50"><Minus size={9} className="inline" />-{item.step}</button>
                        <button type="button" onClick={() => item.setVal(v => Math.min(item.max, v + item.step))} className="text-[10px] font-bold bg-white border border-slate-200 px-2 py-0.5 rounded text-slate-600 hover:bg-slate-50"><Plus size={9} className="inline" />+{item.step}</button>
                        <button type="button" onClick={() => item.setVal(item.resetVal)} className="text-[10px] font-semibold text-slate-400 hover:text-slate-600 ml-auto"><RefreshCw size={9} className="inline mr-0.5" /> รีเซ็ต</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              // 🎯 RENDER: แผงควบคุมผูกฟิลเตอร์ข้อมูลหลัก (กรณี Active แท็บ WorkspaceZone)
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
                  <KeyRound className="text-indigo-600" size={15} />
                  <h3 className="text-xs font-black text-slate-800 uppercase tracking-wide">ตั้งค่าการบันทึกระบบลงทะเบียน</h3>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Template Identity Name</label>
                  <input
                    type="text"
                    placeholder="เช่น INVOICE_TYPE_A_V1"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Anchor Keywords</label>
                  <textarea
                    rows={2}
                    placeholder="ชุดคำสำคัญแยกประเภทเอกสาร..."
                    value={anchorKeywords}
                    onChange={(e) => setAnchorKeywords(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all resize-none"
                  />
                </div>

                {/* รายการแสดงผลกล่องพิกัด ROI ทั้งหมดที่มีบนระบบแคนวาส */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">รายชื่อฟิลด์พิกัดข้อความ ({rois.length})</label>
                  <div className="space-y-1 max-h-[150px] overflow-y-auto pr-0.5">
                    {rois.length > 0 ? (
                      rois.map((roi) => (
                        <div 
                          key={roi.id} 
                          onClick={() => setSelectedId(roi.id)}
                          className={`flex items-center justify-between px-3 py-2 border rounded-xl text-xs font-semibold cursor-pointer transition-all ${selectedId === roi.id ? 'bg-indigo-50 border-indigo-200 text-indigo-700 shadow-sm' : 'bg-slate-50/60 border-slate-100 text-slate-700 hover:bg-slate-50'}`}
                        >
                          <span className="truncate max-w-[140px]">{roi.fieldName || "ไม่มีชื่อฟิลด์"}</span>
                          <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                            <span>W:{Math.round(roi.width)} H:{Math.round(roi.height)}</span>
                            <button onClick={(e) => { e.stopPropagation(); handleDeleteROI(roi.id); }} className="text-slate-400 hover:text-rose-600"><Trash2 size={11} /></button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-center py-5 text-[11px] text-slate-400 font-medium bg-slate-50/50 border border-dashed border-slate-200 rounded-xl">
                        ไม่พบโครงสร้างพิกัด (สลับไปที่โหมด Workspace เพื่อกดวาดฟิลด์เพิ่ม)
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* บล็อกปุ่มกด Action เพื่อบันทึกผลการตัดสินใจลงคลังฐานข้อมูล */}
            <div className="grid grid-cols-2 gap-3 pt-4 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setShowRejectModal(true)}
                className="w-full py-2.5 bg-rose-50 hover:bg-rose-100/70 text-rose-600 border border-rose-200/60 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5"
              >
                <X size={14} /> ปฏิเสธคำขอ
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleApproveAndRegister}
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 text-white rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 shadow-sm active:scale-98"
              >
                {isSubmitting ? "กำลังบันทึก..." : <><Check size={14} /> อนุมัติ & บันทึก</>}
              </button>
            </div>
          </div>
        </div>
      </div>

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
              className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs font-semibold text-slate-800 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all"
            />
            <div className="flex justify-end gap-2 text-xs font-bold">
              <button type="button" onClick={() => setShowRejectModal(false)} className="px-3.5 py-1.5 bg-slate-100 text-slate-600 rounded-xl">ยกเลิก</button>
              <button type="button" onClick={() => { alert('ปฏิเสธคำขอสำเร็จ!'); onResolveStatus(requestId!, 'Rejected'); setShowRejectModal(false); }} className="px-3.5 py-1.5 bg-rose-600 text-white rounded-xl shadow-sm">ยืนยันปฏิเสธ</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}