"use client";

import React, { useState, useRef, useMemo } from 'react';
import { 
  Square, Trash2, Hand, ZoomIn, ZoomOut, Maximize2, X, Plus, 
  ArrowLeft, ChevronLeft, ChevronRight as ChevronRightIcon, 
  FileText, Layers, Move, Table, Image as ImageIcon
} from 'lucide-react';
import { Rnd } from 'react-rnd';

interface AdminReviewStep2Props {
  documentImage: string | null;
  imageStyle: React.CSSProperties;
  rois: any[];
  setRois: React.Dispatch<React.SetStateAction<any[]>>;
  selectedId: number | null;
  setSelectedId: (val: number | null) => void;
  selectedGhostId: number | null;
  setSelectedGhostId: (val: number | null) => void;
  currentPageIndex: number;
  setCurrentPageIndex: React.Dispatch<React.SetStateAction<number>>;
  imagesList: string[];
  userRois: any[];
  onPrev: () => void;
  onNext: () => void;
}

const renderTypeIcon = (type?: 'text' | 'table' | 'image', size = 11) => {
  if (type === 'table') return <Table size={size} className="shrink-0 text-slate-500" />;
  if (type === 'image') return <ImageIcon size={size} className="shrink-0 text-slate-500" />;
  return <FileText size={size} className="shrink-0 text-slate-500" />;
};

export default function AdminReviewStep2({
  documentImage,
  imageStyle,
  rois,
  setRois,
  selectedId,
  setSelectedId,
  selectedGhostId,
  setSelectedGhostId,
  currentPageIndex,
  setCurrentPageIndex,
  imagesList,
  userRois,
  onPrev,
  onNext
}: AdminReviewStep2Props) {

  // 🛠️ การจัดการแคนวาสแบบเดียวกับ WorkspaceZone.tsx
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

  // ขนาดควบคุมกล่องและตัวดึงพิกัดลากวาด
  const handleStyle = {
    width: "8px",
    height: "8px",
    background: "#ffffff",
    border: "1.5px solid #4f46e5",
    borderRadius: "2px",
    boxShadow: "0 1px 2px rgba(0,0,0,0.2)"
  };

  // กรองกล่องให้แสดงเฉพาะของหน้าปัจจุบัน
  const currentPageRois = useMemo(() => {
    return rois.filter(r => (r.pageIndex !== undefined ? Number(r.pageIndex) : 0) === currentPageIndex);
  }, [rois, currentPageIndex]);

  const currentPageGhostRois = useMemo(() => {
    return userRois.filter(r => (r.pageIndex !== undefined ? Number(r.pageIndex) : 0) === currentPageIndex);
  }, [userRois, currentPageIndex]);

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
      setSelectedGhostId(null);
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
        type: 'text',
        dataType: 'string',
        role: 'data_extraction',
        weight: 1.0,
        verificationRule: '',
        pageIndex: currentPageIndex
      };
      setRois([...rois, newBox]);
      setSelectedId(newBox.id);
    } else {
      setSelectedId(null);
    }
    setDragBox(null);
    setActiveTool('box');
  };

  const handleUpdateROI = (id: number, updatedFields: any) => {
    setRois(prev => prev.map(roi => roi.id === id ? { ...roi, ...updatedFields } : roi));
  };

  const handleDeleteROI = (id: number) => {
    setRois(prev => prev.filter(roi => roi.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  // แปลง Ghost ROI ของผู้ใช้ให้เป็นฟิลด์หลัก
  const handleConvertGhost = (ghostRoi: any) => {
    if (rois.some(r => r.fieldName === ghostRoi.fieldName)) {
      alert("มีฟิลด์ชื่อนี้บนแผงเทมเพลตหลักอยู่แล้ว");
      return;
    }

    const newRoi = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      fieldName: ghostRoi.fieldName || `field_${rois.length + 1}`,
      x: ghostRoi.x,
      y: ghostRoi.y,
      width: ghostRoi.width,
      height: ghostRoi.height,
      type: ghostRoi.type || 'text',
      dataType: ghostRoi.dataType || 'string',
      role: ghostRoi.role || 'data_extraction',
      weight: ghostRoi.weight !== undefined ? ghostRoi.weight : 1.0,
      verificationRule: ghostRoi.verificationRule || '',
      pageIndex: currentPageIndex
    };

    setRois([...rois, newRoi]);
    setSelectedId(newRoi.id);
    setSelectedGhostId(null);
    alert(`แปลงกล่อง "${newRoi.fieldName}" เป็นกล่องเทมเพลตพร้อมตั้งค่าสำเร็จ`);
  };

  return (
    <div className="space-y-6">
      
      {/* แคนวาสลากพิกัด */}
      <div className="grid grid-cols-12 gap-5 h-[620px] items-stretch select-none">
        
        {/* 🛠️ LEFT SIDEBAR: VERTICAL TOOLBAR */}
        <div className="col-span-1 flex flex-col items-center gap-3 bg-white border border-slate-200 py-4 rounded-xl shadow-sm w-16 h-full">
          <button 
            type="button"
            onClick={() => { setActiveTool('pan'); setSelectedId(null); setSelectedGhostId(null); }}
            className={`p-2.5 rounded-lg transition-all ${activeTool === 'pan' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-100'}`}
            title="Hand Pan Tool"
          >
            <Hand size={20} />
          </button>
          <button 
            type="button"
            onClick={() => { setActiveTool('box'); setSelectedGhostId(null); }}
            className={`p-2.5 rounded-lg transition-all ${activeTool === 'box' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-100'}`}
            title="Box Drag Tool"
          >
            <Square size={20} />
          </button>

          <div className="w-8 h-[1px] bg-slate-200 my-2"></div>

          <button 
            type="button"
            onClick={() => zoomIndex < ZOOM_STEPS.length - 1 && setZoomIndex(z => z + 1)}
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            className="p-2.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-indigo-600 disabled:opacity-30 transition-all"
            title={`Zoom In (${Math.round(currentZoom * 100)}%)`}
          >
            <ZoomIn size={20} />
          </button>

          <button 
            type="button"
            onClick={() => zoomIndex > 0 && setZoomIndex(z => z - 1)}
            disabled={zoomIndex === 0}
            className="p-2.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-indigo-600 disabled:opacity-30 transition-all"
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
              if (confirm("คุณต้องการล้างกล่อง ROI ทั้งหมดของหน้าปัจจุบันใช่หรือไม่?")) {
                setRois(prev => prev.filter(r => (r.pageIndex !== undefined ? Number(r.pageIndex) : 0) !== currentPageIndex));
                setSelectedId(null);
                setSelectedGhostId(null);
              }
            }}
            className="p-2.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
            title="ล้างกล่องในหน้านี้ทั้งหมด"
          >
            <Trash2 size={20} />
          </button>
        </div>

        {/* 🎨 CENTER: VIEWPORT MAIN CANVAS */}
        <div 
          ref={viewportRef} 
          className="col-span-8 bg-[#edf2f7] border border-slate-200 rounded-xl overflow-auto flex items-start justify-start p-6 shadow-inner h-full relative"
        >
          <div 
            ref={containerRef}
            className={`relative inline-block ${selectedId || selectedGhostId ? 'cursor-default' : activeTool === 'box' ? 'cursor-crosshair select-none' : isPanning ? 'cursor-grabbing' : 'cursor-grab'}`} 
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
              {documentImage && (
                <img 
                  ref={imageRef}
                  src={documentImage} 
                  alt="Workspace Base" 
                  draggable="false" 
                  style={imageStyle}
                  className="w-full h-auto block select-none pointer-events-none border border-slate-300 shadow-xl rounded bg-white opacity-85"
                />
              )}
              
              {isDrawing && dragBox && (
                <div 
                  className="absolute border border-dashed border-red-500 bg-red-500/20 pointer-events-none z-50" 
                  style={{ left: dragBox.x, top: dragBox.y, width: dragBox.w, height: dragBox.h }} 
                />
              )}
                           
              <div className="absolute inset-0 top-0 left-0 w-full h-full pointer-events-auto">
                
                {/* 1. Ghost Layer */}
                {currentPageGhostRois.map((ghost: any, idx: number) => {
                  const isGhostSelected = selectedGhostId === ghost.id;
                  const isConverted = rois.some(r => r.fieldName === ghost.fieldName);
                  
                  return (
                    <div
                      key={`ghost_${ghost.id || idx}`}
                      onClick={(e) => { e.stopPropagation(); setSelectedGhostId(ghost.id); setSelectedId(null); }}
                      className={`absolute border border-dashed rounded cursor-pointer transition-all duration-205 flex flex-col items-center justify-center ${
                        isConverted 
                          ? 'border-slate-300 bg-slate-100/5 opacity-25 pointer-events-none z-10'
                          : isGhostSelected 
                            ? 'border-amber-600 bg-amber-500/20 ring-4 ring-amber-500/20 z-40 shadow-md scale-102' 
                            : 'border-amber-500/80 bg-amber-400/5 hover:border-amber-500 hover:bg-amber-500/10 z-20'
                      }`}
                      style={{
                        left: ghost.x,
                        top: ghost.y,
                        width: ghost.width,
                        height: ghost.height,
                      }}
                    >
                      <span className="bg-amber-600 text-white text-[8.5px] font-mono px-1.5 py-0.5 rounded absolute -top-4 left-0 select-none shadow-sm font-bold flex items-center gap-1">
                        <FileText size={8} /> Ghost: {ghost.fieldName}
                      </span>

                      {isGhostSelected && !isConverted && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleConvertGhost(ghost);
                          }}
                          className="bg-slate-900 border border-slate-700 text-white hover:bg-slate-950 font-bold text-[9px] uppercase px-2.5 py-1 rounded-lg shadow-lg flex items-center gap-1 z-50 transition-transform scale-95"
                        >
                          <Plus size={10} /> Convert to Field
                        </button>
                      )}
                    </div>
                  );
                })}

                {/* 2. Active Admin ROI Layer */}
                {currentPageRois.map((roi) => {
                  const isSelected = selectedId === roi.id;
                  return (
                    <Rnd
                      key={roi.id}
                      size={{ width: roi.width, height: roi.height }}
                      position={{ x: roi.x, y: roi.y }}
                      onMouseDown={(e) => { e.stopPropagation(); setSelectedId(roi.id); setSelectedGhostId(null); }}
                      onDragStop={(e, d) => handleUpdateROI(roi.id, { x: d.x, y: d.y })}
                      onResizeStop={(e, dir, ref, delta, pos) => {
                        handleUpdateROI(roi.id, { width: parseInt(ref.style.width), height: parseInt(ref.style.height), ...pos });
                      }}
                      bounds="parent"
                      scale={currentZoom}
                      className={`rnd-box-item border transition-shadow ${isSelected ? "border-indigo-600 bg-indigo-600/15 shadow-md z-30" : "border-slate-500 bg-slate-500/5 z-20"}`}
                      resizeHandleStyles={isSelected ? { topLeft: handleStyle, topRight: handleStyle, bottomLeft: handleStyle, bottomRight: handleStyle, top: handleStyle, right: handleStyle, bottom: handleStyle, left: handleStyle } : {}}
                      disableDragging={activeTool === 'pan'}
                    >
                      <div className="w-full h-full relative">
                        <span className={`absolute -top-5 left-0 px-2 py-0.5 text-[8.5px] font-mono rounded shadow-sm border flex items-center gap-1.5 ${isSelected ? "bg-indigo-600 border-indigo-500 text-white font-bold" : "bg-white border-slate-300 text-slate-600"}`}>
                          {renderTypeIcon(roi.type, 9)}
                          <span>{roi.fieldName || "(Unnamed)"}</span>
                        </span>

                        {/* Floating Popover on Active Box */}
                        {isSelected && (
                          <div 
                            className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-64 bg-slate-900/95 backdrop-blur-md border border-slate-800 rounded-xl shadow-2xl p-3 z-50 text-white flex flex-col gap-2 pointer-events-auto"
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            <div className="flex flex-col gap-0.5">
                              <label className="text-[8px] font-bold text-slate-400 uppercase tracking-wider text-left">Field Name</label>
                              <input
                                type="text"
                                value={roi.fieldName || ""}
                                onChange={(e) => handleUpdateROI(roi.id, { fieldName: e.target.value })}
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1 text-xs font-semibold focus:outline-none focus:border-blue-500 text-white text-left"
                              />
                            </div>
                            
                            <div className="flex flex-col gap-0.5">
                              <label className="text-[8px] font-bold text-slate-400 uppercase tracking-wider text-left">ROI Type</label>
                              <div className="grid grid-cols-3 gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleUpdateROI(roi.id, { type: 'text' })}
                                    className={`py-1 rounded text-[9px] font-bold flex items-center justify-center gap-1 transition-all ${roi.type === 'text' || !roi.type ? 'bg-blue-600 text-white shadow-sm':'bg-slate-800 text-slate-400'}`}
                                  >
                                    <FileText size={10} /> Text
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleUpdateROI(roi.id, { type: 'table' })}
                                    className={`py-1 rounded text-[9px] font-bold flex items-center justify-center gap-1 transition-all ${roi.type === 'table' ? 'bg-emerald-600 text-white shadow-sm':'bg-slate-800 text-slate-400'}`}
                                  >
                                    <Table size={10} /> Table
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleUpdateROI(roi.id, { type: 'image' })}
                                    className={`py-1 rounded text-[9px] font-bold flex items-center justify-center gap-1 transition-all ${roi.type === 'image' ? 'bg-amber-600 text-white shadow-sm':'bg-slate-800 text-slate-400'}`}
                                  >
                                    <ImageIcon size={10} /> Image
                                  </button>
                                </div>
                            </div>

                            {/* Role Classification Option */}
                            <div className="flex flex-col gap-0.5">
                              <label className="text-[8px] font-bold text-slate-400 uppercase tracking-wider text-left">Role Classification</label>
                              <select
                                value={roi.role || 'data_extraction'}
                                onChange={(e) => handleUpdateROI(roi.id, { role: e.target.value })}
                                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1 text-[11px] font-bold text-white focus:outline-none focus:border-indigo-500"
                              >
                                <option value="data_extraction">Data Field (ฟิลด์ดึงข้อมูลทั่วไป)</option>
                                <option value="anchor">Anchor Field (Text-based Anchor)</option>
                                <option value="visual_anchor">Visual Anchor (Image-based Anchor)</option>
                              </select>
                            </div>

                            <div className="flex items-center justify-between border-t border-slate-800 pt-1.5 mt-0.5">
                              <button type="button" onClick={() => handleDeleteROI(roi.id)} className="text-[9px] text-rose-500 hover:text-rose-600 font-bold flex items-center gap-0.5"><Trash2 size={10} /> Delete</button>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setSelectedId(null); }}
                                className="px-2.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[9px] font-bold"
                              >
                                Done
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </Rnd>
                  );
                })}

              </div>
            </div>
          </div>
        </div>

        {/* 🎛️ RIGHT SIDEBAR: PROPERTIES PANEL */}
        <div className="col-span-3 bg-white border border-slate-200 p-4 rounded-xl shadow-sm space-y-4 overflow-y-auto h-full select-none">
          <div className="border-b border-slate-100 pb-2">
            <h3 className="text-xs font-bold text-slate-700 tracking-wider uppercase flex items-center gap-1.5">
              <Layers size={13} className="text-[#0052cc]" />
              Active Fields ({currentPageRois.length})
            </h3>
          </div>

          {/* Active Admin Fields List */}
          <div className="space-y-1.5 max-h-[460px] overflow-y-auto pr-1">
            {currentPageRois.map((roi) => (
              <div 
                key={roi.id} 
                onClick={() => setSelectedId(roi.id)} 
                className={`flex items-center justify-between p-2 rounded border text-xs cursor-pointer transition-all ${selectedId === roi.id ? "bg-blue-50 border-blue-450 text-slate-800 font-medium" : "bg-white border-slate-200 text-slate-650 hover:bg-slate-50"}`}
              >
                <div className="flex items-center gap-2 w-full">
                  <Move size={12} className="text-slate-400 shrink-0" />
                  <span className="text-[10px] opacity-75 shrink-0 select-none">
                    {renderTypeIcon(roi.type, 11)}
                  </span>
                  <input 
                    type="text" 
                    value={roi.fieldName} 
                    onChange={(e) => handleUpdateROI(roi.id, { fieldName: e.target.value })} 
                    className="bg-transparent border-b border-transparent focus:border-indigo-500 focus:outline-none w-full cursor-text" 
                    onClick={(e) => e.stopPropagation()} 
                  />
                </div>
                <button type="button" onClick={(e) => { e.stopPropagation(); handleDeleteROI(roi.id); }} className="text-slate-400 hover:text-red-500 ml-1"><X size={13} /></button>
              </div>
            ))}
          </div>

          {/* User Ghost Fields List */}
          {currentPageGhostRois.length > 0 && (
            <div className="space-y-1.5 border-t border-slate-150 pt-3">
              <h4 className="text-[10px] font-bold text-amber-600 uppercase tracking-wider">Ghost Suggestions ({currentPageGhostRois.length})</h4>
              <div className="space-y-1 max-h-[140px] overflow-y-auto pr-1">
                {currentPageGhostRois.map((ghost: any, idx: number) => {
                  const isConverted = rois.some(r => r.fieldName === ghost.fieldName);
                  return (
                    <div 
                      key={`ghost_list_${ghost.id || idx}`}
                      onClick={() => { setSelectedGhostId(ghost.id); setSelectedId(null); }} 
                      className={`flex items-center justify-between p-1.5 rounded border text-[11px] cursor-pointer transition-all ${selectedGhostId === ghost.id ? "bg-amber-50 border-amber-250 text-amber-900 font-medium" : "bg-white border-slate-200 text-slate-550 hover:bg-slate-50"}`}
                    >
                      <span className={`truncate max-w-[110px] ${isConverted ? 'line-through text-slate-350':''}`}>{ghost.fieldName}</span>
                      {!isConverted ? (
                        <button type="button" onClick={(e) => { e.stopPropagation(); handleConvertGhost(ghost); }} className="text-[9px] text-indigo-600 hover:underline uppercase font-bold">Convert</button>
                      ) : (
                        <span className="text-[9.5px] text-emerald-600 font-bold">Converted</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

      </div>

      {/* 📄 🎠 FOOTER CAROUSEL & GLOBAL ACTION BUTTON */}
      {imagesList.length > 0 && (
        <div className="w-full bg-[#edf2f7] text-slate-800 border border-slate-200 rounded-2xl px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-4 shadow-sm select-none animate-fade-in">
          <div className="flex items-center gap-4">
            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              คลังเอกสารประมวลผล: <span className="text-slate-800 text-sm ml-1 font-bold">{currentPageIndex + 1} / {imagesList.length} หน้า</span>
            </div>
            
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                disabled={currentPageIndex === 0}
                onClick={() => { setCurrentPageIndex(currentPageIndex - 1); setSelectedId(null); setSelectedGhostId(null); }}
                className="p-2 bg-white text-slate-650 border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-30 disabled:hover:bg-white transition-all active:scale-95 flex items-center justify-center"
              >
                <ChevronLeft size={16} />
              </button>

              {/* Thumbnails */}
              <div className="flex items-center gap-2 overflow-x-auto max-w-[320px] py-0.5">
                {imagesList.map((url, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => { setCurrentPageIndex(idx); setSelectedId(null); setSelectedGhostId(null); }}
                    className={`relative w-9 h-12 rounded-md overflow-hidden border transition-all shrink-0 shadow-md ${
                      currentPageIndex === idx 
                        ? "border-blue-500 ring-2 ring-blue-500/50 scale-105" 
                        : "border-slate-250 opacity-60 hover:opacity-100"
                    }`}
                  >
                    <img src={url} alt={`Page ${idx + 1}`} className="w-full h-full object-cover pointer-events-none" />
                  </button>
                ))}
              </div>

              <button
                type="button"
                disabled={currentPageIndex === imagesList.length - 1}
                onClick={() => { setCurrentPageIndex(currentPageIndex + 1); setSelectedId(null); setSelectedGhostId(null); }}
                className="p-2 bg-white text-slate-650 border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-30 disabled:hover:bg-white transition-all active:scale-95 flex items-center justify-center"
              >
                <ChevronRightIcon size={16} />
              </button>
            </div>
          </div>

          {/* Right navigation buttons */}
          <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
            <button
              type="button"
              onClick={onPrev}
              className="px-4 py-2.5 bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1 active:scale-95"
            >
              <ArrowLeft size={13} /> ย้อนกลับ: ปรับภาพ
            </button>
            <button
              type="button"
              onClick={onNext}
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1 shadow-md shadow-indigo-900/20 active:scale-98"
            >
              ถัดไป: ตั้งค่าความปลอดภัย <ChevronRightIcon size={13} />
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
