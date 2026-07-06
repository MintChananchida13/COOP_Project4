"use client";

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Square, Trash2, Move, Hand, X, ArrowLeft, ZoomIn, ZoomOut, Maximize2, Cpu, FileText, Table, Image as ImageIcon, PenTool, Grid, ChevronUp, ChevronDown, Eye, EyeOff, Undo2, Redo2 } from 'lucide-react';
import { Rnd } from "react-rnd";
import { ROI } from '../../types/ocr';
import { WorkspaceImageMetrics } from './roiGeometry';

const renderTypeIcon = (type?: 'text' | 'table' | 'image', size = 11) => {
  if (type === 'table') return <Table size={size} className="shrink-0" />;
  if (type === 'image') return <ImageIcon size={size} className="shrink-0" />;
  return <FileText size={size} className="shrink-0" />;
};

const roiTypePatch = (type: 'text' | 'table' | 'image'): Partial<ROI> => ({
  type,
  dataType: type,
  extractionMethod: type === 'table' ? 'ocr_table' : type === 'image' ? 'extract_image' : 'ocr_text',
});

export interface WorkspaceCustomEditorProps {
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
  onRunFullPageOCR: () => Promise<void>;
  ocrProgress?: {
    currentPage: number;
    totalPages: number;
  } | null;
  currentIndex: number;
  imagesList: string[]; 
  onIndexChange: (index: number) => void;
  hideOcrActions?: boolean;
  readOnly?: boolean;
  hideStepProgress?: boolean;
  hideRightPanel?: boolean;
  hideFooter?: boolean;
  workspaceHeightClassName?: string;
  rootClassName?: string;
  rightPanelRenderer?: (api: {
    currentPageRois: (ROI & { pageIndex?: number })[];
    selectedId: number | null;
    setSelectedId: React.Dispatch<React.SetStateAction<number | null>>;
    updateROI: (id: number, fields: Partial<ROI>) => void;
    deleteROI: (id: number) => void;
    moveROI: (index: number, direction: 'up' | 'down') => void;
  }) => React.ReactNode;
  toolbarExtra?: React.ReactNode;
  getRoiClassName?: (roi: ROI & { pageIndex?: number }, selected: boolean, activeTool: 'pan' | 'box' | 'quad' | 'polygon') => string;
  getRoiLabelClassName?: (roi: ROI & { pageIndex?: number }, selected: boolean) => string;
  onImageMetricsChange?: (metrics: WorkspaceImageMetrics) => void;
}

export default function WorkspaceCustomEditor({
  previewUrl,
  rois,
  setRois,
  selectedId,
  setSelectedId,
  onBackToAdjust,
  deleteROI,
  isLoading,
  onRunOCR,
  onRunFullPageOCR,
  ocrProgress,
  currentIndex,
  imagesList,    
  onIndexChange,
  hideOcrActions = false,
  readOnly = false,
  hideStepProgress = false,
  hideRightPanel = false,
  hideFooter = false,
  workspaceHeightClassName = "h-[620px]",
  rootClassName = "max-w-7xl mx-auto space-y-6 pb-20",
  rightPanelRenderer,
  toolbarExtra,
  getRoiClassName,
  getRoiLabelClassName,
  onImageMetricsChange,
}: WorkspaceCustomEditorProps) {
  const [activeTool, setActiveTool] = useState<'pan' | 'box' | 'quad' | 'polygon'>(readOnly ? 'pan' : 'box');
  const [activeDrawPoints, setActiveDrawPoints] = useState<{ x: number; y: number }[]>([]);

  // Calculate the bounding box for custom ROI points.
  const getBoundingBoxOfPoints = (points: { x: number; y: number }[]) => {
    if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  };
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [dragBox, setDragBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Standard zoom levels.
  const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
  const [zoomIndex, setZoomIndex] = useState<number>(2); 
  const currentZoom = ZOOM_STEPS[zoomIndex];
  const [displayProgress, setDisplayProgress] = useState(0);
  const [ocrDone, setOcrDone] = useState(false);

  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ scrollLeft: 0, scrollTop: 0, clientX: 0, clientY: 0 });

  const imageRef = useRef<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const currentZoomRef = useRef(currentZoom);

  useEffect(() => {
    currentZoomRef.current = currentZoom;
  }, [currentZoom]);

  const reportImageMetrics = React.useCallback(() => {
    if (!imageRef.current || !containerRef.current || !onImageMetricsChange) return;
    const imageRect = imageRef.current.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    const measuredZoom = currentZoomRef.current || 1;
    onImageMetricsChange({
      imageOffsetX: (imageRect.left - containerRect.left) / measuredZoom,
      imageOffsetY: (imageRect.top - containerRect.top) / measuredZoom,
      imageWidth: imageRect.width / measuredZoom,
      imageHeight: imageRect.height / measuredZoom,
      naturalWidth: imageRef.current.naturalWidth,
      naturalHeight: imageRef.current.naturalHeight,
    });
  }, [onImageMetricsChange]);

  // Toggle field labels and keep undo/redo history.
  const [showLabels, setShowLabels] = useState(true);
  const [history, setHistory] = useState<ROI[][]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [draggedItemIdx, setDraggedItemIdx] = useState<number | null>(null);

  const skipHistoryRecordRef = useRef(false);
  const lastRoisRef = useRef<ROI[]>([]);

  // Track ROI history when the page changes.
  useEffect(() => {
    setHistory([rois]);
    setHistoryIndex(0);
    lastRoisRef.current = rois;
  }, [currentIndex]);

  // Track ROI history when the page changes.
  useEffect(() => {
    if (skipHistoryRecordRef.current) {
      skipHistoryRecordRef.current = false;
      lastRoisRef.current = rois;
      return;
    }
    
    // Record only real ROI changes to avoid loops.
    if (rois.length > 0 && JSON.stringify(rois) !== JSON.stringify(lastRoisRef.current)) {
      const newHistory = history.slice(0, historyIndex + 1);
      setHistory([...newHistory, rois]);
      setHistoryIndex(newHistory.length);
      lastRoisRef.current = rois;
    }
  }, [rois, history, historyIndex]);

  const handleUndo = () => {
    if (historyIndex > 0) {
      const prevIndex = historyIndex - 1;
      skipHistoryRecordRef.current = true;
      setHistoryIndex(prevIndex);
      setRois(history[prevIndex]);
      setSelectedId(null);
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      const nextIndex = historyIndex + 1;
      skipHistoryRecordRef.current = true;
      setHistoryIndex(nextIndex);
      setRois(history[nextIndex]);
      setSelectedId(null);
    }
  };


  useEffect(() => {
    setSelectedId(null);
  }, [currentIndex]);

      // Delete selected ROI.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isInputActive = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');
      if (isInputActive) return;

      // Delete selected ROI.
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId !== null) {
          e.preventDefault();
          deleteROI(selectedId);
          setSelectedId(null);
        }
      }

      // Undo.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      }

      // Redo.
      if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')
      ) {
        e.preventDefault();
        handleRedo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedId, handleUndo, handleRedo, deleteROI]);


  useEffect(() => {
    if (imageRef.current && previewUrl) {
      imageRef.current.src = previewUrl;
      reportImageMetrics();
    }
  }, [previewUrl, currentIndex, reportImageMetrics]);

  useEffect(() => {
    if (!onImageMetricsChange) return;
    const handleResize = () => reportImageMetrics();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [onImageMetricsChange, reportImageMetrics]);

  useEffect(() => {
  if (!isLoading || !ocrProgress) {
    setDisplayProgress(0);
    return;
  }

  const target = Math.min(
    100,
    Math.round(
      (ocrProgress.currentPage / Math.max(ocrProgress.totalPages, 1)) * 100
    )
  );

  const timer = window.setInterval(() => {
    setDisplayProgress((prev) => {
      if (prev >= target) {
        window.clearInterval(timer);
        return target;
      }

      return Math.min(prev + 1, target);
    });
  }, 50);

  return () => window.clearInterval(timer);
}, [isLoading, ocrProgress?.currentPage, ocrProgress?.totalPages]);


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

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;
    if (activeTool === 'polygon' && activeDrawPoints.length >= 3) {
      e.preventDefault();
      e.stopPropagation();
      const bbox = getBoundingBoxOfPoints(activeDrawPoints);
      const newBox = {
        id: Date.now(),
        fieldName: `field_${rois.length + 1}`,
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height,
        pageIndex: currentIndex,
        type: 'text' as const,
        dataType: 'text' as const,
        extractionMethod: 'ocr_text' as const,
        points: activeDrawPoints
      };
      setRois(prev => [...prev, newBox]);
      setSelectedId(newBox.id);
      setActiveDrawPoints([]);
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current || !viewportRef.current) return;

    if (readOnly || activeTool === 'pan' || e.button === 1) {
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
    if (isTargetBox) return;

    e.preventDefault(); 
    e.stopPropagation();
    setSelectedId(null); 

    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / currentZoom;
    const y = (e.clientY - rect.top) / currentZoom;

    if (activeTool === 'quad' || activeTool === 'polygon') {
      const newPoint = { x, y };
      const updatedPoints = [...activeDrawPoints, newPoint];
      
      if (activeTool === 'quad') {
        if (updatedPoints.length === 4) {
          const bbox = getBoundingBoxOfPoints(updatedPoints);
          const newBox = {
            id: Date.now(),
            fieldName: `field_${rois.length + 1}`,
            x: bbox.x,
            y: bbox.y,
            width: bbox.width,
            height: bbox.height,
            pageIndex: currentIndex,
            type: 'text' as const,
            dataType: 'text' as const,
            extractionMethod: 'ocr_text' as const,
            points: updatedPoints
          };
          setRois(prev => [...prev, newBox]);
          setSelectedId(newBox.id);
          setActiveDrawPoints([]);
        } else {
          setActiveDrawPoints(updatedPoints);
        }
      } else {
        // polygon: click to add points
        if (updatedPoints.length >= 4) {
          const firstPoint = updatedPoints[0];
          const dist = Math.sqrt((x - firstPoint.x) ** 2 + (y - firstPoint.y) ** 2);
          if (dist < 12) { // 12px closure radius
            const finalPoints = updatedPoints.slice(0, -1);
            const bbox = getBoundingBoxOfPoints(finalPoints);
            const newBox = {
              id: Date.now(),
              fieldName: `field_${rois.length + 1}`,
              x: bbox.x,
              y: bbox.y,
              width: bbox.width,
              height: bbox.height,
              pageIndex: currentIndex,
              type: 'text' as const,
              dataType: 'text' as const,
              extractionMethod: 'ocr_text' as const,
              points: finalPoints
            };
            setRois(prev => [...prev, newBox]);
            setSelectedId(newBox.id);
            setActiveDrawPoints([]);
            return;
          }
        }
        setActiveDrawPoints(updatedPoints);
      }
      return;
    }

    if (activeTool === 'box') {
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
        pageIndex: currentIndex,
        ...roiTypePatch('text'),
      };
      setRois([...rois, newBox]);
      setSelectedId(newBox.id);
    } else {
      setSelectedId(null);
    }
    setDragBox(null);
    if (!readOnly) setActiveTool('box');
  };

  const updateROI = (id: number, fields: Partial<ROI>) => {
    setRois(prev => prev.map(roi => {
      if (roi.id !== id) return roi;
      
      let updatedPoints = roi.points ? [...roi.points] : undefined;
      
      if (roi.points && roi.points.length > 0) {
        const oldX = roi.x;
        const oldY = roi.y;
        const oldW = roi.width;
        const oldH = roi.height;
        
        const newX = fields.x !== undefined ? fields.x : oldX;
        const newY = fields.y !== undefined ? fields.y : oldY;
        const newW = fields.width !== undefined ? fields.width : oldW;
        const newH = fields.height !== undefined ? fields.height : oldH;
        
        const dx = newX - oldX;
        const dy = newY - oldY;
        const scaleX = oldW > 0 ? newW / oldW : 1;
        const scaleY = oldH > 0 ? newH / oldH : 1;
        
        updatedPoints = roi.points.map(p => {
          const relX = p.x - oldX;
          const relY = p.y - oldY;
          return {
            x: oldX + relX * scaleX + dx,
            y: oldY + relY * scaleY + dy
          };
        });
      }
      
      return { ...roi, ...fields, points: updatedPoints };
    }));
  };

  const moveROI = (index: number, direction: 'up' | 'down') => {
    const currentPageIndices = rois
      .map((roi, idx) => ({ roi, originalIdx: idx }))
      .filter(item => (item.roi.pageIndex !== undefined ? Number(item.roi.pageIndex) : 0) === currentIndex);

    if (direction === 'up' && index > 0) {
      const idxA = currentPageIndices[index].originalIdx;
      const idxB = currentPageIndices[index - 1].originalIdx;
      setRois(prev => {
        const nextRois = [...prev];
        const temp = nextRois[idxA];
        nextRois[idxA] = nextRois[idxB];
        nextRois[idxB] = temp;
        return nextRois;
      });
    } else if (direction === 'down' && index < currentPageIndices.length - 1) {
      const idxA = currentPageIndices[index].originalIdx;
      const idxB = currentPageIndices[index + 1].originalIdx;
      setRois(prev => {
        const nextRois = [...prev];
        const temp = nextRois[idxA];
        nextRois[idxA] = nextRois[idxB];
        nextRois[idxB] = temp;
        return nextRois;
      });
    }
  };

  // Handle drag-and-drop ordering in the right panel.
  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedItemIdx(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, hoverIndex: number) => {
    e.preventDefault();
    if (draggedItemIdx === null || draggedItemIdx === hoverIndex) return;

    const currentPageIndices = rois
      .map((roi, idx) => ({ roi, originalIdx: idx }))
      .filter(item => (item.roi.pageIndex !== undefined ? Number(item.roi.pageIndex) : 0) === currentIndex);

    const idxA = currentPageIndices[draggedItemIdx].originalIdx;
    const idxB = currentPageIndices[hoverIndex].originalIdx;

    setRois(prev => {
      const nextRois = [...prev];
      const temp = nextRois[idxA];
      nextRois[idxA] = nextRois[idxB];
      nextRois[idxB] = temp;
      return nextRois;
    });

    setDraggedItemIdx(hoverIndex);
  };

  const handleDragEnd = () => {
    setDraggedItemIdx(null);
  };

  const handleStyle = {
    width: "8px",
    height: "8px",
    background: "#ffffff",
    border: "1.5px solid #2563eb",
    borderRadius: "2px",
    boxShadow: "0 1px 2px rgba(0,0,0,0.2)"
  };


  const triggerOCRProcessing = () => {
    if (!imageRef.current) return;

    setDisplayProgress(0);
    setOcrDone(false);

    const scaleX = imageRef.current.naturalWidth / imageRef.current.clientWidth;
    const scaleY = imageRef.current.naturalHeight / imageRef.current.clientHeight;

    onRunOCR(scaleX, scaleY);
  };

  useEffect(() => {
  if (!isLoading) {
    if (ocrDone) {
      setDisplayProgress(100);
    }
    return;
  }

  const timer = window.setInterval(() => {
    setDisplayProgress((prev) => {
      if (prev < 70) return prev + 1;
      if (prev < 90) return prev + 0.4;
      if (prev < 95) return prev + 0.1;
      return prev;
    });
  }, 350);

  return () => window.clearInterval(timer);
}, [isLoading, ocrDone]);

  return (
    <div className={rootClassName}>
      
      {/* Step progress bar */}
      {!hideStepProgress && <div className="w-full bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3 w-full max-w-3xl mx-auto justify-between relative">
          <div className="flex items-center gap-2.5 z-10 relative bg-white pr-4">
            <div className="w-7 h-7 rounded-full bg-green-100 border border-green-300 text-green-600 font-bold text-xs flex items-center justify-center">✓</div>
            <div className="text-left">
              <p className="text-xs font-bold text-slate-500">เตรียมภาพ</p>
              <p className="text-[10px] text-slate-400 font-medium">ปรับภาพและครอปเอกสาร</p>
            </div>
          </div>
          <div className="absolute top-3.5 left-0 right-0 h-[2px] bg-slate-200 -z-0 hidden md:block"></div>
          <div className="flex items-center gap-2.5 z-10 relative bg-white px-4">
            <div className="w-7 h-7 rounded-full bg-blue-600 text-white font-bold text-xs flex items-center justify-center ring-4 ring-blue-100">2</div>
            <div className="text-left">
              <p className="text-xs font-bold text-slate-800">กำหนด ROI</p>
              <p className="text-[10px] text-slate-400 font-medium">ลากกรอบพื้นที่สำหรับ OCR</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 z-10 relative bg-white pl-4">
            <div className="w-7 h-7 rounded-full bg-white border-2 border-slate-300 text-slate-400 font-bold text-xs flex items-center justify-center">3</div>
            <div className="text-left">
              <p className="text-xs font-bold text-slate-400">ตรวจผล OCR</p>
              <p className="text-[10px] text-slate-400 font-medium">แก้ไขและยืนยันผลลัพธ์</p>
            </div>
          </div>
        </div>
      </div>}


      {/* Main canvas row */}
      <div className={`grid ${workspaceHeightClassName} ${hideRightPanel ? "grid-cols-[64px_minmax(0,1fr)]" : "grid-cols-[64px_minmax(0,1fr)_320px]"} gap-5 items-stretch`}>
        
        {/* Left toolbar */}
                <div className="flex h-full flex-col items-center gap-3 rounded-xl border border-slate-200 bg-white py-4 shadow-sm select-none overflow-y-auto">
          <button 
            type="button"
            onClick={() => { setActiveTool('pan'); setSelectedId(null); setActiveDrawPoints([]); }}
            className={`p-2.5 rounded-lg transition-all ${activeTool === 'pan' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-100 hover:text-indigo-600'}`}
            title="Hand Pan Tool (Hand)"
          >
            <Hand size={20} />
          </button>
          {!readOnly && (
            <>
              <button 
                type="button"
                onClick={() => { setActiveTool('box'); setSelectedId(null); setActiveDrawPoints([]); }}
                className={`p-2.5 rounded-lg transition-all ${activeTool === 'box' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-100 hover:text-indigo-600'}`}
                title="Standard Box Tool (Rectangle)"
              >
                <Square size={20} />
              </button>
              <button 
                type="button"
                onClick={() => { setActiveTool('quad'); setSelectedId(null); setActiveDrawPoints([]); }}
                className={`p-2.5 rounded-lg transition-all ${activeTool === 'quad' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-100 hover:text-indigo-600'}`}
                title="4-Corner Quad Tool (Tilted Text)"
              >
                <Grid size={20} />
              </button>
              <button 
                type="button"
                onClick={() => { setActiveTool('polygon'); setSelectedId(null); setActiveDrawPoints([]); }}
                className={`p-2.5 rounded-lg transition-all ${activeTool === 'polygon' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-100 hover:text-indigo-600'}`}
                title="Freeform Polygon Tool"
              >
                <PenTool size={20} />
              </button>
            </>
          )}

          {!readOnly && <div className="w-8 h-[1px] bg-slate-200 my-2"></div>}

          {/* Undo and redo buttons */}
          {!readOnly && (
            <>
              <button 
                type="button"
                onClick={handleUndo}
                disabled={historyIndex <= 0}
                className="p-2.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-indigo-600 disabled:opacity-20 transition-all"
                title="ย้อนกลับ (Ctrl+Z)"
              >
                <Undo2 size={20} />
              </button>
              <button 
                type="button"
                onClick={handleRedo}
                disabled={historyIndex >= history.length - 1}
                className="p-2.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-indigo-600 disabled:opacity-20 transition-all"
                title="ทำซ้ำ (Ctrl+Y)"
              >
                <Redo2 size={20} />
              </button>
            </>
          )}

          <div className="w-8 h-[1px] bg-slate-200 my-2"></div>

          {/* Toggle field labels */}
          <button 
            type="button"
            onClick={() => setShowLabels(prev => !prev)}
            className={`p-2.5 rounded-lg transition-all ${!showLabels ? 'bg-amber-100 text-amber-600 border border-amber-250 shadow-sm' : 'text-slate-500 hover:bg-slate-100 hover:text-indigo-600'}`}
            title={showLabels ? "ซ่อนชื่อฟิลด์บนเอกสาร" : "แสดงชื่อฟิลด์บนเอกสาร"}
          >
            {showLabels ? <Eye size={20} /> : <EyeOff size={20} />}
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
          
          {!readOnly && <button 
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
          </button>}

          {toolbarExtra}
        </div>

        {/* Center document canvas */}
        <div 
          ref={viewportRef} 
          className="min-w-0 bg-[#edf2f7] border border-slate-200 rounded-xl overflow-auto flex items-start justify-start p-6 shadow-inner h-full relative"
        >
          <div 
            ref={containerRef}
            className={`relative inline-block ${selectedId ? 'cursor-default' : (activeTool === 'box' || activeTool === 'quad' || activeTool === 'polygon') ? 'cursor-crosshair select-none' : isPanning ? 'cursor-grabbing' : 'cursor-grab'}`} 
            style={{ 
              transform: `scale(${currentZoom})`, 
              transformOrigin: "top left",
              transition: "transform 0.1s ease-out"
            }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onDoubleClick={handleDoubleClick}
          >
            <div className="relative w-[750px] h-auto bg-transparent">
              {previewUrl && (
                <img 
                  ref={imageRef}
                  src={previewUrl} 
                  alt="Workspace" 
                  draggable="false" 
                  onLoad={reportImageMetrics}
                  className="w-full h-auto block select-none pointer-events-none border border-slate-300 shadow-xl rounded bg-white"
                />
              )}
                  
              {isDrawing && dragBox && (
                <div 
                  className="absolute border border-dashed border-indigo-500 bg-indigo-500/10 pointer-events-none z-50" 
                  style={{ left: dragBox.x, top: dragBox.y, width: dragBox.w, height: dragBox.h }} 
                />
              )}

              {/* Temporary drawing overlay for Quad/Polygon */}
              {(activeTool === 'quad' || activeTool === 'polygon') && activeDrawPoints.length > 0 && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none z-50">
                  <polygon
                    points={activeDrawPoints.map(p => `${p.x},${p.y}`).join(' ')}
                    fill="rgba(99, 102, 241, 0.12)"
                    stroke="#4f46e5"
                    strokeWidth="1.5"
                    strokeDasharray="3,3"
                  />
                  {activeDrawPoints.map((p, idx) => (
                    <circle
                      key={idx}
                      cx={p.x}
                      cy={p.y}
                      r="4"
                      fill="#4f46e5"
                      stroke="white"
                      strokeWidth="1.2"
                    />
                  ))}
                </svg>
              )}
                          
              <div className="absolute inset-0 top-0 left-0 w-full h-full pointer-events-auto">
                {currentPageRois.map((roi) => {
                  const hasPoints = roi.points && roi.points.length > 0;
                  const selected = selectedId === roi.id;
                  const customRoiClassName = getRoiClassName?.(roi, selected, activeTool);
                  return (
                    <Rnd
                      key={roi.id}
                      size={{ width: roi.width, height: roi.height }}
                      position={{ x: roi.x, y: roi.y }}
                      onMouseDown={(e) => { e.stopPropagation(); setSelectedId(roi.id); }}
                      onDragStop={(e, d) => {
                        if (!readOnly) updateROI(roi.id, { x: d.x, y: d.y });
                      }}
                      onResizeStop={(e, dir, ref, delta, pos) => {
                        if (!readOnly) updateROI(roi.id, { width: parseInt(ref.style.width), height: parseInt(ref.style.height), ...pos });
                      }}
                      bounds="parent"
                      scale={currentZoom}
                      className={customRoiClassName || `rnd-box-item border transition-shadow ${
                        activeTool !== 'pan' && selectedId !== roi.id ? 'pointer-events-none' : 'pointer-events-auto'
                      } ${hasPoints ? 'border-transparent bg-transparent shadow-none' : (selectedId === roi.id ? "border-indigo-600 bg-indigo-600/10 shadow-md z-30 ring-2 ring-indigo-500/20" : "border-indigo-400/80 bg-indigo-50/5 hover:border-indigo-500 hover:bg-indigo-50/10 z-20")}`}
                      resizeHandleStyles={!readOnly && selectedId === roi.id ? { topLeft: handleStyle, topRight: handleStyle, bottomLeft: handleStyle, bottomRight: handleStyle, top: handleStyle, right: handleStyle, bottom: handleStyle, left: handleStyle } : {}}
                      enableResizing={!readOnly && selectedId === roi.id}
                      disableDragging={readOnly || activeTool === 'pan'}
                    >
                      <div className={`w-full h-full relative ${activeTool !== 'pan' ? 'pointer-events-none' : 'pointer-events-auto'}`}>
                        {/* SVG Polygon overlay for Quad/Polygon ROIs */}
                        {roi.points && roi.points.length > 0 && (
                          <svg className="absolute inset-0 w-full h-full pointer-events-none z-10 overflow-visible">
                            <polygon
                              points={roi.points.map(p => `${p.x - roi.x},${p.y - roi.y}`).join(' ')}
                              fill={selectedId === roi.id ? "rgba(79, 70, 229, 0.18)" : "rgba(99, 102, 241, 0.08)"}
                              stroke={selectedId === roi.id ? "#4f46e5" : "#818cf8"}
                              strokeWidth="2"
                              strokeDasharray={selectedId === roi.id ? "0" : "3,3"}
                            />
                          </svg>
                        )}

                        {showLabels && (
                          <span 
                            onMouseDown={(e) => { e.stopPropagation(); setSelectedId(roi.id); }}
                            className={getRoiLabelClassName?.(roi, selected) || `absolute -top-5 left-0 px-1.5 py-0.5 text-[9px] font-sans rounded shadow border flex items-center gap-1.5 pointer-events-auto cursor-pointer ${selectedId === roi.id ? "bg-indigo-600 border-indigo-600 text-white font-extrabold" : "bg-white border-indigo-200 text-indigo-700 font-bold"}`}
                          >
                            {renderTypeIcon(roi.type, 10)}
                            <span>{roi.fieldName || "(Unnamed)"}</span>
                          </span>
                        )}

                      {/* Floating Menu Popover */}
                      {!readOnly && selectedId === roi.id && (
                        <div 
                          className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-60 bg-white border border-slate-200 rounded-xl shadow-xl p-3 z-50 text-slate-800 flex flex-col gap-2 pointer-events-auto"
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <div className="flex flex-col gap-1">
                            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider text-left">Field Name</label>
                            <input
                              type="text"
                              value={roi.fieldName || ""}
                              onChange={(e) => updateROI(roi.id, { fieldName: e.target.value })}
                              placeholder="e.g. invoice_no"
                              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1 text-xs font-semibold focus:outline-none focus:border-indigo-500 text-slate-800 text-left"
                            />
                          </div>
                          
                          <div className="flex flex-col gap-1">
                            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider text-left">ROI Type</label>
                            <div className="grid grid-cols-3 gap-1">
                              <button
                                type="button"
                                onClick={() => updateROI(roi.id, roiTypePatch('text'))}
                                className={`py-1 rounded text-[10px] font-bold flex items-center justify-center gap-1.5 transition-all ${
                                  (roi.type || 'text') === 'text' 
                                    ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/20' 
                                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200/80 hover:text-slate-700'
                                }`}
                              >
                                <FileText size={10} /> Text
                              </button>
                              <button
                                type="button"
                                onClick={() => updateROI(roi.id, roiTypePatch('table'))}
                                className={`py-1 rounded text-[10px] font-bold flex items-center justify-center gap-1.5 transition-all ${
                                  roi.type === 'table' 
                                    ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/20' 
                                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200/80 hover:text-slate-700'
                                }`}
                              >
                                <Table size={10} /> Table
                              </button>
                              <button
                                type="button"
                                onClick={() => updateROI(roi.id, roiTypePatch('image'))}
                                className={`py-1 rounded text-[10px] font-bold flex items-center justify-center gap-1.5 transition-all ${
                                  roi.type === 'image' 
                                    ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/20' 
                                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200/80 hover:text-slate-700'
                                }`}
                              >
                                <ImageIcon size={10} /> Image
                              </button>
                            </div>
                          </div>

                          <div className="flex items-center justify-between border-t border-slate-100 pt-1.5 mt-0.5">
                            <span className="text-[8px] text-slate-400">ID: #{roi.id}</span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedId(null);
                              }}
                              className="px-2.5 py-0.5 bg-slate-100 hover:bg-slate-200 text-slate-650 rounded text-[9px] font-bold transition-colors border border-slate-200"
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

        {/* Right properties panel */}
        {!hideRightPanel && <div className="min-w-0 h-full overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-4">
          {rightPanelRenderer ? (
            rightPanelRenderer({ currentPageRois, selectedId, setSelectedId, updateROI, deleteROI, moveROI })
          ) : (
            <>
              <button
                type="button"
                onClick={onBackToAdjust}
                className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-sm"
              >
                <ArrowLeft size={14} /> กลับไปหน้าปรับภาพ
              </button>

              <div className="space-y-2 bg-slate-50 p-3 rounded-lg border border-slate-100">
                <h3 className="text-xs font-bold text-slate-500 tracking-wider uppercase">ฟิลด์ที่เลือก ({currentPageRois.length})</h3>
                <div className="space-y-1.5 max-h-[440px] overflow-y-auto pr-1">
                  {currentPageRois.map((roi, idx) => (
                    <div 
                      key={roi.id} 
                      onClick={() => setSelectedId(roi.id)} 
                      draggable={true}
                      onDragStart={(e) => handleDragStart(e, idx)}
                      onDragOver={(e) => handleDragOver(e, idx)}
                      onDragEnd={handleDragEnd}
                      className={`flex items-center justify-between p-2 rounded border text-xs cursor-grab active:cursor-grabbing select-none transition-all ${
                        roi.enabled === false
                          ? 'opacity-50 bg-slate-50 border-slate-200'
                          : draggedItemIdx === idx 
                          ? 'opacity-40 border-dashed border-indigo-400 bg-indigo-50/50' 
                          : (selectedId === roi.id 
                              ? "bg-indigo-50 border-indigo-300 text-slate-800 font-bold shadow-xs" 
                              : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50")
                      }`}
                    >
                      <div className="flex items-center gap-2 w-full mr-1.5 min-w-0">
                        <Move size={11} className="text-slate-400 shrink-0 cursor-grab" />
                        <input 
                          type="text" 
                          value={roi.fieldName} 
                          onChange={(e) => updateROI(roi.id, { fieldName: e.target.value })} 
                          className="bg-transparent border-b border-transparent focus:border-indigo-500 focus:outline-none text-[11px] text-slate-700 w-full min-w-0 cursor-text" 
                          onClick={(e) => e.stopPropagation()} 
                        />
                        <select
                          value={roi.type || 'text'}
                          onChange={(e) => updateROI(roi.id, roiTypePatch(e.target.value as 'text' | 'table' | 'image'))}
                          onClick={(e) => e.stopPropagation()}
                          className="text-[9.5px] font-bold bg-white text-slate-600 border border-slate-200 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer shrink-0 select-none"
                        >
                          <option value="text">Text</option>
                          <option value="table">Table</option>
                          <option value="image">Image</option>
                        </select>
                      </div>
                      <button 
                        type="button"
                        onClick={(e) => { e.stopPropagation(); deleteROI(roi.id); }} 
                        className="text-slate-400 hover:text-red-500 transition-colors p-1 ml-1 shrink-0"
                        title="ลบกล่อง"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>}
      </div>

      {/* Footer carousel and action buttons */}
      {!hideFooter && <div className="w-full bg-[#edf2f7] text-slate-800 border border-slate-200 rounded-2xl px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-4 shadow-sm select-none">
        <div className="flex items-center gap-4">
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">
            เอกสารในคิว: <span className="text-slate-800 text-sm ml-1 font-bold">{currentIndex + 1} / {imagesList.length} หน้า</span>
          </div>
          
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={currentIndex === 0 || isLoading}
              onClick={() => onIndexChange(currentIndex - 1)}
              className="p-2 bg-white text-slate-650 border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-30 disabled:hover:bg-white transition-all active:scale-95 flex items-center justify-center"
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
                      ? "border-blue-500 ring-2 ring-blue-500/50 scale-105" 
                      : "border-slate-250 opacity-60 hover:opacity-100"
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
              className="p-2 bg-white text-slate-650 border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-30 disabled:hover:bg-white transition-all active:scale-95 flex items-center justify-center"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
            </button>
          </div>
        </div>

        {!hideOcrActions && <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="flex flex-col gap-2 w-full sm:w-auto">
            <div className="flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto">
              <button 
                type="button"
                disabled={isLoading} 
                onClick={async () => {
                  setDisplayProgress(0);
                  setOcrDone(false);

                  await onRunFullPageOCR();

                  setOcrDone(true);
                }}
                className="w-full sm:w-auto px-6 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:text-slate-400 text-white rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all shadow-md shadow-indigo-900/10 active:scale-98"
              >
                <Cpu size={14} className={isLoading ? "animate-spin text-indigo-300" : "text-white"} />
                {isLoading ? "OCR Entire Document..." : "OCR Entire Document"}
              </button>

              <button 
                type="button"
                disabled={rois.length === 0 || isLoading} 
                onClick={triggerOCRProcessing} 
                className="w-full sm:w-auto px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:text-slate-400 text-white rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all shadow-md shadow-blue-900/10 active:scale-98"
              >
                <Cpu size={14} className={isLoading ? "animate-spin text-blue-300" : "text-white"} />
                {isLoading ? "OCR Selected ROI..." : "OCR Selected ROI"}
              </button>
            </div>
              {isLoading && ocrProgress && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[10px] font-bold text-slate-500">
                    <span>
                      Processing page {ocrProgress.currentPage} / {ocrProgress.totalPages}
                    </span>
                    <span>{Math.round(displayProgress)}%</span>
                  </div>

                  <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-blue-600 transition-all duration-200"
                      style={{ width: `${displayProgress}%` }}
                    />
                  </div>
                </div>
              )}
          </div>
        </div>}
      </div>}

    </div>
  );
}

