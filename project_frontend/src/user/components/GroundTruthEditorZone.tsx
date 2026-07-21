"use client";

import React, { useState, useRef, useMemo, useEffect } from 'react';
import { ArrowLeft, Save, ZoomIn, ZoomOut, Maximize2, CheckCircle, Edit3, ChevronLeft, ChevronRight, Table, Image as ImageIcon, FileText, Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { ROI, OCRResult } from '../../types/ocr';

const renderTypeIcon = (type?: 'text' | 'table' | 'image', size = 11) => {
  if (type === 'table') return <Table size={size} className="shrink-0 text-slate-400" />;
  if (type === 'image') return <ImageIcon size={size} className="shrink-0 text-slate-400" />;
  return <FileText size={size} className="shrink-0 text-slate-400" />;
};

type DisplayFieldType = 'text' | 'table' | 'image';

const getFieldTypeLabel = (type: DisplayFieldType) => {
  if (type === "table") return "ตาราง";
  if (type === "image") return "รูปภาพ";
  return "ข้อความ";
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

const getRawOcrText = (result: OCRResult & { pageIndex?: number }) =>
  result.originalText !== undefined ? result.originalText : result.extractedText;

const parseMarkdownTable = (value: string): string[][] | null => {
  const rows = value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.includes("|"))
    .map(line => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim()));

  if (rows.length < 2) return null;
  const withoutSeparator = rows.filter(row => !row.every(cell => /^:?-{3,}:?$/.test(cell)));
  return withoutSeparator.length >= 2 ? withoutSeparator : null;
};

const parsePlainTextTable = (value: string): string[][] | null => {
  const lines = value
    .split(/\r?\n/)
    .map(line => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);

  if (lines.length === 0) return null;

  const rows = lines.map(line => {
    const spacedColumns = line.split(/\s{2,}/).map(cell => cell.trim()).filter(Boolean);
    if (spacedColumns.length > 1) return spacedColumns;
    return line.split(/\s+/).map(cell => cell.trim()).filter(Boolean);
  });

  const maxColumns = Math.min(8, Math.max(...rows.map(row => row.length), 1));
  return rows.map(row => {
    if (row.length <= maxColumns) return [...row, ...Array(maxColumns - row.length).fill("")];
    return [...row.slice(0, maxColumns - 1), row.slice(maxColumns - 1).join(" ")];
  });
};

const parseJsonTable = (value: string): string[][] | null => {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every(row => Array.isArray(row))) {
      return parsed.map(row => row.map(cell => String(cell ?? "")));
    }
    if (Array.isArray(parsed) && parsed.every(row => row && typeof row === "object" && !Array.isArray(row))) {
      const keys = Array.from(new Set(parsed.flatMap(row => Object.keys(row))));
      return [keys, ...parsed.map(row => keys.map(key => String(row[key] ?? "")))];
    }
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.rows)) {
      const rows = parsed.rows;
      if (rows.every((row: unknown) => Array.isArray(row))) {
        return rows.map((row: unknown[]) => row.map(cell => String(cell ?? "")));
      }
    }
  } catch {
    return null;
  }
  return null;
};

const parseTableText = (value: string): string[][] | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\(?no\s+text\s+found\s+in\s+roi\)?$/i.test(trimmed)) return null;
  return parseJsonTable(trimmed) || parseMarkdownTable(trimmed) || parsePlainTextTable(trimmed);
};

const parseHtmlTable = (value?: string): string[][] | null => {
  if (!value || !value.toLowerCase().includes("<table")) return null;
  try {
    const doc = new DOMParser().parseFromString(value, "text/html");
    const rows = Array.from(doc.querySelectorAll("tr")).map((row) => {
      const cells: string[] = [];
      Array.from(row.querySelectorAll("th,td")).forEach((cell) => {
        const text = (cell.textContent || "").replace(/\s+/g, " ").trim();
        const span = Math.max(1, Number(cell.getAttribute("colspan") || 1));
        cells.push(text);
        for (let index = 1; index < span; index += 1) cells.push("");
      });
      return cells;
    });
    const usefulRows = rows.filter((row) => row.some((cell) => cell.trim()));
    return usefulRows.length > 0 ? usefulRows : rows.filter((row) => row.length > 0);
  } catch {
    return null;
  }
};

const normalizeTableRows = (rows?: unknown): string[][] | null => {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const normalized = rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => String(cell ?? "")));
  return normalized.length > 0 ? normalized : null;
};

const tableRowsToMarkdown = (rows: string[][]): string => {
  const cleanedRows = rows.map(row => row.map(cell => cell.trimEnd()));
  const maxColumns = Math.max(...cleanedRows.map(row => row.length), 1);
  const normalizedRows = cleanedRows.map(row => [...row, ...Array(maxColumns - row.length).fill("")]);
  const [header = [], ...bodyRows] = normalizedRows;
  const safeHeader = header.map((cell, index) => cell || `Column ${index + 1}`);
  const formatRow = (row: string[]) => `| ${row.map(cell => cell.replace(/\|/g, "/")).join(" | ")} |`;
  return [
    formatRow(safeHeader),
    formatRow(Array(maxColumns).fill("---")),
    ...bodyRows.map(formatRow),
  ].join("\n");
};

const tableRowsFromResult = (result: OCRResult & { pageIndex?: number }, value?: string): string[][] | null =>
  normalizeTableRows(result.tableRows) || parseHtmlTable(result.tableHtml) || parseTableText(value ?? result.extractedText ?? getRawOcrText(result));

const tableTextFromResult = (result: OCRResult & { pageIndex?: number }) => {
  const rows = tableRowsFromResult(result, result.originalText ?? result.extractedText);
  return rows ? tableRowsToMarkdown(rows) : getRawOcrText(result);
};

const TableResultPreview = ({ value, rows }: { value: string; rows?: string[][] | null }) => {
  const tableRows = rows || parseTableText(value);

  if (!tableRows) return <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-400">(ไม่พบข้อมูลตาราง)</div>;

  const [header, ...bodyRows] = tableRows;
  return (
    <div className="max-h-72 overflow-auto rounded-xl border border-slate-300 bg-white shadow-sm">
      <table className="min-w-full text-[11px] text-left border-collapse">
        <thead className="sticky top-0 bg-slate-100 text-slate-800">
          <tr>
            {header.map((cell, index) => (
              <th key={index} className="border border-slate-300 px-2.5 py-2 font-bold whitespace-nowrap bg-slate-100">
                {cell || `Column ${index + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-white even:bg-slate-50/70">
              {header.map((_, cellIndex) => (
                <td key={cellIndex} className="border border-slate-300 px-2.5 py-2 align-top text-slate-700 whitespace-pre-wrap">
                  {row[cellIndex] || ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const EditableTableResult = ({
  value,
  rows: sourceRows,
  onChange,
}: {
  value: string;
  rows?: string[][] | null;
  onChange: (nextValue: string, nextRows: string[][]) => void;
}) => {
  const parsedRows = sourceRows || parseTableText(value);
  const parsedRowsKey = JSON.stringify(parsedRows || []);
  const [localRows, setLocalRows] = useState<string[][]>(() => parsedRows || [["Column 1"], [""]]);

  useEffect(() => {
    setLocalRows(parsedRows || [["Column 1"], [""]]);
  }, [parsedRowsKey, value]);

  const commitRows = (rows: string[][]) => {
    const normalizedRows = rows.length > 0 ? rows : [["Column 1"], [""]];
    setLocalRows(normalizedRows);
    onChange(tableRowsToMarkdown(normalizedRows), normalizedRows);
  };

  const maxColumns = Math.max(...localRows.map(row => row.length), 1);
  const rows = localRows.map(row => [...row, ...Array(maxColumns - row.length).fill("")]);
  const [header, ...bodyRows] = rows;

  const updateCell = (rowIndex: number, cellIndex: number, nextValue: string) => {
    const nextRows = rows.map(row => [...row]);
    nextRows[rowIndex][cellIndex] = nextValue;
    commitRows(nextRows);
  };

  const addRow = () => {
    commitRows([...rows, Array(maxColumns).fill("")]);
  };

  const addColumn = () => {
    commitRows(rows.map((row, index) => [...row, index === 0 ? `Column ${maxColumns + 1}` : ""]));
  };

  const removeRow = (rowIndex: number) => {
    if (rows.length <= 2) return;
    commitRows(rows.filter((_, index) => index !== rowIndex));
  };

  const removeColumn = (cellIndex: number) => {
    if (maxColumns <= 1) return;
    commitRows(rows.map(row => row.filter((_, index) => index !== cellIndex)));
  };

  return (
    <div className="rounded-xl border border-slate-300 bg-white shadow-sm">
      <div className="flex flex-col gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">ตารางที่แก้ไขได้</p>
          <p className="mt-0.5 text-[10px] font-medium text-slate-400">แก้ไขข้อมูลในแต่ละช่องได้โดยตรง</p>
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={addRow}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-[10px] font-bold text-slate-600 hover:bg-slate-50"
          >
            <Plus size={12} /> เพิ่มแถว
          </button>
          <button
            type="button"
            onClick={addColumn}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-[10px] font-bold text-slate-600 hover:bg-slate-50"
          >
            <Plus size={12} /> เพิ่มคอลัมน์
          </button>
        </div>
      </div>

      <div className="max-h-80 overflow-auto">
        <table className="min-w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-slate-100">
            <tr>
              {header.map((cell, cellIndex) => (
                <th key={cellIndex} className="min-w-28 border border-slate-300 bg-slate-100 p-0 align-top">
                  <div className="flex items-center gap-1 p-1.5">
                    <input
                      value={cell}
                      onChange={(event) => updateCell(0, cellIndex, event.target.value)}
                      className="min-h-8 w-full rounded-md border border-transparent bg-white/70 px-2 py-1 text-xs font-black text-slate-800 outline-none focus:border-indigo-400 focus:bg-white"
                      placeholder={`Column ${cellIndex + 1}`}
                    />
                    <button
                      type="button"
                      onClick={() => removeColumn(cellIndex)}
                      disabled={maxColumns <= 1}
                      className="rounded-md p-1 text-slate-300 hover:bg-white hover:text-red-500 disabled:opacity-25"
                      title="ลบคอลัมน์"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </th>
              ))}
              <th className="w-10 border border-slate-300 bg-slate-100" />
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, bodyIndex) => {
              const rowIndex = bodyIndex + 1;
              return (
                <tr key={rowIndex} className="odd:bg-white even:bg-slate-50/70">
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="min-w-28 border border-slate-300 p-1.5 align-top">
                      <textarea
                        value={cell}
                        onChange={(event) => updateCell(rowIndex, cellIndex, event.target.value)}
                        className="min-h-9 w-full resize-y rounded-md border border-transparent bg-transparent px-2 py-1 text-xs font-medium leading-5 text-slate-800 outline-none focus:border-indigo-400 focus:bg-white"
                        rows={1}
                        spellCheck={false}
                        translate="no"
                      />
                    </td>
                  ))}
                  <td className="w-10 border border-slate-300 p-1 text-center align-middle">
                    <button
                      type="button"
                      onClick={() => removeRow(rowIndex)}
                      disabled={rows.length <= 2}
                      className="rounded-md p-1 text-slate-300 hover:bg-red-50 hover:text-red-500 disabled:opacity-25"
                      title="ลบแถว"
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};


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
      const rows = normalizeTableRows(item.tableRows);
      const tableMarkdown = rows ? tableRowsToMarkdown(rows) : "";
      const shouldUseTableMarkdown =
        tableMarkdown && (!item.extractedText.trim() || /^\(?no\s+text\s+found\s+in\s+roi\)?$/i.test(item.extractedText.trim()));

      if (item.originalText === undefined || shouldUseTableMarkdown) {
        changed = true;
        return {
          ...item,
          originalText: item.originalText ?? (tableMarkdown || item.extractedText),
          extractedText: shouldUseTableMarkdown ? tableMarkdown : item.extractedText,
          tableRows: rows || item.tableRows,
        };
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
  const resultsPanelRef = useRef<HTMLDivElement | null>(null);
  const textSectionRef = useRef<HTMLElement | null>(null);
  const tableSectionRef = useRef<HTMLElement | null>(null);
  const imageSectionRef = useRef<HTMLElement | null>(null);
  const fieldResultRefs = useRef<Map<number, HTMLDivElement | HTMLElement>>(new Map());


  const currentPageRois = useMemo(() => {
    return rois.filter(roi => (roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0) === currentImageIndex);
  }, [rois, currentImageIndex]);


  const currentPageOcrResults = useMemo(() => {
    return ocrResults.filter(res => (res.pageIndex !== undefined ? Number(res.pageIndex) : 0) === currentImageIndex);
  }, [ocrResults, currentImageIndex]);

  const getRoiForResult = (result: OCRResult & { pageIndex?: number }) => {
    return currentPageRois.find(roi => roi.id === result.roiId) || currentPageRois.find(roi => roi.fieldName === result.fieldName);
  };

  const currentPageResultGroups = useMemo(() => {
    const typedResults = currentPageOcrResults.map((res) => {
      const matchedRoi = currentPageRois.find(roi => roi.id === res.roiId) || currentPageRois.find(roi => roi.fieldName === res.fieldName);
      const fieldType = (matchedRoi?.type || res.type || "text") as DisplayFieldType;
      return { res, matchedRoi, fieldType };
    });

    return {
      text: typedResults.filter(item => item.fieldType === "text"),
      table: typedResults.filter(item => item.fieldType === "table"),
      image: typedResults.filter(item => item.fieldType === "image"),
    };
  }, [currentPageOcrResults, currentPageRois]);

  const editedFieldCount = useMemo(() => {
    return currentPageOcrResults.filter((res) => getRawOcrText(res) !== res.extractedText).length;
  }, [currentPageOcrResults]);

  const scrollInsideResultsPanel = (target: HTMLElement | null, block: "start" | "center" = "start") => {
    const container = resultsPanelRef.current;
    if (!container || !target) return;

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const relativeTop = targetRect.top - containerRect.top + container.scrollTop;
    const top =
      block === "center"
        ? relativeTop - Math.max(0, (container.clientHeight - targetRect.height) / 2)
        : relativeTop - 12;

    container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  };

  const scrollToResult = (resultId: number) => {
    setActiveFieldId(resultId);
    window.setTimeout(() => {
      scrollInsideResultsPanel(fieldResultRefs.current.get(resultId) || null, "center");
    }, 0);
  };

  const scrollToSection = (type: "all" | DisplayFieldType | "edited") => {
    if (type === "all") {
      const firstResult = currentPageOcrResults[0];
      if (firstResult) scrollToResult(firstResult.id);
      return;
    }

    if (type === "edited") {
      const firstEdited = currentPageOcrResults.find((res) => getRawOcrText(res) !== res.extractedText);
      if (firstEdited) scrollToResult(firstEdited.id);
      return;
    }

    const target =
      type === "text"
        ? textSectionRef.current
        : type === "table"
          ? tableSectionRef.current
          : imageSectionRef.current;
    scrollInsideResultsPanel(target, "start");
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
            <p className="text-xs font-semibold text-slate-400">เตรียมภาพ</p>
          </div>
          <div className="flex items-center gap-2.5 bg-white px-4 z-10">
            <div className="w-6 h-6 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-600 font-bold text-xs flex items-center justify-center">✓</div>
            <p className="text-xs font-semibold text-slate-400">กำหนด ROI</p>
          </div>
          <div className="flex items-center gap-2.5 bg-white pl-4 z-10">
            <div className="w-6 h-6 rounded-full bg-indigo-600 text-white font-bold text-xs flex items-center justify-center ring-4 ring-indigo-100">3</div>
            <p className="text-xs font-bold text-slate-800">ตรวจและแก้ไขผล OCR</p>
          </div>
        </div>
      </div>

      {/* Main editor layout */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 xl:h-[720px] items-stretch">
        

        <div className="xl:col-span-5 bg-[#edf2f7] border border-slate-200 rounded-xl overflow-hidden flex flex-col min-h-[620px] xl:min-h-0 xl:h-full relative shadow-md">
          {/* Header controls for left canvas */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-white border-b border-slate-200">
            <span className="text-xs font-black text-slate-600 uppercase tracking-wider">ภาพเอกสาร</span>
            <button
              type="button"
              onClick={() => setShowLabels(prev => !prev)}
              className={`p-1.5 rounded-lg border transition-all flex items-center gap-1.5 text-[10px] font-bold cursor-pointer ${
                !showLabels 
                  ? 'bg-amber-50 text-amber-600 border-amber-250 shadow-sm' 
                  : 'bg-slate-50 text-slate-500 hover:bg-slate-100 border-slate-200'
              }`}
              title={showLabels ? "ซ่อนชื่อ Field" : "แสดงชื่อ Field"}
            >
              {showLabels ? <Eye size={12} /> : <EyeOff size={12} />}
              <span>{showLabels ? "ซ่อนชื่อ" : "แสดงชื่อ"}</span>
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
                        onClick={() => scrollToResult(res.id)}
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
              <ArrowLeft size={14} /> กลับไปหน้า ROI
            </button>
            <h3 className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
              <CheckCircle size={15} className="text-indigo-600" /> ตรวจสอบและแก้ไขผล OCR
            </h3>
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                ผลลัพธ์ของหน้านี้
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

          <div ref={resultsPanelRef} className="overflow-y-auto flex-1 min-h-0 bg-slate-50/40 p-4">
            {currentPageOcrResults.length > 0 && (
              <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-5">
                <button
                  type="button"
                  onClick={() => scrollToSection("all")}
                  className="rounded-xl border border-slate-200 bg-white p-2.5 text-left transition-all hover:border-indigo-200 hover:bg-indigo-50/40 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                >
                  <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">ทั้งหมด</p>
                  <p className="mt-0.5 text-base font-black tabular-nums text-slate-900">{currentPageOcrResults.length}</p>
                </button>
                <button
                  type="button"
                  onClick={() => scrollToSection("text")}
                  disabled={currentPageResultGroups.text.length === 0}
                  className="rounded-xl border border-slate-200 bg-white p-2.5 text-left transition-all hover:border-indigo-200 hover:bg-indigo-50/40 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">ข้อความ</p>
                  <p className="mt-0.5 text-base font-black tabular-nums text-slate-900">{currentPageResultGroups.text.length}</p>
                </button>
                <button
                  type="button"
                  onClick={() => scrollToSection("table")}
                  disabled={currentPageResultGroups.table.length === 0}
                  className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-2.5 text-left transition-all hover:border-indigo-300 hover:bg-indigo-100/60 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <p className="text-[10px] font-black uppercase tracking-wider text-indigo-500">ตาราง</p>
                  <p className="mt-0.5 text-base font-black tabular-nums text-indigo-900">{currentPageResultGroups.table.length}</p>
                </button>
                <button
                  type="button"
                  onClick={() => scrollToSection("image")}
                  disabled={currentPageResultGroups.image.length === 0}
                  className="rounded-xl border border-sky-100 bg-sky-50/70 p-2.5 text-left transition-all hover:border-sky-300 hover:bg-sky-100/70 focus:outline-none focus:ring-2 focus:ring-sky-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <p className="text-[10px] font-black uppercase tracking-wider text-sky-600">รูปภาพ</p>
                  <p className="mt-0.5 text-base font-black tabular-nums text-sky-900">{currentPageResultGroups.image.length}</p>
                </button>
                <button
                  type="button"
                  onClick={() => scrollToSection("edited")}
                  disabled={editedFieldCount === 0}
                  className="rounded-xl border border-amber-100 bg-amber-50/70 p-2.5 text-left transition-all hover:border-amber-300 hover:bg-amber-100/70 focus:outline-none focus:ring-2 focus:ring-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <p className="text-[10px] font-black uppercase tracking-wider text-amber-600">แก้ไขแล้ว</p>
                  <p className="mt-0.5 text-base font-black tabular-nums text-amber-900">{editedFieldCount}</p>
                </button>
              </div>
            )}
            {currentPageOcrResults.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-white py-20 text-center text-slate-400 font-medium">
                ยังไม่มีผล OCR ในหน้านี้ <br />
                <span className="text-[11px] font-normal text-slate-400">กลับไปหน้า ROI แล้วเริ่มอ่านข้อมูลก่อน</span>
              </div>
            ) : (
              <div className="space-y-5">
                {currentPageResultGroups.text.length > 0 && (
                  <section ref={textSectionRef} className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden scroll-mt-4">
                    <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-white px-3.5 py-2.5">
                      <div className="flex items-center gap-2">
                        <FileText size={15} className="text-slate-500" />
                        <h4 className="text-xs font-black text-slate-800">ข้อความ</h4>
                      </div>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-500">
                        {currentPageResultGroups.text.length} รายการ
                      </span>
                    </div>

                    <div className="divide-y divide-slate-100">
                      {currentPageResultGroups.text.map(({ res, matchedRoi, fieldType }) => {
                        const isSelected = activeFieldId === res.id;
                        return (
                          <div
                            key={res.id}
                            ref={(el) => {
                              if (el) fieldResultRefs.current.set(res.id, el);
                              else fieldResultRefs.current.delete(res.id);
                            }}
                            onClick={() => setActiveFieldId(res.id)}
                            className={`grid min-w-0 grid-cols-1 gap-3 p-3 transition-colors xl:grid-cols-[minmax(125px,0.55fr)_minmax(0,1fr)_minmax(0,1fr)] ${
                              isSelected ? "bg-indigo-50/50 ring-1 ring-inset ring-indigo-100" : "hover:bg-slate-50"
                            }`}
                          >
                            <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
                              <div className="flex items-center gap-1 rounded border border-transparent px-1 transition-all focus-within:border-indigo-400 focus-within:bg-white">
                                <input
                                  type="text"
                                  value={res.fieldName}
                                  onFocus={() => setActiveFieldId(res.id)}
                                  onChange={(e) => setOcrResults(p => p.map(item => item.id === res.id ? { ...item, fieldName: e.target.value } : item))}
                                  className="w-full bg-transparent py-1 text-xs font-bold text-slate-800 focus:outline-none"
                                  placeholder="ชื่อข้อมูล..."
                                />
                                <Edit3 size={12} className="shrink-0 text-slate-300" />
                              </div>
                              <div className="mt-1.5 flex items-center gap-1.5 px-1 text-[9px] font-bold uppercase text-slate-400">
                                {renderTypeIcon(fieldType, 10)}
                                <span>ประเภท: {getFieldTypeLabel(fieldType)}</span>
                              </div>
                              <span className={`mt-2 inline-flex w-fit rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${res.confidence >= 0.8 ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                                ความมั่นใจ: {(res.confidence * 100).toFixed(1)}%
                              </span>
                            </div>

                            <div className="min-w-0">
                              <p className="mb-1.5 text-[10px] font-black uppercase tracking-wider text-slate-400">ข้อความจาก OCR</p>
                              <div
                                className="min-h-10 w-full max-w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium leading-relaxed text-slate-700 shadow-sm normal-case break-all"
                                style={{ textTransform: "none", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                                translate="no"
                              >
                                {getRawOcrText(res) !== "" ? getRawOcrText(res) : <span className="text-slate-400 italic">(ไม่พบข้อความ)</span>}
                              </div>
                            </div>

                            <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
                              <p className="mb-1.5 text-[10px] font-black uppercase tracking-wider text-slate-400">ข้อความที่แก้ไขได้</p>
                              <textarea
                                value={res.extractedText}
                                onFocus={() => setActiveFieldId(res.id)}
                                onInput={autoResizeTextarea}
                                autoCapitalize="off"
                                autoComplete="off"
                                autoCorrect="off"
                                spellCheck={false}
                                translate="no"
                                data-gramm="false"
                                data-gramm_editor="false"
                                data-enable-grammarly="false"
                                ref={(el) => {
                                  if (el) {
                                    el.style.height = "auto";
                                    el.style.height = `${el.scrollHeight}px`;
                                  }
                                }}
                                onChange={(e) => setOcrResults(p => p.map(item => item.id === res.id ? { ...item, extractedText: e.target.value } : item))}
                                className="min-h-10 w-full max-w-full resize-y overflow-auto rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium leading-relaxed text-slate-800 shadow-inner transition-all focus:border-indigo-500 focus:outline-none normal-case break-all"
                                style={{ textTransform: "none", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                                placeholder="แก้ไขข้อความ OCR..."
                                rows={1}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                {currentPageResultGroups.table.length > 0 && (
                  <section ref={tableSectionRef} className="rounded-2xl border border-indigo-200 bg-white shadow-sm overflow-hidden scroll-mt-4">
                    <div className="flex items-center justify-between gap-3 border-b border-indigo-100 bg-indigo-50/60 px-3.5 py-2.5">
                      <div className="flex items-center gap-2">
                        <Table size={15} className="text-indigo-600" />
                        <h4 className="text-xs font-black text-slate-900">ตาราง</h4>
                      </div>
                      <span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-bold text-indigo-600 ring-1 ring-indigo-100">
                        {currentPageResultGroups.table.length} รายการ
                      </span>
                    </div>

                    <div className="space-y-3 p-3">
                      {currentPageResultGroups.table.map(({ res, matchedRoi, fieldType }) => {
                        const isSelected = activeFieldId === res.id;
                        const rawTableRows = tableRowsFromResult(res, getRawOcrText(res));
                        const editedTableRows = parseTableText(res.extractedText) || rawTableRows;
                        const editedTableValue = res.extractedText || (editedTableRows ? tableRowsToMarkdown(editedTableRows) : getRawOcrText(res));
                        return (
                          <article
                            key={res.id}
                            ref={(el) => {
                              if (el) fieldResultRefs.current.set(res.id, el);
                              else fieldResultRefs.current.delete(res.id);
                            }}
                            onClick={() => setActiveFieldId(res.id)}
                            className={`rounded-xl border bg-white p-3 transition-colors ${
                              isSelected ? "border-indigo-300 bg-indigo-50/30 shadow-sm" : "border-slate-200 hover:border-indigo-200"
                            }`}
                          >
                            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                              <div onClick={(e) => e.stopPropagation()} className="min-w-0 flex-1">
                                <div className="flex max-w-sm items-center gap-1 rounded border border-transparent px-1 transition-all focus-within:border-indigo-400 focus-within:bg-white">
                                  <input
                                    type="text"
                                    value={res.fieldName}
                                    onFocus={() => setActiveFieldId(res.id)}
                                    onChange={(e) => setOcrResults(p => p.map(item => item.id === res.id ? { ...item, fieldName: e.target.value } : item))}
                                    className="w-full bg-transparent py-1 text-sm font-black text-slate-800 focus:outline-none"
                                    placeholder="ชื่อข้อมูล..."
                                  />
                                  <Edit3 size={12} className="shrink-0 text-slate-300" />
                                </div>
                                <div className="mt-1 flex items-center gap-1.5 px-1 text-[9px] font-bold uppercase text-slate-400">
                                  {renderTypeIcon(fieldType, 10)}
                                  <span>ประเภท: {getFieldTypeLabel(fieldType)}</span>
                                </div>
                              </div>
                              <span className={`inline-flex w-fit rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${res.confidence >= 0.8 ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                                ความมั่นใจ: {(res.confidence * 100).toFixed(1)}%
                              </span>
                            </div>

                            <div className="grid grid-cols-1 gap-4">
                              <div>
                                <p className="mb-2 text-[10px] font-black uppercase tracking-wider text-slate-400">ผลตารางจาก OCR</p>
                                <TableResultPreview value={tableTextFromResult(res)} rows={rawTableRows} />
                              </div>

                              <div onClick={(e) => e.stopPropagation()}>
                                <EditableTableResult
                                  value={editedTableValue}
                                  rows={editedTableRows}
                                  onChange={(nextValue, nextRows) =>
                                    setOcrResults(p => p.map(item => item.id === res.id ? { ...item, extractedText: nextValue, tableRows: nextRows } : item))
                                  }
                                />
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                )}

                {currentPageResultGroups.image.length > 0 && (
                  <section ref={imageSectionRef} className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden scroll-mt-4">
                    <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-white px-3.5 py-2.5">
                      <div className="flex items-center gap-2">
                        <ImageIcon size={15} className="text-slate-500" />
                        <h4 className="text-xs font-black text-slate-800">รูปภาพ</h4>
                      </div>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-500">
                        {currentPageResultGroups.image.length} รายการ
                      </span>
                    </div>

                    <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2">
                      {currentPageResultGroups.image.map(({ res, matchedRoi, fieldType }) => {
                        const isSelected = activeFieldId === res.id;
                        return (
                          <article
                            key={res.id}
                            ref={(el) => {
                              if (el) fieldResultRefs.current.set(res.id, el);
                              else fieldResultRefs.current.delete(res.id);
                            }}
                            onClick={() => setActiveFieldId(res.id)}
                            className={`rounded-xl border p-3 transition-colors ${
                              isSelected ? "border-indigo-300 bg-indigo-50/40" : "border-slate-200 bg-white hover:bg-slate-50"
                            }`}
                          >
                            <div onClick={(e) => e.stopPropagation()} className="mb-3">
                              <div className="flex items-center gap-1 rounded border border-transparent px-1 transition-all focus-within:border-indigo-400 focus-within:bg-white">
                                <input
                                  type="text"
                                  value={res.fieldName}
                                  onFocus={() => setActiveFieldId(res.id)}
                                  onChange={(e) => setOcrResults(p => p.map(item => item.id === res.id ? { ...item, fieldName: e.target.value } : item))}
                                  className="w-full bg-transparent py-1 text-xs font-bold text-slate-800 focus:outline-none"
                                  placeholder="ชื่อข้อมูล..."
                                />
                                <Edit3 size={12} className="shrink-0 text-slate-300" />
                              </div>
                              <div className="mt-1 flex items-center gap-1.5 px-1 text-[9px] font-bold uppercase text-slate-400">
                                {renderTypeIcon(fieldType, 10)}
                                <span>ประเภท: {getFieldTypeLabel(fieldType)}</span>
                              </div>
                            </div>

                            {matchedRoi ? (
                              <div className="w-fit rounded-xl border border-slate-200 bg-white p-2 shadow-inner">
                                <CroppedRoiPreview previewUrl={previewUrl} roi={matchedRoi} maxWidth={220} />
                              </div>
                            ) : (
                              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-xs font-bold text-slate-400">
                                ไม่มีภาพตัวอย่าง ROI
                              </div>
                            )}
                            <p className="mt-2 text-[10px] font-semibold text-slate-400">Field รูปภาพใช้สำหรับตัดภาพเท่านั้น ไม่มีข้อความ OCR</p>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>

          <div className="p-4 border-t bg-slate-50/50 flex gap-3 relative">
            <button 
              type="button"
              onClick={onApproveAndSave} 
              disabled={ocrResults.length === 0}
              className="flex-grow py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-indigo-600/10 flex items-center justify-center gap-2 disabled:bg-slate-300 disabled:text-slate-500 disabled:shadow-none"
            >
              <Save size={15} /> {ocrResults.length === 0 ? "ยังไม่มีผล OCR ให้บันทึก" : "บันทึกการเปลี่ยนแปลง"}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

