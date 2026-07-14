"use client";

import React, { useState, useRef, useMemo, useEffect } from 'react';
import { ArrowLeft, Save, ZoomIn, ZoomOut, Maximize2, CheckCircle, Edit3, ChevronLeft, ChevronRight, Table, Image as ImageIcon, FileText, Eye, EyeOff } from 'lucide-react';
import { ROI, OCRResult } from '../../types/ocr';

const renderTypeIcon = (type?: 'text' | 'table' | 'image', size = 11) => {
  if (type === 'table') return <Table size={size} className="shrink-0 text-slate-400" />;
  if (type === 'image') return <ImageIcon size={size} className="shrink-0 text-slate-400" />;
  return <FileText size={size} className="shrink-0 text-slate-400" />;
};

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Unable to read image blob"));
    reader.readAsDataURL(blob);
  });

const imageUrlToCanvasSafeSrc = async (src: string) => {
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return src;
  const response = await fetch(src, { mode: "cors" });
  if (!response.ok) throw new Error(`Unable to load preview image: ${response.status}`);
  return blobToDataUrl(await response.blob());
};

const loadCanvasSafeImage = async (src: string) =>
  new Promise<HTMLImageElement>(async (resolve, reject) => {
    try {
      const safeSrc = await imageUrlToCanvasSafeSrc(src);
      const img = new Image();
      if (!safeSrc.startsWith("data:") && !safeSrc.startsWith("blob:")) {
        img.crossOrigin = "anonymous";
      }
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = safeSrc;
    } catch (error) {
      reject(error);
    }
  });


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
    let cancelled = false;

    const renderCrop = async () => {
      const img = await loadCanvasSafeImage(previewUrl);
      if (cancelled) return;

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

      if (!cancelled) {
        setCropSrc(canvas.toDataURL("image/jpeg", 0.9));
      }
    };

    renderCrop().catch((error) => {
      console.warn("Unable to render ROI preview crop.", error);
      if (!cancelled) setCropSrc("");
    });

    return () => {
      cancelled = true;
    };
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
  const [showLabels, setShowLabels] = useState<boolean>(true);

  // Keep the original OCR text for comparison while edits change extractedText.
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
  const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
  const [zoomIndex, setZoomIndex] = useState<number>(2); 
  const currentZoom = ZOOM_STEPS[zoomIndex];
  const viewportRef = useRef<HTMLDivElement | null>(null);


  const currentPageRois = useMemo(() => {
    return rois.filter(roi => (roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0) === currentImageIndex);
  }, [rois, currentImageIndex]);


  const currentPageOcrResults = useMemo(() => {
    return ocrResults.filter(res => (res.pageIndex !== undefined ? Number(res.pageIndex) : 0) === currentImageIndex);
  }, [ocrResults, currentImageIndex]);

  const getRoiForResult = (result: OCRResult & { pageIndex?: number }) => {
    return currentPageRois.find(roi => roi.id === result.roiId) || currentPageRois.find(roi => roi.fieldName === result.fieldName);
  };

  const handlePrevImage = () => {
    if (onImageIndexChange && currentImageIndex > 0) {
      onImageIndexChange(currentImageIndex - 1);
      setActiveFieldId(null); // Clear the selected field when changing pages.
    }
  };

  const handleNextImage = () => {
    if (onImageIndexChange && currentImageIndex < imageList.length - 1) {
      onImageIndexChange(currentImageIndex + 1);
      setActiveFieldId(null); // Clear the selected field when changing pages.
    }
  };

  const autoResizeTextarea = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    target.style.height = "auto";
    target.style.height = `${target.scrollHeight}px`;
  };

  return (
    <div className="max-w-7xl mx-auto space-y-4 pb-4 animate-fade-in">
      
      {/* Step progress bar */}
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

      {/* Main editor layout */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 xl:h-[720px] items-stretch">
        

        <div className="xl:col-span-5 bg-[#edf2f7] border border-slate-200 rounded-xl overflow-hidden flex flex-col min-h-[620px] xl:min-h-0 xl:h-full relative shadow-md">
          {/* Header controls for left canvas */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-white border-b border-slate-200">
            <span className="text-xs font-black text-slate-600 uppercase tracking-wider">Document Preview</span>
            <button
              type="button"
              onClick={() => setShowLabels(prev => !prev)}
              className={`p-1.5 rounded-lg border transition-all flex items-center gap-1.5 text-[10px] font-bold cursor-pointer ${
                !showLabels 
                  ? 'bg-amber-50 text-amber-600 border-amber-250 shadow-sm' 
                  : 'bg-slate-50 text-slate-500 hover:bg-slate-100 border-slate-200'
              }`}
              title={showLabels ? "Hide field labels" : "Show field labels"}
            >
              {showLabels ? <Eye size={12} /> : <EyeOff size={12} />}
              <span>{showLabels ? "Hide Labels" : "Show Labels"}</span>
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

        {/* OCR results table */}
                <div className="absolute inset-0 top-0 left-0 w-full h-full pointer-events-none">
                  {currentPageOcrResults.map((res) => {
                    const matchedRoi = getRoiForResult(res);
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
                                ? "border-orange-500 bg-orange-500/15 ring-4 ring-orange-500/20 z-30 shadow-lg" 
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


          <div className="absolute bottom-24 right-4 bg-white border border-slate-200 rounded-lg p-1 flex items-center gap-2 shadow-md z-20 text-slate-700">
            <button type="button" onClick={() => zoomIndex > 0 && setZoomIndex(prev => prev - 1)} className="p-1 hover:bg-slate-100 rounded text-slate-500"><ZoomOut size={12} /></button>
            <span className="text-[10px] font-mono font-bold w-10 text-center text-slate-650">{Math.round(currentZoom * 100)}%</span>
            <button type="button" onClick={() => zoomIndex < ZOOM_STEPS.length - 1 && setZoomIndex(prev => prev + 1)} className="p-1 hover:bg-slate-100 rounded text-slate-500"><ZoomIn size={12} /></button>
            <button type="button" onClick={() => setZoomIndex(2)} className="p-1 hover:bg-slate-100 rounded text-slate-400"><Maximize2 size={10} /></button>
          </div>

          {/* Page carousel */}
          <div className="bg-[#edf2f7] border-t border-slate-200 p-3 flex flex-col gap-2 select-none">
            <div className="flex items-center justify-between px-1">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Documents ({imageList.length} files)</span>
              <span className="text-[10px] font-mono bg-white text-slate-700 border border-slate-200 px-1.5 py-0.5 rounded font-bold">
                Page {currentImageIndex + 1} / {imageList.length}
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
                        isCurrent ? 'border-indigo-500 ring-2 ring-indigo-500/30' : 'border-slate-250 opacity-60 hover:opacity-100'
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

        {/* OCR results table */}
        <div className="xl:col-span-7 bg-white border border-slate-200 rounded-xl shadow-sm flex flex-col min-h-[620px] xl:min-h-0 xl:h-full overflow-hidden">
          <div className="p-4 border-b flex flex-col gap-3 bg-slate-50/50">
            <div className="flex justify-between items-center">
            <button
              type="button"
              onClick={onBackToStudio}
              className="py-1.5 px-3 hover:bg-slate-200/70 text-slate-600 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all"
            >
              <ArrowLeft size={14} /> Back to ROI Studio
            </button>
            <h3 className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
              <CheckCircle size={15} className="text-indigo-600" /> Review and edit OCR results
            </h3>
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                Page Results
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handlePrevImage}
                  disabled={currentImageIndex === 0}
                  className="h-8 w-8 rounded-lg border border-slate-200 bg-white text-slate-600 disabled:opacity-30 hover:bg-slate-50 flex items-center justify-center"
                  aria-label="Previous page"
                >
                  <ChevronLeft size={15} />
                </button>
                {imageList.map((_, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      if (onImageIndexChange) onImageIndexChange(idx);
                      setActiveFieldId(null);
                    }}
                    className={`h-8 min-w-8 rounded-lg border px-2 text-xs font-black transition-all ${
                      currentImageIndex === idx
                        ? "border-indigo-500 bg-indigo-600 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {idx + 1}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={handleNextImage}
                  disabled={currentImageIndex === imageList.length - 1}
                  className="h-8 w-8 rounded-lg border border-slate-200 bg-white text-slate-600 disabled:opacity-30 hover:bg-slate-50 flex items-center justify-center"
                  aria-label="Next page"
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          </div>

          <div className="overflow-y-auto flex-1 min-h-0">
            <table className="min-w-full text-xs text-left text-slate-600 table-fixed border-collapse">
              <thead className="bg-slate-50 font-sans text-slate-500 font-semibold border-b border-slate-100 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-3 w-[22%]">Field Channel</th>
                  <th className="px-4 py-3 w-[39%]">OCR Text</th>
                  <th className="px-4 py-3 w-[39%]">Editable Text</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {currentPageOcrResults.map((res) => {
                  const isSelected = activeFieldId === res.id;
                  const matchedRoi = getRoiForResult(res);
                  return (
                    <tr 
                      key={res.id} 
                      onClick={() => setActiveFieldId(res.id)} 
                      className={`group cursor-pointer border-l-4 transition-colors ${
                        isSelected
                          ? 'border-l-indigo-500 bg-indigo-50/40 font-medium'
                          : 'border-l-transparent hover:bg-slate-50/50'
                      }`}
                    >

                      <td className="px-4 py-4 align-top" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-center gap-1 bg-transparent border border-transparent rounded px-1 group-hover:border-slate-200 focus-within:border-indigo-400 focus-within:bg-white transition-all">
                            <input
                              type="text"
                              value={res.fieldName}
                              onFocus={() => setActiveFieldId(res.id)}
                              onChange={(e) => setOcrResults(p => p.map(item => item.id === res.id ? { ...item, fieldName: e.target.value } : item))}
                              className="w-full bg-transparent font-bold text-slate-700 focus:outline-none py-1 text-xs truncate"
                              placeholder="Field name..."
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
                      

                      <td className="px-4 py-4 align-top w-[39%]">
                        <div className="flex flex-col gap-1.5 h-full justify-between">
                          {matchedRoi?.type === 'image' ? (
                            <div className="flex flex-col gap-1 bg-white border border-slate-200 p-1.5 rounded-xl w-fit shadow-xs">
                              <CroppedRoiPreview previewUrl={previewUrl} roi={matchedRoi} />
                              <span className="text-[9px] font-bold text-slate-400">ROI crop preview</span>
                            </div>
                          ) : (
                            <div className="w-full bg-slate-50 border border-slate-200/80 rounded-xl px-3 py-2 text-slate-650 font-medium text-xs break-words leading-relaxed shadow-sm">
                              {res.originalText || <span className="text-slate-400 italic">(No text)</span>}
                            </div>
                          )}
                          <span className={`w-fit px-1.5 py-0.5 rounded text-[10px] font-mono font-bold mt-1 ${res.confidence >= 0.8 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                            Confidence: {(res.confidence * 100).toFixed(1)}%
                          </span>
                        </div>
                      </td>
                      

                      <td className="px-4 py-4 align-top w-[39%]" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-col gap-1.5 h-full justify-between">
                          {matchedRoi?.type === 'image' ? (
                            <div className="w-full bg-slate-50/50 border border-dashed border-slate-200 rounded-xl px-3 py-3 text-slate-400 font-bold text-center text-xs">
                              Image reference (No text)
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
                              placeholder="Edit OCR text..."
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


                {currentPageOcrResults.length === 0 && (
                  <tr>
                    <td colSpan={3} className="text-center py-20 text-slate-400 font-medium bg-slate-50/50">
                      No OCR results on this page <br />
                      <span className="text-[11px] font-normal text-slate-400">Go back to ROI Studio and run OCR first.</span>
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
              <Save size={15} /> Save
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

