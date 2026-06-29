"use client";

import React, { useRef, useMemo, useEffect, useState } from 'react';
import { 
  RotateCw, Crop, Check, RefreshCw, Minus, Plus, Scissors, 
  ChevronLeft, ChevronRight, Maximize2, Sparkles, FlipHorizontal, FlipVertical,
  RotateCcw
} from 'lucide-react';
import { Rnd } from 'react-rnd';

interface PageConfig {
  rotation: number;
  brightness: number;
  contrast: number;
  sharpness: number;
  perspectiveV: number;
  perspectiveH: number;
  flipH: boolean;
  flipV: boolean;
  cropBox: { 
    x: number; 
    y: number; 
    width: number; 
    height: number;
    renderedWidth?: number;
    renderedHeight?: number;
  } | null;
  isCropActive: boolean;
  isCropped: boolean;
  croppedLocalUrl: string | null;
}

interface AdjustZoneProps {
  imagesList: string[];
  currentIndex: number;
  onIndexChange: (index: number) => void;
  pagesConfig: PageConfig[];
  setPagesConfig: React.Dispatch<React.SetStateAction<PageConfig[]>>;
  onBatchConfirm: (finalImages: string[]) => void;
}

const DEFAULT_CONFIG: PageConfig = {
  rotation: 0,
  brightness: 100,
  contrast: 100,
  sharpness: 0,
  perspectiveV: 0,
  perspectiveH: 0,
  flipH: false,
  flipV: false,
  cropBox: null,
  isCropActive: false,
  isCropped: false,
  croppedLocalUrl: null
};

export default function AdjustZone({
  imagesList,
  currentIndex,
  onIndexChange,
  pagesConfig,
  setPagesConfig,
  onBatchConfirm,
}: AdjustZoneProps) {
  
  // ✨ สเตตพิเศษ: ใช้ล็อกและจำ URL รูปภาพแรกสุดที่ component นี้เคยได้รับ (ห้ามใครเปลี่ยน)
  const [originalBackupList, setOriginalBackupList] = useState<string[]>([]);

  // ถ้าโหลดเข้ามาครั้งแรกสุด และ backup ยังว่าง ให้เซ็ตค่าจำรูปออริจินัลไว้เลย
  useEffect(() => {
    if (imagesList.length > 0 && originalBackupList.length === 0) {
      setOriginalBackupList([...imagesList]);
    }
  }, [imagesList]);

  // สลับมาดึงจากข้อมูล Backup ดั้งเดิมแทน imagesList โดยตรง เผื่อกรณีโดนเขียนทับไปแล้ว
  const currentRawUrl = originalBackupList[currentIndex] || imagesList[currentIndex] || "";
  
  const rawImageRef = useRef<HTMLImageElement | null>(null);
  const croppedImageRef = useRef<HTMLImageElement | null>(null);
  const [liveCropPreviewUrl, setLiveCropPreviewUrl] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  const currentConfig = useMemo(() => {
    return pagesConfig[currentIndex] || { ...DEFAULT_CONFIG };
  }, [pagesConfig, currentIndex]);

  const { 
    rotation, brightness, contrast, sharpness, 
    perspectiveV, perspectiveH, flipH, flipV,
    cropBox, isCropActive, isCropped, croppedLocalUrl 
  } = currentConfig;

  const updateCurrentConfig = (fields: Partial<PageConfig>) => {
    setPagesConfig(prev => {
      const updated = [...prev];
      if (!updated[currentIndex]) {
        updated[currentIndex] = { ...DEFAULT_CONFIG, ...fields };
      } else {
        updated[currentIndex] = { ...updated[currentIndex], ...fields };
      }
      return updated;
    });
  };

  const extractCropAreaUrl = (imgEl: HTMLImageElement, config: PageConfig): string | null => {
    // 🛡️ กันรูปพัง: เช็คความสมบูรณ์ของ Element ภาพต้นทาง
    if (!imgEl || !imgEl.complete || imgEl.naturalWidth === 0 || !config.cropBox) return null;
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const naturalWidth = imgEl.naturalWidth;
    const naturalHeight = imgEl.naturalHeight;
    const renderedWidth = config.cropBox.renderedWidth ?? imgEl.clientWidth ?? 1;
    const renderedHeight = config.cropBox.renderedHeight ?? imgEl.clientHeight ?? 1;

    const imgRatio = naturalWidth / naturalHeight;
    const containerRatio = renderedWidth / renderedHeight;
    
    let displayedImgWidth = renderedWidth;
    let displayedImgHeight = renderedHeight;
    let offsetX = 0;
    let offsetY = 0;

    if (imgRatio > containerRatio) {
      displayedImgHeight = renderedWidth / imgRatio;
      offsetY = (renderedHeight - displayedImgHeight) / 2;
    } else {
      displayedImgWidth = renderedHeight * imgRatio;
      offsetX = (renderedWidth - displayedImgWidth) / 2;
    }

    const scaleX = naturalWidth / (displayedImgWidth || 1);
    const scaleY = naturalHeight / (displayedImgHeight || 1);
    const relativeX = config.cropBox.x - offsetX;
    const relativeY = config.cropBox.y - offsetY;

    const realX = Math.max(0, relativeX * scaleX);
    const realY = Math.max(0, relativeY * scaleY);
    const realWidth = Math.min(naturalWidth, config.cropBox.width * scaleX);
    const realHeight = Math.min(naturalHeight, config.cropBox.height * scaleY);

    if (realWidth <= 0 || realHeight <= 0) return null;

    canvas.width = realWidth;
    canvas.height = realHeight;
    ctx.drawImage(imgEl, realX, realY, realWidth, realHeight, 0, 0, realWidth, realHeight);

    return canvas.toDataURL('image/jpeg', 0.95);
  };

  useEffect(() => {
    // 🛡️ ป้องกัน Live Preview เสียหาย: เช็คความพร้อมของรูปภาพบน DOM ก่อนอัปเดตสเตต
    if (isCropped && rawImageRef.current && rawImageRef.current.complete && rawImageRef.current.naturalWidth > 0) {
      const croppedUrl = extractCropAreaUrl(rawImageRef.current, currentConfig);
      if (croppedUrl && !croppedUrl.startsWith("data:;")) {
        setLiveCropPreviewUrl(croppedUrl);
      } else {
        setLiveCropPreviewUrl(croppedLocalUrl);
      }
    } else {
      setLiveCropPreviewUrl(isCropped ? croppedLocalUrl : null);
    }
  }, [isCropped, cropBox, currentIndex, currentRawUrl, croppedLocalUrl]);

  const processSingleImageCanvas = (imgEl: HTMLImageElement, config: PageConfig, baseIsCropped: boolean): string => {
    // 🛡️ ป้องกันรูปค้าง/รูปดำ: ถ้ารูปยังโหลดไม่เสร็จหรือไม่มีมิติความกว้าง ให้คืนค่า src ดั้งเดิมทันที
    if (!imgEl || !imgEl.complete || imgEl.naturalWidth === 0 || imgEl.naturalHeight === 0) {
      return imgEl?.src || "";
    }

    const naturalWidth = imgEl.naturalWidth;
    const naturalHeight = imgEl.naturalHeight;

    let sourceCanvas = document.createElement('canvas');
    let targetWidth = naturalWidth;
    let targetHeight = naturalHeight;

    if (!baseIsCropped && config.cropBox) {
      const renderedWidth = config.cropBox.renderedWidth ?? imgEl.clientWidth ?? 500;
      const renderedHeight = config.cropBox.renderedHeight ?? imgEl.clientHeight ?? 500;
      
      const safeRenderedWidth = renderedWidth <= 0 ? 500 : renderedWidth;
      const safeRenderedHeight = renderedHeight <= 0 ? 500 : renderedHeight;

      const imgRatio = naturalWidth / naturalHeight;
      const containerRatio = safeRenderedWidth / safeRenderedHeight;
      
      let displayedImgWidth = safeRenderedWidth, displayedImgHeight = safeRenderedHeight, offsetX = 0, offsetY = 0;
      if (imgRatio > containerRatio) { 
        displayedImgHeight = safeRenderedWidth / imgRatio; 
        offsetY = (safeRenderedHeight - displayedImgHeight) / 2; 
      } else { 
        displayedImgWidth = safeRenderedHeight * imgRatio; 
        offsetX = (safeRenderedWidth - displayedImgWidth) / 2; 
      }

      const scaleX = naturalWidth / (displayedImgWidth || 1);
      const scaleY = naturalHeight / (displayedImgHeight || 1);
      
      const targetX = Math.max(0, (config.cropBox.x - offsetX) * scaleX);
      const targetY = Math.max(0, (config.cropBox.y - offsetY) * scaleY);
      targetWidth = Math.min(naturalWidth, config.cropBox.width * scaleX);
      targetHeight = Math.min(naturalHeight, config.cropBox.height * scaleY);

      if (targetWidth <= 0 || targetHeight <= 0) return imgEl.src;

      sourceCanvas.width = targetWidth;
      sourceCanvas.height = targetHeight;
      const sCtx = sourceCanvas.getContext('2d');
      if (sCtx) {
        sCtx.drawImage(imgEl, targetX, targetY, targetWidth, targetHeight, 0, 0, targetWidth, targetHeight);
      }
    } else {
      sourceCanvas.width = naturalWidth;
      sourceCanvas.height = naturalHeight;
      const sCtx = sourceCanvas.getContext('2d');
      if (sCtx) {
        sCtx.drawImage(imgEl, 0, 0);
      }
    }

    const finalCanvas = document.createElement('canvas');
    const ctx = finalCanvas.getContext('2d');
    if (!ctx) return imgEl.src;

    const angleRad = (config.rotation * Math.PI) / 180;
    const dV = Math.tan((config.perspectiveV * Math.PI) / 180);
    const dH = Math.tan((config.perspectiveH * Math.PI) / 180);

    const absCos = Math.abs(Math.cos(angleRad));
    const absSin = Math.abs(Math.sin(angleRad));
    
    let baseWidth = targetWidth * absCos + targetHeight * absSin;
    let baseHeight = targetWidth * absSin + targetHeight * absCos;
    
    let finalWidth = baseWidth + Math.abs(baseHeight * dH);
    let finalHeight = baseHeight + Math.abs(baseWidth * dV);

    if (finalWidth <= 0 || finalHeight <= 0) return imgEl.src;

    finalCanvas.width = finalWidth;
    finalCanvas.height = finalHeight;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, finalWidth, finalHeight);

    ctx.translate(finalWidth / 2, finalHeight / 2);
    ctx.scale(config.flipH ? -1 : 1, config.flipV ? -1 : 1);
    ctx.rotate(angleRad);
    ctx.transform(1, dV, dH, 1, 0, 0);

    ctx.filter = `brightness(${config.brightness}%) contrast(${config.contrast + config.sharpness}%)`;
    ctx.drawImage(sourceCanvas, -targetWidth / 2, -targetHeight / 2);

    return finalCanvas.toDataURL('image/jpeg', 0.95);
  };

  // ✨ ฟังก์ชันสลับหน้าอัจฉริยะ: เรนเดอร์และเซฟงานหน้าปัจจุบันลงหน่วยความจำแยกหน้าก่อนเปิดหน้าถัดไป
  const handleSafeIndexChange = async (nextIndex: number) => {
    if (isProcessing) return;
    setIsProcessing(true);

    try {
      const activeImageElement = isCropped ? croppedImageRef.current : rawImageRef.current;
      
      // 🛡️ เช็คสถานะภาพบน DOM ก่อนการเซฟลงประวัติเพื่อบล็อกการสร้างรูปภาพดำเปล่า ๆ
      if (activeImageElement && activeImageElement.complete && activeImageElement.naturalWidth > 0) {
        const config = pagesConfig[currentIndex] || { ...DEFAULT_CONFIG };
        const resultUrl = processSingleImageCanvas(activeImageElement, config, isCropped);
        
        if (resultUrl && !resultUrl.startsWith("data:;")) {
          setPagesConfig(prev => {
            const updated = [...prev];
            if (!updated[currentIndex]) updated[currentIndex] = { ...DEFAULT_CONFIG };
            updated[currentIndex] = { 
              ...updated[currentIndex], 
              croppedLocalUrl: resultUrl 
            };
            return updated;
          });
        }
      }
    } catch (err) {
      console.error("Error auto-saving page changes:", err);
    } finally {
      setIsProcessing(false);
      onIndexChange(nextIndex); // เปลี่ยนหน้า
    }
  };

  // 🚀 รวบรวมภาพตกแต่งสมบูรณ์ของทุกหน้าแยกอิสระ ส่งขึ้นสู่หน้าประมวลผลกล่องข้อความใหญ่
  const handleConfirmAll = async () => {
    if (isProcessing) return;
    setIsProcessing(true);

    try {
      let finalProcessedImages = originalBackupList.length > 0 ? [...originalBackupList] : [...imagesList];
      const activeImageElement = isCropped ? croppedImageRef.current : rawImageRef.current;

      let currentResultUrl = "";
      if (activeImageElement && activeImageElement.complete && activeImageElement.naturalWidth > 0) {
        const config = pagesConfig[currentIndex] || { ...DEFAULT_CONFIG };
        currentResultUrl = processSingleImageCanvas(activeImageElement, config, isCropped);
      }

      // วนรอบตรวจสอบเพื่อรวบรวมข้อมูล Base64 ที่ดีที่สุดของแต่ละหน้าส่งออก
      const allPagesFinalArray = finalProcessedImages.map((rawUrl, idx) => {
        if (idx === currentIndex && currentResultUrl && !currentResultUrl.startsWith("data:;")) {
          return currentResultUrl;
        }
        return pagesConfig[idx]?.croppedLocalUrl || rawUrl;
      });

      onBatchConfirm(allPagesFinalArray);

    } catch (error) {
      console.error("Error processing final images:", error);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleResetToDefault = () => {
    setLiveCropPreviewUrl(null);
    
    updateCurrentConfig({ 
      ...DEFAULT_CONFIG,
      isCropped: false,
      isCropActive: false,
      croppedLocalUrl: null,
      cropBox: null
    });

    setPagesConfig(prev => {
      const updated = [...prev];
      if (updated[currentIndex]) {
        updated[currentIndex] = {
          ...DEFAULT_CONFIG,
          croppedLocalUrl: null
        };
      }
      return updated;
    });
  };

  const handleInstantLocalCrop = () => {
    if (cropBox && rawImageRef.current && rawImageRef.current.complete && rawImageRef.current.naturalWidth > 0) {
      const croppedUrl = extractCropAreaUrl(rawImageRef.current, currentConfig);
      updateCurrentConfig({ 
        isCropped: true, 
        isCropActive: false,
        croppedLocalUrl: croppedUrl,
        cropBox: {
          ...cropBox,
          renderedWidth: rawImageRef.current.clientWidth,
          renderedHeight: rawImageRef.current.clientHeight
        }
      });
    }
  };

  const handleModifyCrop = () => {
    updateCurrentConfig({ isCropped: false, isCropActive: true });
  };

  const handleActivateCrop = () => {
    const imgEl = rawImageRef.current;
    if (!imgEl) return;
    
    if (cropBox) {
      updateCurrentConfig({ isCropActive: true, isCropped: false });
      return;
    }

    const w = Math.min(320, imgEl.clientWidth - 20);
    const h = Math.min(240, imgEl.clientHeight - 20);
    updateCurrentConfig({
      isCropActive: true,
      isCropped: false,
      cropBox: { 
        x: (imgEl.clientWidth - w) / 2, 
        y: (imgEl.clientHeight - h) / 2, 
        width: w, 
        height: h,
        renderedWidth: imgEl.clientWidth,
        renderedHeight: imgEl.clientHeight
      }
    });
  };

  const handleNumberChange = (val: string, min: number, max: number, key: keyof PageConfig) => {
    let num = Number(val);
    if (num > max) num = max;
    if (num < min) num = min;
    updateCurrentConfig({ [key]: num });
  };

  const handleHandleStyle = {
    width: "10px", height: "10px", background: "#ffffff",
    border: "2px solid #0052cc", borderRadius: "50%",
    boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
  };

  const dynamicPreviewStyle = useMemo(() => {
    let transforms = [];
    if (flipH) transforms.push("scaleX(-1)");
    if (flipV) transforms.push("scaleY(-1)");
    if (rotation !== 0) transforms.push(`rotate(${rotation}deg)`);
    
    if (perspectiveH !== 0) transforms.push(`skewX(${perspectiveH}deg)`);
    if (perspectiveV !== 0) transforms.push(`skewY(${perspectiveV}deg)`);

    return {
      transform: transforms.join(" "),
      transformOrigin: "center center",
      filter: `brightness(${brightness}%) contrast(${contrast + sharpness}%)`,
      transition: "transform 0.15s ease-out, filter 0.1s ease"
    };
  }, [rotation, perspectiveV, perspectiveH, flipH, flipV, brightness, contrast, sharpness]);

  return (
    <div className="max-w-7xl mx-auto bg-[#f8fafc] border border-slate-200 rounded-2xl p-4 md:p-6 space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs">
        <h2 className="text-sm font-bold text-[#172b4d] flex items-center gap-2 tracking-wide uppercase">
          <Crop size={16} className="text-[#0052cc]" /> Image Configuration Panel
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">จัดระเบียบโครงสร้างระนาบ ความคมชัด และสัดส่วนขอบเขตของหน้าเอกสารก่อนการวิเคราะห์โครงสร้าง</p>
      </div>

      <div className="grid grid-cols-12 gap-6 items-stretch">
        <div className="col-span-12 lg:col-span-8 flex flex-col gap-4">
          <div className="bg-[#edf2f7] border border-slate-200 rounded-xl flex items-center justify-center h-[540px] overflow-hidden shadow-inner relative p-4">
            
            <div className="relative flex items-center justify-center w-full h-full">
              {isCropped && liveCropPreviewUrl ? (
                <img 
                  ref={croppedImageRef} 
                  src={liveCropPreviewUrl} 
                  alt="Cropped Sub-Region Preview" 
                  className="max-h-[460px] max-w-full w-auto h-auto block border border-slate-300 shadow-2xl bg-white rounded-lg select-none object-contain"
                  style={dynamicPreviewStyle} 
                />
              ) : (
                <div className="relative inline-block max-h-[440px] max-w-full">
                  <img 
                    ref={rawImageRef} 
                    src={currentRawUrl} 
                    alt="Main Raw Input Preview" 
                    className="max-h-[440px] max-w-full block border border-slate-200 shadow-xl bg-white rounded-lg select-none object-contain" 
                    style={dynamicPreviewStyle} 
                  />
                  
                  {isCropActive && cropBox && (
                    <Rnd
                      size={{ width: cropBox.width, height: cropBox.height }}
                      position={{ x: cropBox.x, y: cropBox.y }}
                      onDragStop={(e, d) => updateCurrentConfig({ cropBox: { ...cropBox, x: d.x, y: d.y } })}
                      onResizeStop={(e, dir, ref, delta, pos) => updateCurrentConfig({ cropBox: { width: parseInt(ref.style.width), height: parseInt(ref.style.height), ...pos } })}
                      bounds="parent"
                      className="border-2 border-dashed border-blue-500 bg-blue-500/5 z-40"
                      resizeHandleStyles={{
                        topLeft: handleHandleStyle, topRight: handleHandleStyle, bottomLeft: handleHandleStyle, bottomRight: handleHandleStyle,
                        top: handleHandleStyle, right: handleHandleStyle, bottom: handleHandleStyle, left: handleHandleStyle
                      }}
                    >
                      <div className="w-full h-full relative">
                        <span className="absolute top-1 left-1 bg-blue-600 text-white text-[8px] font-bold tracking-wider px-1.5 py-0.5 rounded shadow pointer-events-none uppercase">CROP ZONE</span>
                      </div>
                    </Rnd>
                  )}
                </div>
              )}
            </div>

            {isCropped && (
              <span className="text-[10px] bg-slate-800/90 text-slate-200 font-medium tracking-wider px-3 py-1 rounded-md absolute bottom-4 shadow whitespace-nowrap z-50">
                PREVIEW MODE: ภาพตัดถูกจัดกึ่งกลางและปรับขยายให้พอดีกรอบอัตโนมัติแล้ว
              </span>
            )}
          </div>

          <div className="bg-[#edf2f7] border border-slate-200 rounded-xl p-3 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-slate-600 text-xs font-semibold px-2 shrink-0">
              คลังเอกสารประมวลผล: <span className="text-blue-600 font-mono font-bold ml-1">{currentIndex + 1} / {imagesList.length} หน้า</span>
            </div>
            <div className="flex items-center gap-2 flex-1 justify-center w-full">
              <button type="button" disabled={currentIndex === 0 || isProcessing} onClick={() => handleSafeIndexChange(currentIndex - 1)} className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-slate-700 disabled:opacity-25"><ChevronLeft size={16} /></button>
              
              <div className="flex gap-2 overflow-x-auto max-w-xl py-1 no-scrollbar" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' }}>
                <style>{`.no-scrollbar::-webkit-scrollbar { display: none; }`}</style>
                {imagesList.map((url, idx) => (
                  <button 
                    key={idx} 
                    type="button" 
                    disabled={isProcessing}
                    onClick={() => handleSafeIndexChange(idx)} 
                    className={`relative w-11 h-14 rounded border-2 overflow-hidden bg-white shrink-0 transition-all ${idx === currentIndex ? 'border-blue-500 ring-2 ring-blue-500/10 scale-105' : 'border-slate-200 opacity-50 hover:opacity-100'}`}
                  >
                    <img src={pagesConfig[idx]?.croppedLocalUrl || originalBackupList[idx] || url} className="w-full h-full object-cover" alt="" />
                    <div className="absolute bottom-0 inset-x-0 bg-slate-900/80 text-[8px] text-slate-300 text-center font-mono py-0.5">#{idx + 1}</div>
                  </button>
                ))}
              </div>

              <button type="button" disabled={currentIndex === imagesList.length - 1 || isProcessing} onClick={() => handleSafeIndexChange(currentIndex + 1)} className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-slate-700"><ChevronRight size={16} /></button>
            </div>
          </div>
        </div>
        
        <div className="col-span-12 lg:col-span-4 border border-slate-200 rounded-xl bg-slate-50 shadow-2xs flex flex-col overflow-hidden h-full min-h-[616px]">
          <div className="p-4 space-y-4 overflow-y-auto flex-1 pr-1.5 max-h-[530px]">
            
            <div className="bg-white p-3.5 rounded-xl border border-rose-100 bg-rose-50/10 shadow-3xs space-y-2">
              <h3 className="text-xs font-bold text-rose-700 uppercase tracking-wider flex items-center gap-1.5">
                <RotateCcw size={13} className="text-rose-600" /> Reset Options
              </h3>
              <p className="text-[11px] text-slate-400 leading-normal">ล้างฟิลเตอร์ ปรับระนาบ และยกเลิกกรอบครอบตัดทั้งหมดเพื่อกลับไปใช้ภาพต้นฉบับดั้งเดิม</p>
              <button 
                type="button" 
                onClick={handleResetToDefault} 
                className="w-full py-2 bg-white border border-rose-200 text-rose-600 hover:bg-rose-50 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-colors shadow-3xs cursor-pointer"
              >
                <RefreshCw size={13} /> ล้างค่าทั้งหมดกลับสู่รูปต้นฉบับ
              </button>
            </div>

            <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-3xs space-y-2.5">
              <div className="flex justify-between items-center border-b border-slate-100 pb-2">
                <h3 className="text-xs font-bold text-[#172b4d] uppercase tracking-wider flex items-center gap-1.5"><Crop size={13} className="text-blue-600" /> Crop Studio</h3>
                <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded ${isCropped ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-50 text-slate-400'}`}>{isCropped ? "CROPPED" : "READY"}</span>
              </div>
              <div className="flex flex-col gap-2">
                {!isCropped ? (
                  isCropActive ? (
                    <button type="button" onClick={handleInstantLocalCrop} className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm transition-all active:scale-95"><Scissors size={13} /> ดำเนินการครอบตัดหน้าปัจจุบัน</button>
                  ) : (
                    <button type="button" onClick={handleActivateCrop} className="w-full py-2 bg-white border border-slate-200 text-slate-700 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 hover:bg-slate-50 shadow-3xs transition-colors"><Crop size={13} /> เปิดใช้งานฟังก์ชันครอบตัด</button>
                  )
                ) : (
                  <button type="button" onClick={handleModifyCrop} className="w-full py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-colors shadow-sm">
                    <RefreshCw size={13} /> ปรับปรุง/แก้ไขกรอบตัดภาพใหม่
                  </button>
                )}
              </div>
            </div>

            <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-3xs space-y-2">
              <h3 className="text-xs font-bold text-[#172b4d] uppercase tracking-wider flex items-center gap-1.5"><FlipHorizontal size={13} className="text-slate-500" /> Mirror Transforms</h3>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => updateCurrentConfig({ flipH: !flipH })} className={`py-1.5 text-xs font-semibold rounded-lg border flex items-center justify-center gap-1.5 transition-all ${flipH ? 'bg-blue-50 text-blue-700 border-blue-400 font-bold' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                  <FlipHorizontal size={13} /> กลับแนวนอน
                </button>
                <button type="button" onClick={() => updateCurrentConfig({ flipV: !flipV })} className={`py-1.5 text-xs font-semibold rounded-lg border flex items-center justify-center gap-1.5 transition-all ${flipV ? 'bg-blue-50 text-blue-700 border-blue-400 font-bold' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                  <FlipVertical size={13} /> กลับแนวตั้ง
                </button>
              </div>
            </div>

            <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-3xs space-y-3.5">
              <div className="flex justify-between items-center border-b border-slate-100 pb-2">
                <h3 className="text-xs font-bold text-[#172b4d] uppercase tracking-wider flex items-center gap-1.5"><Maximize2 size={13} className="text-slate-600" /> Perspective Alignment</h3>
                <button type="button" onClick={() => updateCurrentConfig({ perspectiveV: 0, perspectiveH: 0 })} className="text-[10px] font-semibold text-slate-400 hover:text-slate-600"><RefreshCw size={10} className="inline mr-0.5" /> ล้างระนาบเอียง</button>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">ปรับระนาบแนวตั้ง (Vertical Tilt)</span>
                  <div className="flex items-center text-slate-800 font-mono font-bold text-xs">
                    <input type="number" min="-20" max="20" value={perspectiveV} onChange={(e) => handleNumberChange(e.target.value, -20, 20, "perspectiveV")} className="w-8 text-right bg-transparent focus:outline-none" />
                    <span className="text-slate-400 font-normal ml-0.5">°</span>
                  </div>
                </div>
                <input type="range" min="-20" max="20" value={perspectiveV} onChange={(e) => updateCurrentConfig({ perspectiveV: Number(e.target.value) })} className="w-full accent-blue-600 h-1 bg-slate-200 rounded cursor-pointer" />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">ปรับระนาบแนวนอน (Horizontal Tilt)</span>
                  <div className="flex items-center text-slate-800 font-mono font-bold text-xs">
                    <input type="number" min="-20" max="20" value={perspectiveH} onChange={(e) => handleNumberChange(e.target.value, -20, 20, "perspectiveH")} className="w-8 text-right bg-transparent focus:outline-none" />
                    <span className="text-slate-400 font-normal ml-0.5">°</span>
                  </div>
                </div>
                <input type="range" min="-20" max="20" value={perspectiveH} onChange={(e) => updateCurrentConfig({ perspectiveH: Number(e.target.value) })} className="w-full accent-blue-600 h-1 bg-slate-200 rounded cursor-pointer" />
              </div>
            </div>

            {[
              { label: "Image Rotation", value: rotation, min: -180, max: 180, unit: "°", icon: <RotateCw size={12} className="text-slate-500" />, key: "rotation" as keyof PageConfig, resetVal: 0, step: 90 },
              { label: "Brightness Level", value: brightness, min: 50, max: 150, unit: "%", icon: <Sparkles size={12} className="text-slate-500" />, key: "brightness" as keyof PageConfig, resetVal: 100, step: 5 },
              { label: "Contrast Level", value: contrast, min: 50, max: 150, unit: "%", icon: <Sparkles size={12} className="text-slate-500" />, key: "contrast" as keyof PageConfig, resetVal: 100, step: 5 },
              { label: "Text Sharpness Index", value: sharpness, min: 0, max: 100, unit: "%", icon: <Sparkles size={12} className="text-slate-500" />, key: "sharpness" as keyof PageConfig, resetVal: 0, step: 10 }
            ].map((item) => (
              <div key={item.key} className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-3xs space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wider flex items-center gap-1.5">{item.icon} {item.label}</label>
                  <div className="flex items-center text-slate-800 font-mono font-bold text-xs">
                    <input 
                      type="number" min={item.min} max={item.max} value={Number(item.value)} 
                      onChange={(e) => handleNumberChange(e.target.value, item.min, item.max, item.key)}
                      className="w-10 text-right bg-transparent focus:outline-none"
                    />
                    <span className="text-slate-400 font-normal ml-0.5">{item.unit}</span>
                  </div>
                </div>
                
                <input type="range" min={item.min} max={item.max} value={Number(item.value)} onChange={(e) => updateCurrentConfig({ [item.key]: Number(e.target.value) })} className="w-full accent-blue-600 h-1 bg-slate-200 rounded cursor-pointer" />
                
                <div className="flex gap-1.5 items-center pt-1">
                  <button type="button" onClick={() => updateCurrentConfig({ [item.key]: Math.max(item.min, Number(item.value) - item.step) })} className="text-[10px] font-bold bg-white border border-slate-200 px-2.5 py-0.5 rounded text-slate-600 hover:bg-slate-50"><Minus size={9} className="inline mr-0.5" />-{item.step}</button>
                  <button type="button" onClick={() => updateCurrentConfig({ [item.key]: Math.min(item.max, Number(item.value) + item.step) })} className="text-[10px] font-bold bg-white border border-slate-200 px-2.5 py-0.5 rounded text-slate-600 hover:bg-slate-50"><Plus size={9} className="inline mr-0.5" />+{item.step}</button>
                  <button type="button" onClick={() => updateCurrentConfig({ [item.key]: item.resetVal })} className="text-[10px] font-semibold text-slate-400 border border-transparent ml-auto hover:text-slate-600 transition-colors"><RefreshCw size={9} className="inline mr-0.5" /> รีเซ็ต</button>
                </div>
              </div>
            ))}
          </div>

          <div className="p-4 bg-white border-t border-slate-200 shadow-[0_-4px_12px_rgba(0,0,0,0.02)] mt-auto shrink-0">
            <button 
              type="button"
              disabled={isProcessing}
              onClick={handleConfirmAll} 
              className="w-full px-6 bg-[#0052cc] hover:bg-[#0043a4] disabled:bg-slate-400 text-white py-3.5 rounded-xl text-xs font-bold tracking-wider uppercase shadow-md active:scale-98 transition-all flex items-center justify-center gap-2"
            >
              {isProcessing ? (
                <>
                  <RefreshCw size={14} className="animate-spin" /> Processing Images...
                </>
              ) : (
                <>
                  <Check size={14} /> Confirm Layout & Edit ROI
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}