"use client";

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Square, Trash2, Move, Hand, X, ArrowLeft, ZoomIn, ZoomOut, Maximize2, Cpu } from 'lucide-react';
import { Rnd } from "react-rnd";
import { ROI } from '../types/ocr';

interface WorkspaceZoneProps {
  previewUrl: string;
  image: string | null;
  brightness: number;
  contrast: number;
  rotation: number;
  rois: (ROI & { pageIndex?: number })[]; 
  setRois: React.Dispatch<React.SetStateAction<(ROI & { pageIndex?: number })[]>>;
  selectedId: number | null;
  setSelectedId: React.Dispatch<React.SetStateAction<number | null>>;
  onBackToAdjust: () => void;
  deleteROI: (id: number) => void;
  isLoading: boolean;
  onRunOCR: (scaleX: number, scaleY: number) => void;
  currentIndex: number;
  imagesList: string[]; 
  onIndexChange: (index: number) => void; 
}

export default function WorkspaceZone({
  previewUrl,
  rois,
  setRois,
  selectedId,
  setSelectedId,
  onBackToAdjust,
  deleteROI,
  isLoading,
  onRunOCR,
  currentIndex,
  imagesList,    
  onIndexChange, 
}: WorkspaceZoneProps) {
  const [activeTool, setActiveTool] = useState<'pan' | 'box'>('box');
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [dragBox, setDragBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // 🔍 สเตปการซูมมาตรฐาน
  const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
  const [zoomIndex, setZoomIndex] = useState<number>(2); 
  const currentZoom = ZOOM_STEPS[zoomIndex];

  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ scrollLeft: 0, scrollTop: 0, clientX: 0, clientY: 0 });

  const imageRef = useRef<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // 🔄 เคลียร์ไอดีที่เลือกเมื่อสลับหน้า
  useEffect(() => {
    setSelectedId(null);
  }, [currentIndex, setSelectedId]);

  // ✨ บังคับให้ Workspace ใช้รูปที่โมดิฟายล่าสุด
  useEffect(() => {
    if (imageRef.current && previewUrl) {
      imageRef.current.src = previewUrl;
    }
  }, [previewUrl, currentIndex]);

  // 🛡️ กรองกรอบ ROI แสดงผลเฉพาะของหน้าปัจจุบัน
  const currentPageRois = useMemo(() => {
    return rois.filter(roi => {
      const roiPage = roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0;
      return roiPage === Number(currentIndex);
    });
  }, [rois, currentIndex]);

  const handleZoomIn = () => {
    if (zoomIndex < ZOOM_STEPS.length - 1) setZoomIndex(prev => prev + 1);
  };

  const handleZoomOut = () => {
    if (zoomIndex > 0) setZoomIndex(prev => prev - 1);
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current || !viewportRef.current) return;

    if (activeTool === 'pan' || e.button === 1) {
      setIsPanning(true);
      setPanStart({
        scrollLeft: viewportRef.current.scrollLeft,
        scrollTop: viewportRef.current.scrollTop,
        clientX: e.clientX,
        clientY: e.clientY
      });
      return;
    }

    const isTargetBox = (e.target as HTMLElement).closest('.rnd-box-item');
    if (!isTargetBox) {
      e.preventDefault(); 
      e.stopPropagation();
      setSelectedId(null); 
      setActiveTool('box');
      
      const x = e.nativeEvent.offsetX;
      const y = e.nativeEvent.offsetY;

      setIsDrawing(true);
      setStartPos({ x, y });
      setDragBox({ x, y, w: 0, h: 0 });
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isPanning && viewportRef.current) {
      const dx = e.clientX - panStart.clientX;
      const dy = e.clientY - panStart.clientY;
      viewportRef.current.scrollLeft = panStart.scrollLeft - dx;
      viewportRef.current.scrollTop = panStart.scrollTop - dy;
      return;
    }

    if (!isDrawing || !dragBox || !containerRef.current) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const currentX = (e.clientX - rect.left) / currentZoom;
    const currentY = (e.clientY - rect.top) / currentZoom;

    setDragBox({
      x: Math.min(startPos.x, currentX),
      y: Math.min(startPos.y, currentY),
      w: Math.abs(startPos.x - currentX),
      h: Math.abs(startPos.y - currentY)
    });
  };

  const handleMouseUp = () => {
    if (isPanning) {
      setIsPanning(false);
      return;
    }

    if (!isDrawing || !dragBox) return;
    setIsDrawing(false);

    if (dragBox.w > 5 && dragBox.h > 5) {
      const newBox = {
        id: Date.now(),
        fieldName: `field_${rois.length + 1}`,
        x: dragBox.x,
        y: dragBox.y,
        width: dragBox.w,
        height: dragBox.h,
        pageIndex: currentIndex 
      };
      setRois([...rois, newBox]);
      setSelectedId(newBox.id);
    } else {
      setSelectedId(null);
    }
    setDragBox(null);
    setActiveTool('box');
  };

  const updateROI = (id: number, data: Partial<ROI>) => {
    setRois(prev => prev.map(roi => roi.id === id ? { ...roi, ...data } : roi));
  };

  const handleStyle = {
    width: "8px",
    height: "8px",
    background: "#ffffff",
    border: "1.5px solid #2563eb",
    borderRadius: "2px",
    boxShadow: "0 1px 2px rgba(0,0,0,0.2)"
  };

  // 🚀 ส่งสัญญาณหาความกว้าง/ยาวจริงของหน้าปัจจุบัน เพื่อนำสเกลไปกระจายรันทุกหน้า
  const triggerOCRProcessing = () => {
    if (!imageRef.current) return;
    const scaleX = imageRef.current.naturalWidth / imageRef.current.clientWidth;
    const scaleY = imageRef.current.naturalHeight / imageRef.current.clientHeight;
    onRunOCR(scaleX, scaleY);
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-20">
      
      {/* 📊 STEP PROCESS PROGRESS BAR */}
      <div className="w-full bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3 w-full max-w-3xl mx-auto justify-between relative">
          <div className="flex items-center gap-2.5 z-10 relative bg-white pr-4">
            <div className="w-7 h-7 rounded-full bg-green-100 border border-green-300 text-green-600 font-bold text-xs flex items-center justify-center">✓</div>
            <div className="text-left">
              <p className="text-xs font-bold text-slate-500">Pre-processing</p>
              <p className="text-[10px] text-slate-400 font-medium">ปรับมุมมองและครอปตัด</p>
            </div>
          </div>
          <div className="absolute top-3.5 left-0 right-0 h-[2px] bg-slate-200 -z-0 hidden md:block"></div>
          <div className="flex items-center gap-2.5 z-10 relative bg-white px-4">
            <div className="w-7 h-7 rounded-full bg-blue-600 text-white font-bold text-xs flex items-center justify-center ring-4 ring-blue-100">2</div>
            <div className="text-left">
              <p className="text-xs font-bold text-slate-800">ROI Studio</p>
              <p className="text-[10px] text-slate-400 font-medium">ลากกล่องดักจับข้อความ</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 z-10 relative bg-white pl-4">
            <div className="w-7 h-7 rounded-full bg-white border-2 border-slate-300 text-slate-400 font-bold text-xs flex items-center justify-center">3</div>
            <div className="text-left">
              <p className="text-xs font-bold text-slate-400">Ground Truth Editor</p>
              <p className="text-[10px] text-slate-400 font-medium">สกัดผลลัพธ์และเซฟข้อมูล</p>
            </div>
          </div>
        </div>
      </div>

      {/* 💻 MAIN CANVASES ROW */}
      <div className="grid grid-cols-12 gap-5 h-[620px]">
        
        {/* 🛠️ LEFT SIDEBAR: VERTICAL TOOLBAR */}
        <div className="col-span-1 flex flex-col items-center gap-3 bg-white border border-slate-200 py-4 rounded-xl shadow-sm w-16 h-full">
          <button 
            type="button"
            onClick={() => { setActiveTool('pan'); setSelectedId(null); }}
            className={`p-2.5 rounded-lg transition-all ${activeTool === 'pan' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-100'}`}
            title="Hand Pan Tool (Hand)"
          >
            <Hand size={20} />
          </button>
          <button 
            type="button"
            onClick={() => setActiveTool('box')}
            className={`p-2.5 rounded-lg transition-all ${activeTool === 'box' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-100'}`}
            title="Box Drag Tool (Square)"
          >
            <Square size={20} />
          </button>

          <div className="w-8 h-[1px] bg-slate-200 my-2"></div>

          <button 
            type="button"
            onClick={handleZoomIn}
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            className="p-2.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-blue-600 disabled:opacity-30 transition-all"
            title={`Zoom In (${Math.round(currentZoom * 100)}%)`}
          >
            <ZoomIn size={20} />
          </button>

          <button 
            type="button"
            onClick={handleZoomOut}
            disabled={zoomIndex === 0}
            className="p-2.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-blue-600 disabled:opacity-30 transition-all"
            title={`Zoom Out (${Math.round(currentZoom * 100)}%)`}
          >
            <ZoomOut size={20} />
          </button>

          <button 
            type="button"
            onClick={() => setZoomIndex(2)}
            className="p-2.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-all"
            title="Reset Zoom to 100%"
          >
            <Maximize2 size={16} />
          </button>

          <div className="w-8 h-[1px] bg-slate-200 my-2"></div>
          
          <button 
            type="button"
            onClick={() => { 
              setRois(prev => prev.filter(roi => {
                const roiPage = roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0;
                return roiPage !== Number(currentIndex);
              })); 
              setSelectedId(null); 
            }}
            className="p-2.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
            title="ล้างกล่องทั้งหมดในหน้านี้"
          >
            <Trash2 size={20} />
          </button>
        </div>

        {/* 🎨 CENTER: VIEWPORT MAIN CANVAS */}
        <div 
          ref={viewportRef} 
          className="col-span-8 bg-slate-200 border border-slate-300 rounded-xl overflow-auto flex items-start justify-start p-6 shadow-inner h-full relative"
        >
          <div 
            ref={containerRef}
            className={`relative inline-block ${selectedId ? 'cursor-default' : activeTool === 'box' ? 'cursor-crosshair select-none' : isPanning ? 'cursor-grabbing' : 'cursor-grab'}`} 
            style={{ 
              transform: `scale(${currentZoom})`, 
              transformOrigin: "top left",
              transition: "transform 0.1s ease-out"
            }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            <div className="relative w-[750px] h-auto bg-transparent">
              {previewUrl && (
                <img 
                  ref={imageRef}
                  src={previewUrl} 
                  alt="Workspace" 
                  draggable="false" 
                  className="w-full h-auto block select-none pointer-events-none border border-slate-300 shadow-xl rounded bg-white"
                />
              )}
                  
              {isDrawing && dragBox && (
                <div 
                  className="absolute border border-dashed border-red-500 bg-red-500/20 pointer-events-none z-50" 
                  style={{ left: dragBox.x, top: dragBox.y, width: dragBox.w, height: dragBox.h }} 
                />
              )}
                          
              <div className="absolute inset-0 top-0 left-0 w-full h-full pointer-events-auto">
                {currentPageRois.map((roi) => (
                  <Rnd
                    key={roi.id}
                    size={{ width: roi.width, height: roi.height }}
                    position={{ x: roi.x, y: roi.y }}
                    onMouseDown={(e) => { e.stopPropagation(); setSelectedId(roi.id); }}
                    onDragStop={(e, d) => updateROI(roi.id, { x: d.x, y: d.y })}
                    onResizeStop={(e, dir, ref, delta, pos) => {
                      updateROI(roi.id, { width: parseInt(ref.style.width), height: parseInt(ref.style.height), ...pos });
                    }}
                    bounds="parent"
                    scale={currentZoom}
                    className={`rnd-box-item border transition-shadow ${selectedId === roi.id ? "border-blue-500 bg-blue-500/10 shadow-md z-30" : "border-slate-400 bg-slate-500/5 z-20"}`}
                    resizeHandleStyles={selectedId === roi.id ? { topLeft: handleStyle, topRight: handleStyle, bottomLeft: handleStyle, bottomRight: handleStyle, top: handleStyle, right: handleStyle, bottom: handleStyle, left: handleStyle } : {}}
                    disableDragging={activeTool === 'pan'}
                  >
                    <div className="w-full h-full relative">
                      <span className={`absolute -top-5 left-0 px-1 py-0.5 text-[9px] font-mono rounded shadow border ${selectedId === roi.id ? "bg-blue-600 border-blue-500 text-white font-bold" : "bg-white border-slate-300 text-slate-600"}`}>
                        {roi.fieldName}
                      </span>
                    </div>
                  </Rnd>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 🎛️ RIGHT SIDEBAR: PROPERTIES PANEL */}
        <div className="col-span-3 bg-white border border-slate-200 p-4 rounded-xl shadow-sm space-y-4 overflow-y-auto h-full">
          <button
            type="button"
            onClick={onBackToAdjust}
            className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-sm"
          >
            <ArrowLeft size={14} /> ย้อนกลับไปหน้าครอบตัดรูปภาพ
          </button>

          <div className="space-y-2 bg-slate-50 p-3 rounded-lg border border-slate-100">
            <h3 className="text-xs font-bold text-slate-500 tracking-wider uppercase">Active Fields ({currentPageRois.length})</h3>
            <div className="space-y-1.5 max-h-[440px] overflow-y-auto pr-1">
              {currentPageRois.map((roi) => (
                <div 
                  key={roi.id} 
                  onClick={() => setSelectedId(roi.id)} 
                  className={`flex items-center justify-between p-2 rounded border text-xs cursor-pointer transition-all ${selectedId === roi.id ? "bg-blue-50 border-blue-400 text-slate-800 font-medium" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                >
                  <div className="flex items-center gap-2 w-full">
                    <Move size={12} className="text-slate-400 shrink-0" />
                    <input 
                      type="text" 
                      value={roi.fieldName} 
                      onChange={(e) => updateROI(roi.id, { fieldName: e.target.value })} 
                      className="bg-transparent border-b border-transparent focus:border-blue-500 focus:outline-none w-full cursor-text" 
                      onClick={(e) => e.stopPropagation()} 
                    />
                  </div>
                  <button 
                    type="button"
                    onClick={(e) => { e.stopPropagation(); deleteROI(roi.id); }} 
                    className="text-slate-400 hover:text-red-500 ml-1"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 📄 🎠 FOOTER CAROUSEL & GLOBAL ACTION BUTTON */}
      <div className="w-full bg-slate-950 text-white rounded-2xl px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-4 shadow-xl">
        <div className="flex items-center gap-4">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">
            คลังเอกสารประมวลผล: <span className="text-white text-sm ml-1">{currentIndex + 1} / {imagesList.length} หน้า</span>
          </div>
          
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={currentIndex === 0 || isLoading}
              onClick={() => onIndexChange(currentIndex - 1)}
              className="p-2 bg-slate-800 text-slate-300 rounded-xl hover:bg-slate-700 transition-all disabled:opacity-30 disabled:hover:bg-slate-800 shadow-sm active:scale-95"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
            </button>

            {/* Thumbnails */}
            <div className="flex items-center gap-2 overflow-x-auto max-w-[320px] py-0.5">
              {imagesList.map((url, idx) => (
                <button
                  key={idx}
                  type="button"
                  disabled={isLoading}
                  onClick={() => onIndexChange(idx)}
                  className={`relative w-9 h-12 rounded-md overflow-hidden border transition-all shrink-0 shadow-md ${
                    currentIndex === idx 
                      ? "border-blue-500 ring-2 ring-blue-500/50" 
                      : "border-slate-700 opacity-60 hover:opacity-100"
                  }`}
                >
                  <img src={url} alt={`Page ${idx + 1}`} className="w-full h-full object-cover" />
                </button>
              ))}
            </div>

            <button
              type="button"
              disabled={currentIndex === imagesList.length - 1 || isLoading}
              onClick={() => onIndexChange(currentIndex + 1)}
              className="p-2 bg-slate-800 text-slate-300 rounded-xl hover:bg-slate-700 transition-all disabled:opacity-30 disabled:hover:bg-slate-800 shadow-sm active:scale-95"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
            </button>
          </div>
        </div>

        {/* 🌟 ปุ่มรัน OCR รวมทุกหน้าพร้อมกัน (ดึงกล่องทั้งหมดในแผงยิงตูมเดียว) */}
        <button 
          disabled={rois.length === 0 || isLoading} 
          onClick={triggerOCRProcessing} 
          className="w-full sm:w-auto px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all shadow-md shadow-blue-900/20 active:scale-98"
        >
          <Cpu size={14} className={isLoading ? "animate-spin text-blue-300" : "text-white"} />
          {isLoading ? "Analyzing via AI Engine..." : "Run OCR on All Pages"}
        </button>
      </div>

    </div>
  );
}