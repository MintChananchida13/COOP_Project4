"use client";

import React, { useMemo } from 'react';
import { 
  KeyRound, Eye, ArrowLeft, Sparkles, ChevronLeft, ChevronRight,
  FileText, Table, Image as ImageIcon
} from 'lucide-react';

interface AdminReviewStep3Props {
  documentImage: string | null;
  imageStyle: React.CSSProperties;
  rois: any[];
  setRois: React.Dispatch<React.SetStateAction<any[]>>;
  templateName: string;
  setTemplateName: (val: string) => void;
  anchorKeywords: string;
  setAnchorKeywords: (val: string) => void;
  isSubmitting: boolean;
  currentPageIndex: number;
  setCurrentPageIndex: React.Dispatch<React.SetStateAction<number>>;
  imagesList: string[];
  onPrev: () => void;
  onSubmit: () => void;
}

const renderTypeIcon = (type?: 'text' | 'table' | 'image', size = 11) => {
  if (type === 'table') return <Table size={size} className="shrink-0 text-slate-500" />;
  if (type === 'image') return <ImageIcon size={size} className="shrink-0 text-slate-500" />;
  return <FileText size={size} className="shrink-0 text-slate-500" />;
};

export default function AdminReviewStep3({
  documentImage,
  imageStyle,
  rois,
  setRois,
  templateName,
  setTemplateName,
  anchorKeywords,
  setAnchorKeywords,
  isSubmitting,
  currentPageIndex,
  setCurrentPageIndex,
  imagesList,
  onPrev,
  onSubmit
}: AdminReviewStep3Props) {

  // กรองเฉพาะกล่อง ROI ของหน้าตัวอย่างปัจจุบัน
  const currentPageRois = useMemo(() => {
    return rois.filter(r => (r.pageIndex !== undefined ? Number(r.pageIndex) : 0) === currentPageIndex);
  }, [rois, currentPageIndex]);

  const handleUpdateROI = (id: number, updatedFields: any) => {
    setRois(prev => prev.map(roi => roi.id === id ? { ...roi, ...updatedFields } : roi));
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch min-h-[500px]">
      
      {/* ซีกซ้าย: แสดงพรีวิวสุดท้ายของผลงานพร้อมเลเยอร์ฟิลด์ของแอดมิน */}
      <div className="lg:col-span-5 bg-[#edf2f7] border border-slate-200 rounded-2xl p-6 flex flex-col items-center justify-center overflow-hidden shadow-inner relative select-none">
        <div className="w-full text-left text-slate-500 text-[10px] font-bold uppercase tracking-wider mb-3 border-b border-slate-250 pb-1.5 flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <Eye size={12} className="text-slate-500" /> Final Layout Spec Preview (ขั้นตอนที่ 3/3)
          </span>
          {imagesList.length > 1 && (
            <span className="text-indigo-600 font-mono font-bold">หน้า {currentPageIndex + 1} จาก {imagesList.length}</span>
          )}
        </div>
        
        {/* กรอบรูปภาพพรีวิวพร้อมสเกลพิกัดกล่อง */}
        <div className="relative w-[350px] h-auto overflow-hidden rounded-xl border border-slate-250 bg-white flex items-start justify-start shadow-md">
          {documentImage ? (
            <img 
              src={documentImage} 
              alt="Final Layout Preview" 
              style={imageStyle}
              className="w-full h-auto block select-none pointer-events-none opacity-90"
            />
          ) : null}

          {/* เลเยอร์วาดเส้นพิกัดหลักของแอดมิน เฉพาะของหน้าพรีวิวนั้นๆ */}
          {currentPageRois.map((roi, idx) => (
            <div
              key={`final_preview_${roi.id || idx}`}
              className={`absolute border-2 rounded ${
                roi.type === 'table' ? 'border-emerald-500 bg-emerald-500/10' : roi.type === 'image' ? 'border-amber-500 bg-amber-500/10' : 'border-indigo-500 bg-indigo-500/10'
              }`}
              style={{
                left: roi.x * (350 / 750),
                top: roi.y * (350 / 750),
                width: roi.width * (350 / 750),
                height: roi.height * (350 / 750),
              }}
            >
              <span className="bg-slate-900 text-white text-[7px] font-bold px-1.5 py-0.5 rounded absolute -top-3.5 left-0 shadow flex items-center gap-1 select-none font-mono">
                {renderTypeIcon(roi.type, 8)}
                <span>{roi.fieldName}</span>
              </span>
            </div>
          ))}
        </div>

        {/* ตัวเลือกหน้าในพรีวิวเมื่อมีรูปหลายหน้า */}
        {imagesList.length > 1 && (
          <div className="flex items-center gap-4 mt-4 bg-white border border-slate-200 px-3 py-1 rounded-xl text-slate-700 shadow-sm">
            <button 
              type="button"
              disabled={currentPageIndex === 0}
              onClick={() => setCurrentPageIndex(p => p - 1)}
              className="text-slate-400 hover:text-indigo-600 disabled:opacity-30 flex items-center justify-center transition-colors"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-xs font-mono">พรีวิวรูปหน้า {currentPageIndex + 1}</span>
            <button 
              type="button"
              disabled={currentPageIndex === imagesList.length - 1}
              onClick={() => setCurrentPageIndex(p => p + 1)}
              className="text-slate-400 hover:text-indigo-600 disabled:opacity-30 flex items-center justify-center transition-colors"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>

      {/* ซีกขวา: ฟอร์มตั้งชื่อและกำหนดประเภทโมดูลข้อมูล */}
      <div className="lg:col-span-7 bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm flex flex-col justify-between">
        <div className="space-y-4">
          <div className="border-b border-slate-100 pb-2 select-none">
            <h3 className="text-xs font-black text-slate-800 uppercase tracking-wide flex items-center gap-1.5">
              <KeyRound className="text-indigo-600" size={14} />
              การกำหนดประเภทข้อมูล และทะเบียนระบบเวกเตอร์
            </h3>
            <p className="text-[10px] text-slate-450 font-semibold mt-0.5">ตั้งค่าชื่อเทมเพลต กำหนดหน้าที่ของฟิลด์ และส่งข้อมูลไปยังคิวหลังบ้านเพื่อบันทึก</p>
          </div>

          {/* ฟิลด์กรอกข้อมูลทั่วไป */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[9px] font-bold text-slate-500 uppercase tracking-wider block select-none">Template Identity Name</label>
              <input
                type="text"
                placeholder="เช่น INVOICE_TYPE_A"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-800 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all shadow-sm"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[9px] font-bold text-slate-500 uppercase tracking-wider block select-none">Anchor Keywords</label>
              <textarea
                rows={1}
                placeholder="คำสำคัญสำหรับจับคู่เปรียบเทียบ..."
                value={anchorKeywords}
                onChange={(e) => setAnchorKeywords(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-800 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all resize-none shadow-sm"
              />
            </div>
          </div>

          {/* ตารางแสดงฟิลด์ข้อมูล */}
          <div className="space-y-1">
            <label className="text-[9px] font-bold text-slate-500 uppercase tracking-wider block select-none">ตั้งค่าโมเดล Logic และ Classification รายฟิลด์ ({rois.length})</label>
            <div className="overflow-x-auto border border-slate-150 rounded-xl shadow-inner max-h-[220px] scrollbar-thin">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-[9px] font-bold text-slate-400 uppercase tracking-wider border-b border-slate-100 select-none">
                    <th className="px-3 py-2">Field</th>
                    <th className="px-3 py-2">Page</th>
                    <th className="px-3 py-2">ROI Type</th>
                    <th className="px-3 py-2">Role</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-150/40 text-slate-700 font-semibold text-[11px]">
                  {rois.map((roi) => (
                    <tr key={roi.id} className="hover:bg-slate-50/50">
                      <td className="px-3 py-2 font-bold text-slate-800 max-w-[120px] truncate" title={roi.fieldName}>{roi.fieldName}</td>
                      <td className="px-3 py-2 font-mono text-[10px] text-slate-450">P. { (roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0) + 1 }</td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1 text-[9px] font-bold text-slate-550 uppercase">
                          {renderTypeIcon(roi.type, 10)}
                          <span>{roi.type || 'text'}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={roi.role || 'data_extraction'}
                          onChange={(e) => handleUpdateROI(roi.id, { role: e.target.value })}
                          className="bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 text-[10px] font-bold focus:outline-none cursor-pointer text-slate-700 transition-colors"
                        >
                          <option value="data_extraction">Data Field (ฟิลด์ดึงข้อมูลทั่วไป)</option>
                          <option value="anchor">Anchor Field (Text-based Anchor)</option>
                          <option value="visual_anchor">Visual Anchor (Image-based Anchor)</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                  {rois.length === 0 && (
                    <tr>
                      <td colSpan={4} className="text-center py-8 text-slate-400 font-medium">
                        ไม่มีฟิลด์ข้อมูลพิกัด (กรุณาย้อนกลับไปตีกรอบพิกัด)
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ปุ่มนำทางและจัดเก็บบนเวกเตอร์ Qdrant */}
        <div className="flex items-center gap-3 pt-4 border-t border-slate-100">
          <button
            type="button"
            onClick={onPrev}
            className="py-2.5 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 active:scale-98 select-none"
          >
            <ArrowLeft size={14} /> กลับจัดพิกัด ROI
          </button>
          <button
            type="button"
            disabled={isSubmitting || rois.length === 0}
            onClick={onSubmit}
            className="flex-grow py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-100 disabled:text-slate-400 text-white rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-1.5 shadow-md shadow-indigo-600/10 active:scale-98 select-none"
          >
            {isSubmitting ? (
              "กำลังประมวลผล..."
            ) : (
              <><Sparkles size={14} /> Generate & Store to Qdrant</>
            )}
          </button>
        </div>
      </div>

    </div>
  );
}
