"use client";

import React from 'react';
import { 
  RotateCw, RotateCcw, Sliders, X, ChevronRight, FileText, 
  FlipHorizontal, FlipVertical, RefreshCw, Minus, Plus, SlidersHorizontal,
  ChevronLeft
} from 'lucide-react';

interface AdminReviewStep1Props {
  imagesList: string[];
  currentPageIndex: number;
  setCurrentPageIndex: React.Dispatch<React.SetStateAction<number>>;
  documentImage: string | null;
  imageStyle: React.CSSProperties;
  brightness: number;
  setBrightness: React.Dispatch<React.SetStateAction<number>>;
  contrast: number;
  setContrast: React.Dispatch<React.SetStateAction<number>>;
  sharpness: number;
  setSharpness: React.Dispatch<React.SetStateAction<number>>;
  rotation: number;
  setRotation: React.Dispatch<React.SetStateAction<number>>;
  flipH: boolean;
  setFlipH: React.Dispatch<React.SetStateAction<boolean>>;
  flipV: boolean;
  setFlipV: React.Dispatch<React.SetStateAction<boolean>>;
  onNext: () => void;
  onReject: () => void;
}

export default function AdminReviewStep1({
  imagesList,
  currentPageIndex,
  setCurrentPageIndex,
  documentImage,
  imageStyle,
  brightness,
  setBrightness,
  contrast,
  setContrast,
  sharpness,
  setSharpness,
  rotation,
  setRotation,
  flipH,
  setFlipH,
  flipV,
  setFlipV,
  onNext,
  onReject
}: AdminReviewStep1Props) {
  
  const adjustControls = [
    { label: "ความสว่างภาพ (Brightness)", key: "brightness", min: 50, max: 150, value: brightness, setVal: setBrightness, step: 5, resetVal: 100 },
    { label: "ความคมชัดตัดโทน (Contrast)", key: "contrast", min: 50, max: 150, value: contrast, setVal: setContrast, step: 5, resetVal: 100 },
    { label: "ความเบลอภาพนวล (Softness Blur)", key: "sharpness", min: 0, max: 10, value: sharpness, setVal: setSharpness, step: 1, resetVal: 0 }
  ];

  return (
    <div className="bg-[#f8fafc] border border-slate-200 rounded-2xl p-4 md:p-6 space-y-6">
      
      {/* Configuration Header Panel */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm select-none">
        <h2 className="text-sm font-bold text-[#172b4d] flex items-center gap-2 tracking-wide uppercase">
          <SlidersHorizontal size={16} className="text-[#0052cc]" /> Image Configuration Panel
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">จัดระเบียบโครงสร้างระนาบ ความคมชัด และสัดส่วนขอบเขตของหน้าเอกสารก่อนการวิเคราะห์โครงสร้าง</p>
      </div>

      <div className="grid grid-cols-12 gap-6 items-stretch">
        
        {/* ซีกซ้าย (8 คอลัมน์): ภาพเอกสารพร้อมแถบเลื่อนหน้ารองรับหลายหน้าและ Thumbnails */}
        <div className="col-span-12 lg:col-span-8 flex flex-col gap-4">
          <div className="bg-[#edf2f7] border border-slate-200 rounded-xl flex items-center justify-center h-[540px] overflow-hidden shadow-inner relative p-4">
            <div className="relative flex items-center justify-center w-full h-full">
              {documentImage ? (
                <img 
                  src={documentImage} 
                  alt="Admin Adjust Preview" 
                  style={imageStyle}
                  className="max-h-[460px] max-w-full w-auto h-auto block border border-slate-250 shadow-xl bg-white rounded-lg select-none object-contain transition-all"
                />
              ) : (
                <div className="flex flex-col items-center justify-center text-slate-500 p-6 text-center select-none">
                  <FileText size={48} className="stroke-[1.5] mb-2 text-slate-650 animate-pulse" />
                  <p className="text-xs font-bold text-slate-400">ไม่มีรูปภาพเอกสารแนบ</p>
                </div>
              )}
            </div>
          </div>

          {/* Footer Carousel & Pagination Selector */}
          {imagesList.length > 0 && (
            <div className="bg-[#edf2f7] border border-slate-200 rounded-xl p-3 flex flex-col sm:flex-row items-center justify-between gap-4 select-none">
              <div className="text-slate-600 text-xs font-bold px-2 shrink-0">
                คลังเอกสารประมวลผล: <span className="text-blue-600 font-mono font-bold ml-1">{currentPageIndex + 1} / {imagesList.length} หน้า</span>
              </div>
              
              <div className="flex items-center gap-2 flex-1 justify-center w-full">
                <button 
                  type="button" 
                  disabled={currentPageIndex === 0} 
                  onClick={() => setCurrentPageIndex(currentPageIndex - 1)} 
                  className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-slate-700 disabled:opacity-25 transition-all active:scale-95"
                >
                  <ChevronLeft size={16} />
                </button>
                
                <div className="flex gap-2 overflow-x-auto max-w-md py-1 no-scrollbar">
                  {imagesList.map((url, idx) => (
                    <button 
                      key={idx} 
                      type="button" 
                      onClick={() => setCurrentPageIndex(idx)} 
                      className={`relative w-9 h-12 rounded border-2 overflow-hidden bg-white shrink-0 transition-all ${idx === currentPageIndex ? 'border-blue-500 ring-2 ring-blue-500/10 scale-105 shadow-md' : 'border-slate-250 opacity-55 hover:opacity-100'}`}
                    >
                      <img src={url} alt={`Page ${idx + 1}`} className="w-full h-full object-cover pointer-events-none" />
                    </button>
                  ))}
                </div>

                <button 
                  type="button" 
                  disabled={currentPageIndex === imagesList.length - 1} 
                  onClick={() => setCurrentPageIndex(currentPageIndex + 1)} 
                  className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-slate-700 disabled:opacity-25 transition-all active:scale-95"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ซีกขวา (4 คอลัมน์): เครื่องมือปรับแต่ง (Transform, Filters, Actions) */}
        <div className="col-span-12 lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between">
          <div className="space-y-6">
            <div className="border-b border-slate-100 pb-3 select-none">
              <h3 className="text-xs font-black text-slate-800 uppercase tracking-wide flex items-center gap-1.5">
                <Sliders size={14} className="text-indigo-600" />
                เครื่องมือปรับแต่งรูปภาพ (ขั้นตอนที่ 1/3)
              </h3>
              <p className="text-[10px] text-slate-450 font-semibold mt-1">ปรับมุมและแต่งความสว่างคมชัดของไฟล์เพื่อให้ง่ายต่อการสกัดค่า</p>
            </div>

            {/* หมุนและกลับภาพ */}
            <div className="space-y-2">
              <span className="text-[11px] font-bold text-slate-550 block uppercase tracking-wider select-none">Transform</span>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setRotation(r => (r - 90) % 360)} className="py-2 border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-xl flex items-center justify-center text-[10px] font-bold gap-1.5 transition-all"><RotateCcw size={13} /> หมุนซ้าย -90°</button>
                <button onClick={() => setRotation(r => (r + 90) % 360)} className="py-2 border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-xl flex items-center justify-center text-[10px] font-bold gap-1.5 transition-all"><RotateCw size={13} /> หมุนขวา +90°</button>
                <button onClick={() => setFlipH(f => !f)} className={`py-2 border rounded-xl flex items-center justify-center text-[10px] font-bold gap-1.5 transition-all ${flipH ? 'bg-indigo-50 border-indigo-200 text-indigo-600':'border-slate-200 hover:bg-slate-50 text-slate-600'}`}><FlipHorizontal size={13} /> กลับแนวนอน</button>
                <button onClick={() => setFlipV(f => !f)} className={`py-2 border rounded-xl flex items-center justify-center text-[10px] font-bold gap-1.5 transition-all ${flipV ? 'bg-indigo-50 border-indigo-200 text-indigo-600':'border-slate-200 hover:bg-slate-50 text-slate-600'}`}><FlipVertical size={13} /> กลับแนวตั้ง</button>
              </div>
            </div>

            {/* สไลเดอร์ปรับค่าแสง */}
            <div className="space-y-4 pt-1">
              {adjustControls.map((item) => (
                <div key={item.key} className="space-y-1.5 bg-slate-50/60 p-3 rounded-xl border border-slate-100">
                  <div className="flex justify-between text-[11px] font-bold text-slate-700 select-none">
                    <span>{item.label}</span>
                    <span className="text-indigo-600 font-mono font-bold">{item.value}%</span>
                  </div>
                  <input 
                    type="range" min={item.min} max={item.max} value={item.value} 
                    onChange={(e) => item.setVal(parseInt(e.target.value))}
                    className="w-full accent-indigo-600 h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer"
                  />
                  <div className="flex items-center gap-1.5 pt-1.5">
                    <button type="button" onClick={() => item.setVal(v => Math.max(item.min, v - item.step))} className="text-[9px] font-bold bg-white border border-slate-200 px-2 py-0.5 rounded text-slate-600 hover:bg-slate-50 transition-colors"><Minus size={8} className="inline" /> -{item.step}</button>
                    <button type="button" onClick={() => item.setVal(v => Math.min(item.max, v + item.step))} className="text-[9px] font-bold bg-white border border-slate-200 px-2 py-0.5 rounded text-slate-600 hover:bg-slate-50 transition-colors"><Plus size={8} className="inline" /> +{item.step}</button>
                    <button type="button" onClick={() => item.setVal(item.resetVal)} className="text-[9px] font-semibold text-slate-400 hover:text-slate-600 ml-auto transition-colors"><RefreshCw size={8} className="inline mr-0.5" /> รีเซ็ต</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ปุ่มนำทาง */}
          <div className="grid grid-cols-2 gap-3 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={onReject}
              className="py-2.5 bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 active:scale-95"
            >
              <X size={14} /> ปฏิเสธคำขอ
            </button>
            <button
              type="button"
              onClick={onNext}
              className="py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 shadow-sm active:scale-98"
            >
              ต่อไป: จัดพิกัด ROI <ChevronRight size={14} />
            </button>
          </div>
        </div>

      </div>

    </div>
  );
}
