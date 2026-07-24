"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import AdjustZone from "../user/components/AdjustZone";
import WorkspaceZone from "../user/components/WorkspaceZone";
import MatchedTemplateWorkspaceZone from "../user/components/MatchedTemplateWorkspaceZone";
import GroundTruthEditorZone from "../user/components/GroundTruthEditorZone";
import TemplateRequestPanel from "../user/components/TemplateRequestPanel";
import { ROI, OCRResult, TemplateField } from "../types/ocr";
import {
  ADMIN_API_BASE_URL,
  detectTemplateDev,
  fetchTemplateBundle,
  type DetectionCandidate,
  type DetectionDevResult,
} from "../admin/adminApi";
import { ActionButton, InlineState } from "../shared/ui";

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
  cropCorners: { x: number; y: number }[] | null;
  isCropActive: boolean;
  isCropped: boolean;
  croppedLocalUrl: string | null;
}

interface TemplateDetectionNotice {
  title: string;
  message: string;
  detail?: string;
}

type NoticeTone = "success" | "warning" | "danger" | "info";
type ExportFormat = "word" | "excel" | "json" | "images";
type ExportContentOptions = {
  text: boolean;
  tables: boolean;
  images: boolean;
};
type ExportDisplayOptions = {
  showFieldNames: boolean;
  showDocumentTitle: boolean;
};

const USER_FLOW_STEPS = [
  {
    key: "upload",
    title: "อัปโหลดเอกสาร",
    description: "เลือกไฟล์ภาพหรือ PDF ครั้งละ 1 ไฟล์",
    note: "PDF หนึ่งไฟล์รองรับหลายหน้า ระบบจะแปลงเป็นภาพก่อนทำงาน",
  },
  {
    key: "adjust",
    title: "ตรวจขอบเขตภาพ",
    description: "ปรับกรอบให้ครอบเฉพาะตัวเอกสาร",
    note: "กรอบที่แม่นยำช่วยให้การค้นหา Template และ OCR ดีขึ้น",
  },
  {
    key: "studio",
    title: "เลือกข้อมูลที่ต้องอ่าน",
    description: "ใช้ ROI จาก Template หรือกำหนด ROI เอง",
    note: "เลือกเฉพาะ Field ที่ต้องการ เพื่อลดเวลาและลดข้อมูลเกินจำเป็น",
  },
  {
    key: "editor",
    title: "ตรวจผลและส่งออก",
    description: "แก้ไขผล OCR แล้วบันทึกก่อน Export",
    note: "ผลลัพธ์ที่ส่งออกจะใช้ค่าที่ผู้ใช้แก้ไขล่าสุด",
  },
] as const;

const USER_STEP_ACTIONS: Record<(typeof USER_FLOW_STEPS)[number]["key"], string[]> = {
  upload: [
    "คลิกพื้นที่อัปโหลดหรือวางไฟล์เอกสาร 1 ไฟล์ลงในช่องอัปโหลด",
    "ตรวจสอบว่าไฟล์เป็นภาพหรือ PDF ที่อ่านได้ชัดเจน",
    "หากเป็น PDF หลายหน้า ระบบจะเตรียมภาพให้ทีละหน้า",
  ],
  adjust: [
    "ตรวจกรอบเอกสารที่ระบบจับให้อัตโนมัติ",
    "ลากมุมหรือขอบกรอบให้ครอบเฉพาะตัวเอกสาร",
    "กดยืนยันเมื่อภาพตรงและพร้อมค้นหา Template",
  ],
  studio: [
    "เลือก Field หรือวาด ROI เฉพาะข้อมูลที่ต้องการอ่าน",
    "ใช้ Auto ROI เมื่อต้องการให้ระบบช่วยสร้างกรอบเริ่มต้น",
    "กดอ่านข้อมูลที่เลือกเพื่อเข้าสู่หน้าตรวจผล",
  ],
  editor: [
    "ตรวจข้อความ ตาราง และรูปภาพที่ OCR อ่านได้",
    "แก้ไขค่าที่ไม่ถูกต้อง แล้วกดบันทึกการเปลี่ยนแปลง",
    "กด Export แล้วเลือกรูปแบบไฟล์ที่ต้องการ",
  ],
};

const NoTemplateDetectionCard = ({ notice }: { notice: TemplateDetectionNotice }) => (
  <section className="rounded-2xl border border-amber-100 bg-amber-50 p-4">
    <div className="flex items-start gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-amber-600 shadow-sm ring-1 ring-amber-100">
        <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        </svg>
      </div>
      <div className="min-w-0">
        <h3 className="ui-label text-amber-800">ไม่พบ Template ที่ตรงกัน</h3>
        <p className="ui-card-title mt-1 text-amber-950">{notice.title}</p>
        <p className="ui-caption mt-1 break-words text-amber-700">{notice.message}</p>
        {notice.detail && (
          <div className="mt-3 rounded-xl border border-amber-100 bg-white/75 px-3 py-2">
            <p className="ui-caption break-words font-semibold text-amber-800">{notice.detail}</p>
            <p className="ui-caption mt-0.5 text-amber-700">ระบบเปิด Custom OCR ให้ใช้งานต่อ สามารถตีกรอบ ROI เองหรือใช้ Auto ROI ได้</p>
          </div>
        )}
      </div>
    </div>
  </section>
);

const UploadZone = dynamic(() => import("../user/components/UploadZone"), {
  ssr: false,
  loading: () => (
    <div className="w-full max-w-3xl mx-auto py-12 px-4 text-center text-slate-500 font-medium text-xs">
      กำลังเตรียมส่วนประกอบการอัปโหลด...
    </div>
  ),
});

const cropRoiToImage = (
  imgEl: HTMLImageElement,
  roi: { x: number; y: number; width: number; height: number; points?: { x: number; y: number }[] },
  scaleX: number,
  scaleY: number
): string | null => {
  if (!imgEl || !imgEl.complete || imgEl.naturalWidth === 0) return null;

  const realX = roi.x * scaleX;
  const realY = roi.y * scaleY;
  const realW = roi.width * scaleX;
  const realH = roi.height * scaleY;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(realW));
  canvas.height = Math.max(1, Math.round(realH));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

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
    imgEl,
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

  return canvas.toDataURL("image/jpeg", 0.95);
};

const dataUrlToFile = async (dataUrl: string, filename: string) => {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return new File([blob], filename, { type: blob.type || "image/jpeg" });
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
  if (!response.ok) throw new Error(`Unable to load extraction image: ${response.status}`);
  return blobToDataUrl(await response.blob());
};

const backendPreviewSrc = (value?: string | null) => {
  if (!value) return "";
  if (value.startsWith("data:") || value.startsWith("blob:") || value.startsWith("http")) return value;
  if (value.startsWith("/")) return `${ADMIN_API_BASE_URL}${value}`;
  return value;
};

const stableNumericId = (value: string) =>
  Math.abs(value.split("").reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7));

const loadImageElement = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const imageObj = new Image();
    if (!src.startsWith("data:") && !src.startsWith("blob:")) {
      imageObj.crossOrigin = "anonymous";
    }
    imageObj.onload = () => resolve(imageObj);
    imageObj.onerror = reject;
    imageObj.src = src;
  });

const findDetectionPageCandidate = (detection: DetectionDevResult | null | undefined, templateId: string, pageNumber: number) => {
  const page = detection?.pages?.find((item) => item.pageIndex === pageNumber);
  return (
    page?.candidates?.find((candidate) => candidate.templateId === templateId) ||
    (page?.bestCandidate?.templateId === templateId ? page.bestCandidate : null) ||
    null
  );
};

const candidateFieldRoi = (field: TemplateField, pageCandidate: DetectionCandidate | null) => {
  void pageCandidate;
  return { roi: field.roi, source: "template_roi" };
};

const templateFieldsToWorkspaceRois = async (
  fields: TemplateField[],
  imageList: string[],
  detection?: DetectionDevResult | null,
  templateId?: string
) => {
  const pageImages = await Promise.all(imageList.map((src) => loadImageElement(src).catch(() => null)));

  return fields
    .filter((field) => !field.useForVerification)
    .sort(
      (left, right) =>
        left.pageNumber - right.pageNumber ||
        (left.sortOrder ?? 0) - (right.sortOrder ?? 0) ||
        left.fieldName.localeCompare(right.fieldName)
    )
    .map((field) => {
      const pageCandidate = templateId ? findDetectionPageCandidate(detection, templateId, field.pageNumber) : null;
      const { roi, source } = candidateFieldRoi(field, pageCandidate);
      const pageIndex = Math.max(0, roi.pageNumber - 1);
      const pageImage = pageImages[pageIndex];
      const displayWidth = 750;
      const displayHeight = pageImage?.naturalWidth
        ? (pageImage.naturalHeight / pageImage.naturalWidth) * displayWidth
        : 1000;

      const type =
        field.extractionMethod === "ocr_table" || field.extractionMethod === "table_recognition_v2" || field.dataType === "table"
          ? "table"
          : field.extractionMethod === "extract_image" || field.dataType === "image"
            ? "image"
            : "text";

      return {
        id: stableNumericId(`template-field:${field.id}`),
        fieldName: field.displayLabel || field.fieldName,
        x: roi.xRatio * displayWidth,
        y: roi.yRatio * displayHeight,
        width: roi.widthRatio * displayWidth,
        height: roi.heightRatio * displayHeight,
        pageIndex,
        type,
        dataType: field.dataType || type,
        extractionMethod:
          field.extractionMethod === "ocr_table" ||
          field.extractionMethod === "table_recognition_v2" ||
          field.extractionMethod === "paddle_thai_ocr" ||
          field.extractionMethod === "extract_image"
            ? field.extractionMethod
            : field.dataType === "table"
              ? "table_recognition_v2"
              : "paddle_thai_ocr",
        role: "data_extraction",
        enabled: field.defaultSelected !== false,
        roiCoordinateSource: source,
      } satisfies ROI & { pageIndex?: number; roiCoordinateSource?: string };
    });
};

const buildTemplateCanvasImages = async (sourceImages: string[], detection: DetectionDevResult, templateId: string) => {
  const pages = detection.pages || [];
  return Promise.all(sourceImages.map(async (sourceImage, pageIndex) => {
    const page = pages.find((item) => item.pageIndex === pageIndex + 1);
    const pageCandidate =
      page?.candidates?.find((candidate) => candidate.templateId === templateId) ||
      (page?.bestCandidate?.templateId === templateId ? page.bestCandidate : null);
    const extractionSrc = backendPreviewSrc(pageCandidate?.alignedImagePreviewUrl || pageCandidate?.extractionImagePreviewUrl);
    if (!extractionSrc) return sourceImage;
    try {
      return await imageUrlToCanvasSafeSrc(extractionSrc);
    } catch (error) {
      console.warn("Unable to convert extraction image to canvas-safe data URL.", error);
      return sourceImage;
    }
  }));
};

const downloadTextFile = (filename: string, content: string, mimeType = "application/json") => {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const downloadBlobFile = (filename: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const safeFilename = (value: string) =>
  (value || "image")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "image";

const dataUrlToBytes = (dataUrl: string) => {
  const [, encoded = ""] = dataUrl.split(",", 2);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const writeUint16 = (target: number[], value: number) => {
  target.push(value & 0xff, (value >>> 8) & 0xff);
};

const writeUint32 = (target: number[], value: number) => {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
};

const createZipBlob = (files: { name: string; bytes: Uint8Array }[]) => {
  const encoder = new TextEncoder();
  const output: number[] = [];
  const centralDirectory: number[] = [];

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const checksum = crc32(file.bytes);
    const localHeaderOffset = output.length;

    writeUint32(output, 0x04034b50);
    writeUint16(output, 20);
    writeUint16(output, 0);
    writeUint16(output, 0);
    writeUint16(output, 0);
    writeUint16(output, 0);
    writeUint32(output, checksum);
    writeUint32(output, file.bytes.length);
    writeUint32(output, file.bytes.length);
    writeUint16(output, nameBytes.length);
    writeUint16(output, 0);
    output.push(...nameBytes, ...file.bytes);

    writeUint32(centralDirectory, 0x02014b50);
    writeUint16(centralDirectory, 20);
    writeUint16(centralDirectory, 20);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint32(centralDirectory, checksum);
    writeUint32(centralDirectory, file.bytes.length);
    writeUint32(centralDirectory, file.bytes.length);
    writeUint16(centralDirectory, nameBytes.length);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint32(centralDirectory, 0);
    writeUint32(centralDirectory, localHeaderOffset);
    centralDirectory.push(...nameBytes);
  });

  const centralDirectoryOffset = output.length;
  output.push(...centralDirectory);
  writeUint32(output, 0x06054b50);
  writeUint16(output, 0);
  writeUint16(output, 0);
  writeUint16(output, files.length);
  writeUint16(output, files.length);
  writeUint32(output, centralDirectory.length);
  writeUint32(output, centralDirectoryOffset);
  writeUint16(output, 0);
  return new Blob([new Uint8Array(output)], { type: "application/zip" });
};

const parseExportTable = (value: string): string[][] | null => {
  const trimmed = value.trim();
  if (!trimmed || /^\(?no\s+text\s+found\s+in\s+roi\)?$/i.test(trimmed)) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((row) => Array.isArray(row))) {
      return parsed.map((row) => row.map((cell) => String(cell ?? "")));
    }
    if (Array.isArray(parsed) && parsed.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
      const keys = Array.from(new Set(parsed.flatMap((row) => Object.keys(row))));
      return [keys, ...parsed.map((row) => keys.map((key) => String(row[key] ?? "")))];
    }
  } catch {
    // Continue with markdown/plain-text parsing.
  }

  const markdownRows = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("|"))
    .map((line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()))
    .filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell)));
  if (markdownRows.length >= 2) return markdownRows;

  const plainRows = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .map((line) => line.split(/\s{2,}/).map((cell) => cell.trim()).filter(Boolean));
  return plainRows.length >= 2 && plainRows.some((row) => row.length > 1) ? plainRows : null;
};

const tableRowsToObjects = (rows: string[][]) => {
  const [header = [], ...bodyRows] = rows;
  const headers = header.map((cell, index) => cell || `column_${index + 1}`);
  return bodyRows.map((row) =>
    Object.fromEntries(headers.map((headerName, index) => [headerName, row[index] ?? ""]))
  );
};

const tableRowsToMarkdown = (rows: string[][]) => {
  if (!rows.length) return "";
  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  const normalizedRows = rows.map((row) => [...row.map((cell) => String(cell ?? "")), ...Array(columnCount - row.length).fill("")]);
  const [header = [], ...bodyRows] = normalizedRows;
  const safeHeader = header.map((cell, index) => cell || `Column ${index + 1}`);
  const formatRow = (row: string[]) => `| ${row.map((cell) => cell.replace(/\|/g, "/")).join(" | ")} |`;
  return [formatRow(safeHeader), formatRow(Array(columnCount).fill("---")), ...bodyRows.map(formatRow)].join("\n");
};

const parseHtmlTableRows = (value?: string): string[][] | null => {
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

const assignExportField = (fields: Record<string, unknown>, name: string, value: unknown) => {
  if (!(name in fields)) {
    fields[name] = value;
    return;
  }
  fields[name] = Array.isArray(fields[name]) ? [...fields[name], value] : [fields[name], value];
};

export default function Home() {
  const [currentStep, setCurrentStep] = useState<"upload" | "adjust" | "studio" | "editor">("upload");
  const [imagesList, setImagesList] = useState<string[]>([]);
  const [originalImagesList, setOriginalImagesList] = useState<string[]>([]);

  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [pagesConfig, setPagesConfig] = useState<PageConfig[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [image, setImage] = useState<string | null>(null);

  const [rois, setRois] = useState<(ROI & { pageIndex?: number })[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [ocrResults, setOcrResults] = useState<(OCRResult & { pageIndex?: number })[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isTemplateRequestOpen, setIsTemplateRequestOpen] = useState<boolean>(false);
  const [ocrProgress, setOcrProgress] = useState<{ currentPage: number; totalPages: number; completedPages?: number } | null>(null);
  const [classificationStatus, setClassificationStatus] = useState<string>("");
  const [templateDetectionNotice, setTemplateDetectionNotice] = useState<TemplateDetectionNotice | null>(null);
  const [operationNotice, setOperationNotice] = useState<{ tone: NoticeTone; title: string; message: string } | null>(null);
  const [isTemplateDecisionOpen, setIsTemplateDecisionOpen] = useState<boolean>(false);
  const [templateDecisionStatus, setTemplateDecisionStatus] = useState<string>("");
  const [exportJson, setExportJson] = useState<string>("");
  const [exportText, setExportText] = useState<string>("");
  const [copyStatus, setCopyStatus] = useState<string>("");
  const [isGroundTruthSaved, setIsGroundTruthSaved] = useState<boolean>(false);
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState<string>("");
  const [saveNotice, setSaveNotice] = useState<{ tone: "success" | "error"; title: string; message: string } | null>(null);
  const [isExportWarningOpen, setIsExportWarningOpen] = useState<boolean>(false);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState<boolean>(false);
  const [pendingExportType, setPendingExportType] = useState<ExportFormat>("json");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("word");
  const [exportContent, setExportContent] = useState<ExportContentOptions>({ text: true, tables: true, images: true });
  const [exportOptions, setExportOptions] = useState<ExportDisplayOptions>({ showFieldNames: true, showDocumentTitle: true });
  const [excelExportMode, setExcelExportMode] = useState<"fields" | "tables" | "fields_tables">("fields_tables");
  const [textPreviewCopyStatus, setTextPreviewCopyStatus] = useState<string>("");
  const [matchedTemplate, setMatchedTemplate] = useState<{
    id: string;
    name: string;
    confidence?: number | null;
    decisionReason?: string | null;
    alignmentStatus?: string | null;
  } | null>(null);

  const handleGroundTruthResultsChange = (next: Parameters<typeof setOcrResults>[0]) => {
    setIsGroundTruthSaved(false);
    setOcrResults(next);
  };

  const handleUploadSuccess = (urls: string[]) => {
    setImagesList(urls);
    setOriginalImagesList([...urls]);
    setCurrentIndex(0);
    setPreviewUrl(urls[0] || "");
    setImage(urls[0] || null);
    setRois([]);
    setSelectedId(null);
    setOcrResults([]);
    setIsGroundTruthSaved(false);
    setLastDraftSavedAt("");
    setClassificationStatus("");
    setTemplateDetectionNotice(null);
    setOperationNotice(null);
    setIsTemplateDecisionOpen(false);
    setTemplateDecisionStatus("");
    setMatchedTemplate(null);
    setPagesConfig(
      urls.map(() => ({
        rotation: 0,
        brightness: 100,
        contrast: 100,
        sharpness: 0,
        perspectiveV: 0,
        perspectiveH: 0,
        flipH: false,
        flipV: false,
        cropBox: null,
        cropCorners: null,
        isCropActive: false,
        isCropped: false,
        croppedLocalUrl: null,
      }))
    );
    setCurrentStep("adjust");
  };

  const handleClearAndUploadNew = () => {
    setImagesList([]);
    setOriginalImagesList([]);
    setCurrentIndex(0);
    setPagesConfig([]);
    setPreviewUrl("");
    setImage(null);
    setRois([]);
    setSelectedId(null);
    setOcrResults([]);
    setIsGroundTruthSaved(false);
    setLastDraftSavedAt("");
    setClassificationStatus("");
    setTemplateDetectionNotice(null);
    setOperationNotice(null);
    setIsTemplateDecisionOpen(false);
    setTemplateDecisionStatus("");
    setMatchedTemplate(null);
    setTemplateDetectionNotice(null);
    setCurrentStep("upload");
  };

  const handleBatchConfirm = async (finalProcessedImages: string[]) => {
    setImagesList(finalProcessedImages);
    setPreviewUrl(finalProcessedImages[currentIndex] || finalProcessedImages[0] || "");
    setImage(finalProcessedImages[currentIndex] || finalProcessedImages[0] || null);
    setRois([]);
    setSelectedId(null);
    setOcrResults([]);
    setIsGroundTruthSaved(false);
    setLastDraftSavedAt("");
    setMatchedTemplate(null);
    setOperationNotice(null);
    setCurrentStep("studio");
    setIsTemplateDecisionOpen(true);
    setTemplateDecisionStatus("กำลังเตรียมภาพที่ยืนยันขอบเขตแล้ว");
    setClassificationStatus("กำลังแยกประเภทเอกสารจากภาพที่ยืนยันขอบเขตแล้ว...");

    try {
      const firstImage = finalProcessedImages[0];
      if (!firstImage) {
        setClassificationStatus("ไม่พบภาพสำหรับแยกประเภทเอกสาร ระบบเปิด Custom OCR ให้ใช้งานต่อ");
        setTemplateDetectionNotice({
          title: "ไม่พบภาพสำหรับแยกประเภทเอกสาร",
          message: "ระบบไม่สามารถเริ่มค้นหา Template ได้ เพราะไม่มีภาพที่ยืนยันขอบเขตแล้ว",
          detail: "โปรดกลับไปตรวจสอบภาพ หรือใช้งาน Custom OCR ต่อ",
        });
        return;
      }

      setTemplateDecisionStatus("กำลังค้นหา Template ที่ใกล้เคียงที่สุด");
      const file = await dataUrlToFile(firstImage, "confirmed-document.jpg");
      const detection = await detectTemplateDev(file);
      const templateId = detection.bestCandidate?.templateId;

      if (!detection.matched || !templateId) {
        setClassificationStatus("ไม่พบ Template ที่มั่นใจพอ ระบบเปิด Custom OCR ให้ใช้งานต่อ");
        setTemplateDetectionNotice({
          title: "ไม่พบ Template ที่มั่นใจพอ",
          message: detection.message || "คะแนนการจับคู่ยังไม่ผ่านเกณฑ์ที่กำหนด",
          detail: "ไม่โหลด ROI จาก Template ใด ๆ",
        });
        return;
      }

      setTemplateDecisionStatus("พบ Template แล้ว กำลังโหลดโครงสร้าง ROI");
      setTemplateDetectionNotice(null);
      const bundle = await fetchTemplateBundle(templateId);
      setTemplateDecisionStatus("กำลังจัดภาพให้ตรงกับ Template และเตรียมกรอบ OCR");
      const templateCanvasImages = await buildTemplateCanvasImages(finalProcessedImages, detection, templateId);
      setImagesList(templateCanvasImages);
      setPreviewUrl(templateCanvasImages[currentIndex] || templateCanvasImages[0] || "");
      setImage(templateCanvasImages[currentIndex] || templateCanvasImages[0] || null);

      const detectedRois = await templateFieldsToWorkspaceRois(bundle.fields, templateCanvasImages, detection, templateId);
      console.debug("[User OCR Workspace] ROI coordinate check", {
        templateId,
        candidate: detection.bestCandidate?.templateName,
        candidateCoordinateSpace: detection.bestCandidate?.roiCoordinateSpace,
        extractionImagePreviewUrl: detection.bestCandidate?.extractionImagePreviewUrl,
        alignedImagePreviewUrl: detection.bestCandidate?.alignedImagePreviewUrl,
        pageCount: templateCanvasImages.length,
        firstRoi: detectedRois[0]
          ? {
              fieldName: detectedRois[0].fieldName,
              pageIndex: detectedRois[0].pageIndex,
              x: detectedRois[0].x,
              y: detectedRois[0].y,
              width: detectedRois[0].width,
              height: detectedRois[0].height,
            }
          : null,
      });
      setMatchedTemplate({
        id: bundle.template.id,
        name: bundle.template.name,
        confidence: detection.bestCandidate?.finalScore ?? detection.bestCandidate?.score ?? null,
        decisionReason: detection.bestCandidate?.decisionReason ?? null,
        alignmentStatus: detection.bestCandidate?.alignmentStatus ?? null,
      });

      if (detectedRois.length === 0) {
        setClassificationStatus(`ตรวจพบ Template: ${bundle.template.name} แต่ยังไม่มี Extraction ROI ให้ใช้งาน`);
        return;
      }

      setRois(detectedRois);
      setSelectedId(detectedRois[0]?.id ?? null);
      setClassificationStatus(`ตรวจพบ Template: ${bundle.template.name} และโหลด ROI สำหรับ OCR แล้ว`);
    } catch (error) {
      console.warn("Document classification after boundary confirmation failed.", error);
      setClassificationStatus("ตรวจจับ Template ไม่สำเร็จ ระบบเปิด Custom OCR ให้ใช้งานต่อ");
      setTemplateDetectionNotice({
        title: "ตรวจจับ Template ไม่สำเร็จ",
        message: error instanceof Error ? error.message : "ระบบค้นหา Template ไม่สำเร็จ",
        detail: "ระบบเปิด Custom OCR ให้ใช้งานต่อ",
      });
    } finally {
      setIsTemplateDecisionOpen(false);
      setTemplateDecisionStatus("");
    }
  };

  const handleRunOCR = async () => {
    const activeRois = rois.filter((roi) => roi.enabled !== false);
    if (activeRois.length === 0) {
      setOperationNotice({
        tone: "warning",
        title: "ยังไม่มีข้อมูลให้ OCR",
        message: "กรุณาเลือกหรือเปิดใช้งาน ROI อย่างน้อย 1 กล่องก่อนอ่านข้อมูล",
      });
      return;
    }

    setIsLoading(true);
    setOcrResults([]);
    setIsGroundTruthSaved(false);
    setOperationNotice(null);
    setOcrProgress({ currentPage: 0, totalPages: imagesList.length, completedPages: 0 });

    try {
      const combinedResults: (OCRResult & { pageIndex?: number })[] = [];

      for (let pageIdx = 0; pageIdx < imagesList.length; pageIdx += 1) {
        setOcrProgress({ currentPage: pageIdx + 1, totalPages: imagesList.length, completedPages: pageIdx });
        const pageRois = rois.filter(
          (roi) => roi.enabled !== false && (roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0) === pageIdx
        );

        if (pageRois.length === 0) {
          setOcrProgress({ currentPage: pageIdx + 1, totalPages: imagesList.length, completedPages: pageIdx + 1 });
          continue;
        }

        const currentImgUrl = imagesList[pageIdx];
        const img = await loadImageElement(currentImgUrl);

        const renderedWidth = 750;
        const renderedHeight = (img.naturalHeight / img.naturalWidth) * renderedWidth;

        const scaleX = img.naturalWidth / renderedWidth;
        const scaleY = img.naturalHeight / renderedHeight;

        const roiPromises = pageRois.map(async (roi, rIdx) => {
          const croppedBase64 = cropRoiToImage(img, roi, scaleX, scaleY);
          if (!croppedBase64) return null;

          try {
            const response = await fetch("http://localhost:8000/api/ai/process", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                image: croppedBase64,
                rois: [
                  {
                    fieldName: roi.fieldName,
                    x: 0,
                    y: 0,
                    width: roi.width * scaleX,
                    height: roi.height * scaleY,
                    type: roi.type || "text",
                    extractionMethod:
                      roi.extractionMethod || (roi.type === "image" ? "extract_image" : roi.type === "table" ? "table_recognition_v2" : "paddle_thai_ocr"),
                  },
                ],
              }),
            });

            const aiData = await response.json();
            if (aiData.success && aiData.extracted_data.length > 0) {
              const resItem = aiData.extracted_data[0];
              const rawTableRows = Array.isArray(resItem.table_rows)
                ? resItem.table_rows.map((row: unknown) => (Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : []))
                : parseHtmlTableRows(typeof resItem.table_html === "string" ? resItem.table_html : undefined);
              const tableMarkdown = rawTableRows && rawTableRows.length > 0 ? tableRowsToMarkdown(rawTableRows) : "";
              const extractedText = String(resItem.text || tableMarkdown || "");
              return {
                id: Date.now() + pageIdx * 100000 + rIdx + Math.floor(Math.random() * 1000000),
                roiId: roi.id,
                fieldName: resItem.fieldName,
                bbox: [],
                extractedText,
                originalText: extractedText,
                confidence: resItem.confidence,
                saved_path: resItem.saved_path || "",
                pageIndex: pageIdx,
                type: (resItem.type as "text" | "table" | "image" | undefined) || roi.type || "text",
                dataType: roi.dataType || "string",
                role: roi.role || "data_extraction",
                weight: roi.weight !== undefined ? roi.weight : 1.0,
                points: roi.points,
                tableRows: rawTableRows || undefined,
                tableStructured:
                  resItem.table_structured && typeof resItem.table_structured === "object"
                    ? resItem.table_structured
                    : resItem.tableStructured && typeof resItem.tableStructured === "object"
                      ? resItem.tableStructured
                      : undefined,
                tableHtml: typeof resItem.table_html === "string" ? resItem.table_html : undefined,
                tableDebug: resItem.table_debug && typeof resItem.table_debug === "object" ? resItem.table_debug : undefined,
              };
            }
          } catch (innerErr) {
            console.error(`Error processing ROI ${roi.fieldName}:`, innerErr);
          }
          return null;
        });

        const roiResults = await Promise.all(roiPromises);
        combinedResults.push(...(roiResults.filter((r) => r !== null) as (OCRResult & { pageIndex?: number })[]));
        setOcrProgress({ currentPage: pageIdx + 1, totalPages: imagesList.length, completedPages: pageIdx + 1 });
      }

      if (combinedResults.length > 0) {
        setOcrResults(combinedResults);
        setIsGroundTruthSaved(false);
        setCurrentIndex(0);
        setCurrentStep("editor");
      } else {
        setOperationNotice({
          tone: "warning",
          title: "ไม่พบผล OCR",
          message: "ระบบอ่านข้อมูลจาก ROI ที่เลือกไม่ได้ กรุณาตรวจสอบตำแหน่ง ROI หรือสถานะ OCR engine",
        });
      }
    } catch (err) {
      console.error(err);
      setOperationNotice({
        tone: "danger",
        title: "อ่านข้อมูลไม่สำเร็จ",
        message: err instanceof Error ? err.message : "เกิดข้อผิดพลาดในการประมวลผล OCR",
      });
    } finally {
      setIsLoading(false);
      setOcrProgress(null);
    }
  };

  const handleRunFullPageOCR = async () => {
    setIsLoading(true);
    setOcrResults([]);
    setIsGroundTruthSaved(false);
    setOperationNotice(null);
    setOcrProgress({ currentPage: 0, totalPages: imagesList.length, completedPages: 0 });

    try {
      const allRoisFromOcr: (ROI & { pageIndex?: number })[] = [];
      const allOcrResults: (OCRResult & { pageIndex?: number })[] = [];

      for (let pageIdx = 0; pageIdx < imagesList.length; pageIdx += 1) {
        setOcrProgress({ currentPage: pageIdx + 1, totalPages: imagesList.length, completedPages: pageIdx });

        const currentImgUrl = imagesList[pageIdx];
        const img = await loadImageElement(currentImgUrl);

        const renderedWidth = 750;
        const renderedHeight = (img.naturalHeight / img.naturalWidth) * renderedWidth;
        const scaleX = img.naturalWidth / renderedWidth;
        const scaleY = img.naturalHeight / renderedHeight;

        const response = await fetch("http://localhost:8000/api/ai/process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image: currentImgUrl,
            rois: [],
          }),
        });

        const aiData = await response.json();
        if (!aiData.success || aiData.extracted_data.length === 0) {
          setOcrProgress({ currentPage: pageIdx + 1, totalPages: imagesList.length, completedPages: pageIdx + 1 });
          continue;
        }

        const generatedRoiIds = aiData.extracted_data.map((_: any, idx: number) =>
          Date.now() + pageIdx * 100000 + idx + Math.floor(Math.random() * 1000000)
        );

        const pageRoisFromOcr: (ROI & { pageIndex?: number })[] = aiData.extracted_data.map((item: any, idx: number) => {
          const rx = item.x / scaleX;
          const ry = item.y / scaleY;
          const rw = item.width / scaleX;
          const rh = item.height / scaleY;

          const pts = item.bbox
            ? item.bbox.map((pt: any) => ({
                x: pt[0] / scaleX,
                y: pt[1] / scaleY,
              }))
            : undefined;

          return {
            id: generatedRoiIds[idx],
            fieldName: item.fieldName || `line_${idx + 1}`,
            x: rx,
            y: ry,
            width: rw,
            height: rh,
            pageIndex: pageIdx,
            type: "text",
            dataType: "string",
            role: "data_extraction",
            points: pts,
          };
        });

        const pageOcrResults: (OCRResult & { pageIndex?: number })[] = aiData.extracted_data.map((item: any, idx: number) => {
          const pts = item.bbox
            ? item.bbox.map((pt: any) => ({
                x: pt[0] / scaleX,
                y: pt[1] / scaleY,
              }))
            : undefined;

          return {
            id: Date.now() + pageIdx * 100000 + idx + 1000000 + Math.floor(Math.random() * 1000000),
            roiId: generatedRoiIds[idx],
            fieldName: item.fieldName || `line_${idx + 1}`,
            bbox: [],
            extractedText: item.text,
            originalText: item.text,
            confidence: item.confidence,
            saved_path: item.saved_path || "",
            pageIndex: pageIdx,
            type: "text",
            dataType: "string",
            role: "data_extraction",
            points: pts,
          };
        });

        allRoisFromOcr.push(...pageRoisFromOcr);
        allOcrResults.push(...pageOcrResults);
        setOcrProgress({ currentPage: pageIdx + 1, totalPages: imagesList.length, completedPages: pageIdx + 1 });
      }

      if (allOcrResults.length > 0) {
        setRois((prev) => {
          const nonGeneratedRois = prev.filter((r) => !r.fieldName.startsWith("line_"));
          return [...nonGeneratedRois, ...allRoisFromOcr];
        });

        setOcrResults(allOcrResults);
        setIsGroundTruthSaved(false);
        setCurrentIndex(0);
        setCurrentStep("editor");
      } else {
        setOperationNotice({
          tone: "warning",
          title: "ไม่พบข้อความในเอกสาร",
          message: "ระบบไม่พบข้อความจากการอ่านทั้งหน้า กรุณาตรวจสอบคุณภาพภาพหรือกำหนด ROI เอง",
        });
      }
    } catch (err) {
      console.error(err);
      setOperationNotice({
        tone: "danger",
        title: "อ่านทั้งหน้าไม่สำเร็จ",
        message: err instanceof Error ? err.message : "เกิดข้อผิดพลาดในการรัน OCR อัตโนมัติทั้งเอกสาร",
      });
    } finally {
      setIsLoading(false);
      setOcrProgress(null);
    }
  };

  const handleApproveAndSave = async () => {
    try {
      const savedPayload = {
        saved_at: new Date().toISOString(),
        ...buildExportPayload(),
      };
      window.localStorage.setItem("ocr-studio:last-saved-result", JSON.stringify(savedPayload));
      setIsGroundTruthSaved(true);
      setSaveNotice({
        tone: "success",
        title: "บันทึกการเปลี่ยนแปลงแล้ว",
        message: `บันทึกผล OCR ของหน้า ${currentIndex + 1} ไว้ในเครื่องเรียบร้อยแล้ว สามารถส่งออก JSON หรือ Text ได้`,
      });
      return;
    } catch (error) {
      console.error(error);
      setSaveNotice({
        tone: "error",
        title: "บันทึกไม่สำเร็จ",
        message: error instanceof Error ? error.message : "เกิดข้อผิดพลาดในการบันทึกข้อมูล",
      });
      return;
    }
  };

  const getIncludedExportResults = (content: ExportContentOptions = exportContent) =>
    ocrResults.filter((result) => {
      const fieldType = getResultFieldType(result);
      if (fieldType === "table") return content.tables;
      if (fieldType === "image") return content.images;
      return content.text;
    });

  const buildExportPayload = (
    content: ExportContentOptions = exportContent,
    options: ExportDisplayOptions = exportOptions
  ) => {
    const pages = Array.from({ length: Math.max(imagesList.length, 1) }, (_, index) => ({
      page: index + 1,
      fields: options.showFieldNames ? ({} as Record<string, unknown>) : ([] as unknown[]),
    }));

    const addField = (page: { fields: Record<string, unknown> | unknown[] }, fieldName: string, value: unknown) => {
      if (Array.isArray(page.fields)) {
        page.fields.push(value);
        return;
      }
      assignExportField(page.fields, fieldName, value);
    };

    getIncludedExportResults(content).forEach((result) => {
      const matchedRoi = rois.find((roi) => roi.id === result.roiId) || rois.find((roi) => roi.fieldName === result.fieldName);
      const pageIndex = Math.max(0, result.pageIndex ?? matchedRoi?.pageIndex ?? 0);
      const page = pages[pageIndex] || pages[0];
      const fieldName = result.fieldName || matchedRoi?.fieldName || `field_${Object.keys(page.fields).length + 1}`;
      const fieldType = result.type || matchedRoi?.type || matchedRoi?.dataType || "text";
      const rawValue = result.extractedText || "";

      if (fieldType === "table") {
        if (result.tableStructured?.cells?.length) {
          addField(page, fieldName, {
            headerRowCount: result.tableStructured.headerRowCount ?? 1,
            colWidths: result.tableStructured.colWidths ?? [],
            cells: result.tableStructured.cells
              .filter((cell) => !cell.hidden)
              .map((cell) => ({
                row: cell.row,
                col: cell.col,
                text: cell.text,
                rowSpan: cell.rowSpan ?? 1,
                colSpan: cell.colSpan ?? 1,
                bbox: cell.bbox,
                ocrText: cell.ocrText ?? cell.text,
                groundTruth: cell.groundTruth ?? cell.text,
              })),
          });
          return;
        }
        const tableRows = Array.isArray(result.tableRows) && result.tableRows.length > 0 ? result.tableRows : parseExportTable(rawValue);
        addField(page, fieldName, tableRows ? { rows: tableRows } : rawValue);
        return;
      }

      if (fieldType === "image") {
        addField(page, fieldName, {
          type: "image",
          hasImage: true,
        });
        return;
      }

      addField(page, fieldName, rawValue);
    });

    return {
      ...(options.showDocumentTitle ? { template: matchedTemplate?.name ?? "OCR Export" } : {}),
      page_count: pages.length,
      pages,
    };
  };

  const getResultFieldType = (result: OCRResult & { pageIndex?: number }) => {
    const matchedRoi = rois.find((roi) => roi.id === result.roiId) || rois.find((roi) => roi.fieldName === result.fieldName);
    return result.type || matchedRoi?.type || matchedRoi?.dataType || "text";
  };

  const getStructuredTableForExport = (result: OCRResult & { pageIndex?: number }) => {
    if (result.tableStructured?.cells?.length) return result.tableStructured;
    const rows = Array.isArray(result.tableRows) && result.tableRows.length > 0 ? result.tableRows : parseExportTable(result.extractedText || "");
    if (!rows) return null;
    return {
      headerRowCount: 1,
      rows,
      cells: rows.flatMap((row, rowIndex) =>
        row.map((text, colIndex) => ({
          row: rowIndex,
          col: colIndex,
          text,
          rowSpan: 1,
          colSpan: 1,
          ocrText: text,
          groundTruth: text,
          hidden: false,
        }))
      ),
    };
  };

  const renderHtmlTable = (result: OCRResult & { pageIndex?: number }) => {
    const structured = getStructuredTableForExport(result);
    if (!structured?.cells?.length) return `<p>${escapeHtml(result.extractedText)}</p>`;
    const headerRows = structured.headerRowCount ?? 1;
    const cellsByPosition = new Map(structured.cells.map((cell) => [`${cell.row}:${cell.col}`, cell]));
    const visibleCells = structured.cells.filter((cell) => !cell.hidden);
    const rowCount = Math.max(...visibleCells.map((cell) => cell.row + (cell.rowSpan ?? 1)), structured.rows?.length || 1);
    const colCount = Math.max(...visibleCells.map((cell) => cell.col + (cell.colSpan ?? 1)), structured.rows?.[0]?.length || 1);

    const rowsHtml = Array.from({ length: rowCount }, (_, rowIndex) => {
      const cellsHtml = Array.from({ length: colCount }, (_, colIndex) => {
        const cell = cellsByPosition.get(`${rowIndex}:${colIndex}`);
        if (!cell || cell.hidden) return "";
        const tag = rowIndex < headerRows ? "th" : "td";
        const spanAttrs = `${(cell.rowSpan ?? 1) > 1 ? ` rowspan="${cell.rowSpan}"` : ""}${(cell.colSpan ?? 1) > 1 ? ` colspan="${cell.colSpan}"` : ""}`;
        return `<${tag}${spanAttrs}>${escapeHtml(cell.groundTruth ?? cell.text)}</${tag}>`;
      }).join("");
      return `<tr>${cellsHtml}</tr>`;
    }).join("");
    return `<table>${rowsHtml}</table>`;
  };

  const buildImageFieldPreviewList = (content: ExportContentOptions = exportContent) => {
    if (!content.images) return [];
    const imageResults = getIncludedExportResults(content).filter((result) => getResultFieldType(result) === "image");
    const usedNames = new Map<string, number>();
    return imageResults.map((result) => {
      const matchedRoi = rois.find((roi) => roi.id === result.roiId) || rois.find((roi) => roi.fieldName === result.fieldName);
      const baseName = safeFilename(result.fieldName || matchedRoi?.fieldName || "image");
      const nextCount = (usedNames.get(baseName) || 0) + 1;
      usedNames.set(baseName, nextCount);
      return {
        fieldName: result.fieldName || matchedRoi?.fieldName || "Image",
        filename: `${baseName}${nextCount > 1 ? `_${nextCount}` : ""}.jpg`,
        page: Math.max(0, result.pageIndex ?? matchedRoi?.pageIndex ?? 0) + 1,
      };
    });
  };

  const buildImageFieldCrops = async (content: ExportContentOptions = exportContent) => {
    if (!content.images) return [];
    const imageResults = getIncludedExportResults(content).filter((result) => getResultFieldType(result) === "image");
    const usedNames = new Map<string, number>();
    const crops: { fieldName: string; filename: string; dataUrl: string }[] = [];

    for (const result of imageResults) {
      const matchedRoi = rois.find((roi) => roi.id === result.roiId) || rois.find((roi) => roi.fieldName === result.fieldName);
      const pageIndex = Math.max(0, result.pageIndex ?? matchedRoi?.pageIndex ?? 0);
      const sourceImage = imagesList[pageIndex] || imagesList[0] || previewUrl;
      if (!matchedRoi || !sourceImage) continue;
      const img = await loadImageElement(sourceImage);
      const displayWidth = 750;
      const displayHeight = img.naturalWidth > 0 ? (img.naturalHeight / img.naturalWidth) * displayWidth : 1000;
      const cropped = cropRoiToImage(img, matchedRoi, img.naturalWidth / displayWidth, img.naturalHeight / displayHeight);
      if (!cropped) continue;
      const baseName = safeFilename(result.fieldName || matchedRoi.fieldName || "image");
      const nextCount = (usedNames.get(baseName) || 0) + 1;
      usedNames.set(baseName, nextCount);
      crops.push({
        fieldName: result.fieldName,
        filename: `${baseName}${nextCount > 1 ? `_${nextCount}` : ""}.jpg`,
        dataUrl: cropped,
      });
    }
    return crops;
  };

  const buildWordHtml = async (
    content: ExportContentOptions = exportContent,
    options: ExportDisplayOptions = exportOptions
  ) => {
    const imageCrops = await buildImageFieldCrops(content);
    const imageByField = new Map(imageCrops.map((crop) => [crop.fieldName, crop]));
    const body = getIncludedExportResults(content).map((result) => {
      const fieldType = getResultFieldType(result);
      const heading = options.showFieldNames ? `<h2>${escapeHtml(result.fieldName)}</h2>` : "";
      if (fieldType === "table") {
        return `${heading}${renderHtmlTable(result)}`;
      }
      if (fieldType === "image") {
        const crop = imageByField.get(result.fieldName);
        return `${heading}${crop ? `<p><img src="${crop.dataUrl}" alt="${escapeHtml(result.fieldName)}" style="max-width:520px;height:auto"></p>` : "<p>Image field</p>"}`;
      }
      return `${heading}<p>${escapeHtml(result.extractedText)}</p>`;
    }).join("");

    const title = options.showDocumentTitle ? `<h1>${escapeHtml(matchedTemplate?.name || "OCR Export")}</h1>` : "";
    return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;font-size:12pt}h1{font-size:18pt}h2{font-size:13pt;margin-top:18px}table{border-collapse:collapse;margin:8px 0 16px;width:100%}td,th{border:1px solid #999;padding:6px;vertical-align:top;white-space:pre-wrap}th{background:#f1f5f9}</style></head><body>${title}${body || "<p>No content selected</p>"}</body></html>`;
  };

  const buildExcelHtml = (
    content: ExportContentOptions = exportContent,
    options: ExportDisplayOptions = exportOptions
  ) => {
    const sections: string[] = [];
    if (options.showDocumentTitle) {
      sections.push(`<h1>${escapeHtml(matchedTemplate?.name || "OCR Export")}</h1>`);
    }
    if (content.text) {
      const rows = getIncludedExportResults(content)
        .filter((result) => getResultFieldType(result) !== "table" && getResultFieldType(result) !== "image")
        .map((result) =>
          options.showFieldNames
            ? `<tr><td>${escapeHtml(result.fieldName)}</td><td>${escapeHtml(result.extractedText)}</td></tr>`
            : `<tr><td>${escapeHtml(result.extractedText)}</td></tr>`
        )
        .join("");
      const header = options.showFieldNames ? "<tr><th>Field</th><th>Ground Truth</th></tr>" : "<tr><th>Ground Truth</th></tr>";
      sections.push(`<h3>Text</h3><table>${header}${rows || "<tr><td colspan=\"2\">No text fields</td></tr>"}</table>`);
    }
    if (content.tables) {
      getIncludedExportResults(content)
        .filter((result) => getResultFieldType(result) === "table")
        .forEach((result) => {
          sections.push(`${options.showFieldNames ? `<h3>${escapeHtml(result.fieldName)}</h3>` : ""}${renderHtmlTable(result)}`);
        });
    }
    if (content.images) {
      const rows = buildImageFieldPreviewList(content)
        .map((image) => `<tr>${options.showFieldNames ? `<td>${escapeHtml(image.fieldName)}</td>` : ""}<td>${escapeHtml(image.filename)}</td><td>${image.page}</td></tr>`)
        .join("");
      const header = `<tr>${options.showFieldNames ? "<th>Field</th>" : ""}<th>Filename</th><th>Page</th></tr>`;
      sections.push(`<h3>Images</h3><table>${header}${rows || "<tr><td colspan=\"3\">No image fields</td></tr>"}</table>`);
    }
    return `<!doctype html><html><head><meta charset="utf-8"><style>h1{font-size:18pt}h3{font-size:12pt;margin-top:16px}table{border-collapse:collapse;margin-bottom:18px}td,th{border:1px solid #999;padding:5px;vertical-align:top;white-space:pre-wrap}th{background:#e2e8f0}</style></head><body>${sections.join("") || "<p>No content selected</p>"}</body></html>`;
  };

  useEffect(() => {
    if (currentStep !== "editor" || ocrResults.length === 0) return;

    const timeoutId = window.setTimeout(() => {
      const savedAt = new Date().toISOString();
      window.localStorage.setItem(
        "ocr-studio:draft-result",
        JSON.stringify({
          draft_saved_at: savedAt,
          ...buildExportPayload(),
        })
      );
      setLastDraftSavedAt(savedAt);
    }, 600);

    return () => window.clearTimeout(timeoutId);
  }, [currentStep, ocrResults, rois, imagesList.length, matchedTemplate?.name]);

  const openExportJson = () => {
    setCopyStatus("");
    setExportText("");
    setExportJson(JSON.stringify(buildExportPayload(), null, 2));
  };

  const renderPlainValue = (value: unknown, indent = ""): string => {
    if (Array.isArray(value)) {
      if (value.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
        return value
          .map((row, index) => {
            const cells = Object.entries(row as Record<string, unknown>)
              .map(([key, cell]) => `${key}: ${String(cell ?? "")}`)
              .join(" | ");
            return `${indent}${index + 1}. ${cells}`;
          })
          .join("\n");
      }
      return value.map((item) => `${indent}- ${String(item ?? "")}`).join("\n");
    }

    if (value && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => `${indent}${key}: ${String(child ?? "")}`)
        .join("\n");
    }

    return `${indent}${String(value ?? "")}`;
  };

  const buildExportPlainText = () => {
    const payload = buildExportPayload();
    const lines: string[] = [];

    if (payload.template) {
      lines.push(`Template: ${payload.template}`);
    }
    lines.push(`Pages: ${payload.page_count}`);

    payload.pages.forEach((page) => {
      lines.push("");
      lines.push(`Page ${page.page}`);

      const fields = Object.entries(page.fields);
      if (fields.length === 0) {
        lines.push("- No OCR fields");
        return;
      }

      fields.forEach(([fieldName, value]) => {
        const rendered = renderPlainValue(value, "  ");
        if (rendered.includes("\n")) {
          lines.push(`${fieldName}:`);
          lines.push(rendered);
        } else {
          lines.push(`${fieldName}: ${rendered.trim()}`);
        }
      });
    });

    return lines.join("\n").trim();
  };

  const openExportText = () => {
    setCopyStatus("");
    setExportJson("");
    setExportText(buildExportPlainText());
  };

  const downloadWordExport = async () => {
    setCopyStatus("");
    setExportJson("");
    setExportText("");
    downloadTextFile(`ocr-export-${Date.now()}.doc`, await buildWordHtml(exportContent, exportOptions), "application/msword");
  };

  const downloadExcelExport = () => {
    setCopyStatus("");
    setExportJson("");
    setExportText("");
    downloadTextFile(`ocr-export-${Date.now()}.xls`, buildExcelHtml(exportContent, exportOptions), "application/vnd.ms-excel");
  };

  const downloadImageZipExport = async () => {
    setCopyStatus("");
    setExportJson("");
    setExportText("");
    const crops = await buildImageFieldCrops(exportContent);
    if (crops.length === 0) {
      setOperationNotice({
        tone: "warning",
        title: "ไม่มี Image Field",
        message: "ไม่พบ field ประเภทรูปภาพที่สามารถ crop เพื่อดาวน์โหลดได้",
      });
      return;
    }
    downloadBlobFile(
      `ocr-image-fields-${Date.now()}.zip`,
      createZipBlob(crops.map((crop) => ({ name: crop.filename, bytes: dataUrlToBytes(crop.dataUrl) })))
    );
  };

  const runExport = async (type: ExportFormat) => {
    if (type === "json") {
      const json = JSON.stringify(buildExportPayload(exportContent, exportOptions), null, 2);
      downloadTextFile(`ocr-export-${Date.now()}.json`, json);
      return;
    }
    if (type === "word") {
      await downloadWordExport();
      return;
    }
    if (type === "excel") {
      downloadExcelExport();
      return;
    }
    await downloadImageZipExport();
  };

  const requestExport = (type: ExportFormat) => {
    setPendingExportType(type);
    if (!isGroundTruthSaved) {
      setIsExportWarningOpen(true);
      return;
    }
    setIsExportMenuOpen(false);
    void runExport(type);
  };

  const handleOpenExportJson = () => {
    setExportFormat("json");
    setIsExportMenuOpen(true);
  };

  const handleOpenExportWord = () => {
    setExportFormat("word");
    setIsExportMenuOpen(true);
  };

  const handleOpenExportExcel = () => {
    setExportFormat("excel");
    setIsExportMenuOpen(true);
  };

  const handleOpenExportImages = () => {
    setExportFormat("images");
    setIsExportMenuOpen(true);
  };

  const continuePendingExport = () => {
    setIsExportWarningOpen(false);
    setIsExportMenuOpen(false);
    void runExport(pendingExportType);
  };

  const handleCopyExportJson = async () => {
    if (!exportJson) return;
    try {
      await navigator.clipboard.writeText(exportJson);
      setCopyStatus("Copied JSON to clipboard.");
    } catch {
      setCopyStatus("Copy failed. You can select and copy the JSON manually.");
    }
  };

  const handleCopyExportText = async () => {
    if (!exportText) return;
    try {
      await navigator.clipboard.writeText(exportText);
      setCopyStatus("Copied text to clipboard.");
    } catch {
      setCopyStatus("Copy failed. You can select and copy the text manually.");
    }
  };

  const currentFlowIndex = Math.max(0, USER_FLOW_STEPS.findIndex((step) => step.key === currentStep));
  const currentFlowStep = USER_FLOW_STEPS[currentFlowIndex] || USER_FLOW_STEPS[0];
  const completedStepCount = currentFlowIndex;
  const exportFormats: { key: ExportFormat; label: string }[] = [
    { key: "word", label: "Word" },
    { key: "excel", label: "Excel" },
    { key: "json", label: "JSON" },
    { key: "images", label: "Images" },
  ];
  const exportPreviewJson = JSON.stringify(buildExportPayload(exportContent, exportOptions), null, 2);
  const exportPreviewImages = buildImageFieldPreviewList(exportContent);
  const exportPreviewResults = getIncludedExportResults(exportContent);
  const textPreviewItems = useMemo(() => {
    return ocrResults
      .filter((result) => (result.pageIndex !== undefined ? Number(result.pageIndex) : 0) === currentIndex)
      .filter((result) => getResultFieldType(result) !== "table" && getResultFieldType(result) !== "image")
      .map((result) => ({
        id: result.id,
        key: result.fieldName?.trim() || `field_${result.id}`,
        value: result.extractedText || "",
      }));
  }, [ocrResults, currentIndex, rois]);
  const textPreviewCopyText = useMemo(() => {
    return textPreviewItems.map((item) => `${item.key}: ${item.value || "-"}`).join("\n");
  }, [textPreviewItems]);

  const handleCopyTextPreview = async () => {
    if (!textPreviewCopyText) return;
    try {
      await navigator.clipboard.writeText(textPreviewCopyText);
      setTextPreviewCopyStatus("คัดลอกแล้ว");
    } catch {
      setTextPreviewCopyStatus("คัดลอกไม่สำเร็จ");
    }
    window.setTimeout(() => setTextPreviewCopyStatus(""), 1800);
  };

  const toggleExportContent = (key: keyof ExportContentOptions) => {
    setExportContent((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleExportOption = (key: keyof ExportDisplayOptions) => {
    setExportOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const renderExportPreview = () => {
    if (exportFormat === "json") {
      return (
        <pre className="max-h-[46vh] overflow-auto rounded-xl bg-slate-950 p-4 text-xs leading-relaxed text-slate-100">
          {exportPreviewJson}
        </pre>
      );
    }

    if (exportFormat === "images") {
      return (
        <div className="max-h-[46vh] overflow-auto rounded-xl border border-slate-200 bg-white">
          {exportPreviewImages.length === 0 ? (
            <p className="p-4 text-xs font-semibold text-slate-500">ไม่มีรูปภาพที่จะอยู่ใน ZIP</p>
          ) : (
            exportPreviewImages.map((image) => (
              <div key={`${image.filename}-${image.page}`} className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0">
                <div className="min-w-0">
                  <p className="truncate text-xs font-black text-slate-900">{image.filename}</p>
                  {exportOptions.showFieldNames && <p className="mt-0.5 truncate text-[11px] font-semibold text-slate-500">{image.fieldName}</p>}
                </div>
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black text-slate-500">หน้า {image.page}</span>
              </div>
            ))
          )}
        </div>
      );
    }

    if (exportFormat === "excel") {
      const textCount = exportPreviewResults.filter((result) => getResultFieldType(result) !== "table" && getResultFieldType(result) !== "image").length;
      const tableResults = exportPreviewResults.filter((result) => getResultFieldType(result) === "table");
      return (
        <div className="max-h-[46vh] space-y-3 overflow-auto rounded-xl border border-slate-200 bg-white p-4">
          {exportOptions.showDocumentTitle && <h3 className="text-sm font-black text-slate-950">{matchedTemplate?.name || "OCR Export"}</h3>}
          {exportContent.text && (
            <div className="rounded-lg border border-slate-200">
              <div className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs font-black text-slate-700">Sheet: Text Fields</div>
              <p className="px-3 py-2 text-xs font-semibold text-slate-500">{textCount} rows</p>
            </div>
          )}
          {exportContent.tables && tableResults.map((result) => (
            <div key={result.roiId || result.fieldName} className="rounded-lg border border-slate-200">
              <div className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs font-black text-slate-700">
                Sheet: {exportOptions.showFieldNames ? result.fieldName : "Table"}
              </div>
              <div className="overflow-auto p-3" dangerouslySetInnerHTML={{ __html: renderHtmlTable(result) }} />
            </div>
          ))}
          {exportContent.images && (
            <div className="rounded-lg border border-slate-200">
              <div className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs font-black text-slate-700">Sheet: Images</div>
              <p className="px-3 py-2 text-xs font-semibold text-slate-500">{exportPreviewImages.length} image rows</p>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="max-h-[46vh] overflow-auto rounded-xl border border-slate-200 bg-white p-5">
        {exportOptions.showDocumentTitle && <h3 className="text-lg font-black text-slate-950">{matchedTemplate?.name || "OCR Export"}</h3>}
        <div className="mt-4 space-y-4">
          {exportPreviewResults.length === 0 ? (
            <p className="text-sm font-semibold text-slate-500">ไม่มีเนื้อหาที่เลือกสำหรับ Export</p>
          ) : (
            exportPreviewResults.map((result) => {
              const fieldType = getResultFieldType(result);
              return (
                <section key={result.roiId || result.fieldName} className="border-b border-slate-100 pb-4 last:border-b-0">
                  {exportOptions.showFieldNames && <h4 className="text-xs font-black uppercase tracking-wide text-slate-500">{result.fieldName}</h4>}
                  {fieldType === "table" ? (
                    <div className="mt-2 overflow-auto" dangerouslySetInnerHTML={{ __html: renderHtmlTable(result) }} />
                  ) : fieldType === "image" ? (
                    <p className="mt-2 text-sm font-semibold text-slate-600">Image crop จะถูกใส่ในเอกสาร Word</p>
                  ) : (
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{result.extractedText || "-"}</p>
                  )}
                </section>
              );
            })
          )}
        </div>
      </div>
    );
  };

  const renderUserWorkflowGuide = () => (
    <section className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
      <div className="grid gap-2 lg:grid-cols-[minmax(180px,260px)_1fr] lg:items-center">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-wide text-blue-600">ขั้นตอนปัจจุบัน</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <h2 className="text-sm font-black text-slate-950">{currentFlowStep.title}</h2>
            <span className="hidden text-xs font-semibold text-slate-500 sm:inline">{currentFlowStep.description}</span>
          </div>
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-1 sm:grid-cols-4">
          {USER_FLOW_STEPS.map((step, index) => {
            const active = index === currentFlowIndex;
            const completed = index < currentFlowIndex;
            return (
              <div
                key={step.key}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
                  active
                    ? "border-blue-300 bg-blue-50 text-blue-950"
                    : completed
                      ? "border-emerald-200 bg-emerald-50 text-emerald-950"
                      : "border-slate-200 bg-slate-50 text-slate-500"
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-black ${
                    active
                      ? "bg-blue-600 text-white ring-4 ring-blue-100"
                      : completed
                        ? "bg-emerald-600 text-white"
                        : "bg-white text-slate-400 ring-1 ring-slate-200"
                  }`}
                >
                  {completed ? "✓" : index + 1}
                </span>
                <span className="truncate text-[11px] font-black leading-tight">{step.title}</span>
              </div>
            );
          })}
        </div>
      </div>
      <p className="mt-2 hidden border-t border-slate-100 pt-2 text-xs font-semibold leading-relaxed text-slate-500 md:block">
        หมายเหตุ: {USER_STEP_ACTIONS[currentFlowStep.key][0]}
      </p>
    </section>
  );
  const getUserFlowStatus = (): { tone: NoticeTone; title: string; message: string } => {
    if (currentStep === "upload") {
      return {
        tone: "info",
        title: "เริ่มงานเอกสาร",
        message: "อัปโหลดรูปภาพหรือ PDF เพื่อเริ่มตรวจขอบเขตเอกสาร",
      };
    }

    if (currentStep === "adjust") {
      return {
        tone: "info",
        title: "ตรวจขอบเขตเอกสาร",
        message: "ปรับกรอบให้ครอบเฉพาะเอกสาร จากนั้นยืนยันเพื่อค้นหา Template และโหลด ROI",
      };
    }

    if (currentStep === "studio") {
      if (isLoading) {
        return {
          tone: "info",
          title: "กำลังอ่านข้อมูล",
          message: ocrProgress
            ? `กำลังประมวลผลหน้า ${ocrProgress.currentPage}/${ocrProgress.totalPages}`
            : "ระบบกำลังอ่านข้อมูลจาก ROI ที่เลือก",
        };
      }

      if (matchedTemplate) {
        return {
          tone: "success",
          title: "พร้อมอ่านข้อมูลจาก Template",
          message: `พบ Template "${matchedTemplate.name}" แล้ว เลือก Field ที่ต้องการและกดอ่านข้อมูลที่เลือก`,
        };
      }

      if (templateDetectionNotice) {
        return {
          tone: "warning",
          title: "ใช้ Custom OCR",
          message: "ระบบไม่พบ Template ที่มั่นใจพอ สามารถกำหนด ROI เองและอ่านข้อมูลต่อได้",
        };
      }

      return {
        tone: "info",
        title: "กำหนด ROI",
        message: "เลือกหรือวาด ROI สำหรับข้อมูลที่ต้องการ OCR",
      };
    }

    return {
      tone: isGroundTruthSaved ? "success" : "warning",
      title: isGroundTruthSaved ? "ผล OCR ถูกบันทึกแล้ว" : "ตรวจสอบผล OCR ก่อนส่งออก",
      message: isGroundTruthSaved
        ? "สามารถส่งออก JSON หรือ Text ได้"
        : lastDraftSavedAt
          ? `ระบบบันทึก draft อัตโนมัติไว้แล้ว ${new Date(lastDraftSavedAt).toLocaleTimeString("th-TH")}`
          : "แก้ไขผล OCR ให้เรียบร้อย จากนั้นกดบันทึกการเปลี่ยนแปลง",
    };
  };

  const userFlowStatus = getUserFlowStatus();
  const exportPreviewPayload = exportJson || exportText ? buildExportPayload() : null;
  const exportFieldCount =
    exportPreviewPayload?.pages.reduce((sum, page) => sum + Object.keys(page.fields).length, 0) ?? 0;

  return (
    <main className="min-h-screen bg-slate-50 py-6 select-none">
      <div className="container mx-auto px-6 max-w-7xl space-y-5">
        <div className="rounded-2xl border border-slate-200 bg-white px-6 py-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="ui-caption font-semibold text-blue-600">พื้นที่ทำงานเอกสารอัจฉริยะ</p>
              <h1 className="ui-page-title mt-1 text-slate-950">ระบบอ่านเอกสารด้วย OCR</h1>
              <p className="ui-body mt-1 text-slate-500">
                อัปโหลดเอกสาร ตรวจขอบเขต ค้นหา Template เลือก Field ที่ต้องการอ่าน และตรวจสอบผล OCR ก่อนนำออกใช้งาน
                {imagesList.length > 0 && ` หน้า ${currentIndex + 1}/${imagesList.length}`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ActionButton href="/admin">ผู้ดูแลระบบ</ActionButton>
              {imagesList.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearAndUploadNew}
                  className="ui-button-text rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-slate-700 transition-colors hover:bg-slate-50"
                >
                  เอกสารใหม่
                </button>
              )}
            </div>
          </div>
        </div>

        {currentStep !== "upload" && renderUserWorkflowGuide()}

        <InlineState tone={userFlowStatus.tone} title={userFlowStatus.title} message={userFlowStatus.message} />
        {operationNotice && (
          <InlineState tone={operationNotice.tone} title={operationNotice.title} message={operationNotice.message} />
        )}

        <div className="hidden text-center py-2">
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">
            Intelligent OCR Portal
          </h1>
        </div>

        <div className="hidden bg-white border border-slate-200/80 rounded-2xl px-6 py-4 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-2.5">
            <div className="w-2.5 h-2.5 rounded-full bg-indigo-600 shadow-sm shadow-indigo-600/30 animate-pulse"></div>
            <span className="text-xs font-bold tracking-wide text-slate-700 uppercase">
              Intelligent OCR Studio v1.2
              {imagesList.length > 0 && ` (Active: หน้า ${currentIndex + 1}/${imagesList.length})`}
            </span>
          </div>

          <div className="flex items-center">
            <a
              href="/admin"
              className="mr-3 flex items-center gap-1.5 text-xs font-bold px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 hover:text-indigo-600 hover:border-indigo-200 transition-all shadow-sm active:scale-98"
            >
              Admin
            </a>
            {imagesList.length > 0 && (
              <button
                type="button"
                onClick={handleClearAndUploadNew}
                className="flex items-center gap-1.5 text-xs font-bold px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 hover:text-indigo-600 hover:border-indigo-200 transition-all shadow-sm active:scale-98"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
                เปลี่ยนไฟล์ภาพใหม่
              </button>
            )}
          </div>
        </div>

        {currentStep === "upload" && (
          <UploadZone onUploadSuccess={handleUploadSuccess} />
        )}

        {currentStep === "adjust" && (
          <AdjustZone
            imagesList={originalImagesList.length > 0 ? originalImagesList : imagesList}
            currentIndex={currentIndex}
            onIndexChange={(nextIdx) => setCurrentIndex(nextIdx)}
            pagesConfig={pagesConfig}
            setPagesConfig={setPagesConfig}
            onBatchConfirm={handleBatchConfirm}
          />
        )}

        {currentStep === "studio" && (
          <>
            {matchedTemplate ? (
              <MatchedTemplateWorkspaceZone
                matchedTemplate={matchedTemplate}
                previewUrl={imagesList[currentIndex] || previewUrl}
                image={imagesList[currentIndex] || image}
                brightness={pagesConfig[currentIndex]?.brightness ?? 100}
                contrast={pagesConfig[currentIndex]?.contrast ?? 100}
                rotation={pagesConfig[currentIndex]?.rotation ?? 0}
                rois={rois}
                setRois={setRois}
                selectedId={selectedId}
                setSelectedId={setSelectedId}
                onBackToAdjust={() => setCurrentStep("adjust")}
                deleteROI={(id) => setRois((p) => p.filter((roi) => roi.id !== id))}
                isLoading={isLoading}
                onRunOCR={handleRunOCR}
                onRunFullPageOCR={handleRunFullPageOCR}
                ocrProgress={ocrProgress}
                currentIndex={currentIndex}
                imagesList={imagesList}
                onSwitchToCustom={() => {
                  setMatchedTemplate(null);
                  setTemplateDetectionNotice(null);
                  setClassificationStatus("เปิด Custom OCR ต่อจาก ROI ของ Template ที่ตรวจพบ สามารถเพิ่มหรือแก้ไขกรอบได้ตามต้องการ");
                }}
                onIndexChange={(nextIdx) => {
                  setCurrentIndex(nextIdx);
                  setSelectedId(null);
                }}
              />
            ) : (
              <WorkspaceZone
                previewUrl={imagesList[currentIndex] || previewUrl}
                image={imagesList[currentIndex] || image}
                brightness={pagesConfig[currentIndex]?.brightness ?? 100}
                contrast={pagesConfig[currentIndex]?.contrast ?? 100}
                rotation={pagesConfig[currentIndex]?.rotation ?? 0}
                rois={rois}
                setRois={setRois}
                selectedId={selectedId}
                setSelectedId={setSelectedId}
                onBackToAdjust={() => setCurrentStep("adjust")}
                deleteROI={(id) => setRois((p) => p.filter((roi) => roi.id !== id))}
                isLoading={isLoading}
                onRunOCR={handleRunOCR}
                onRunFullPageOCR={handleRunFullPageOCR}
                ocrProgress={ocrProgress}
                rightPanelTopContent={templateDetectionNotice ? <NoTemplateDetectionCard notice={templateDetectionNotice} /> : null}
                currentIndex={currentIndex}
                imagesList={imagesList}
                onIndexChange={(nextIdx) => {
                  setCurrentIndex(nextIdx);
                  setSelectedId(null);
                }}
              />
            )}
          </>
        )}

        {currentStep === "editor" && (
          <>
            <GroundTruthEditorZone
              previewUrl={imagesList[currentIndex] || previewUrl}
              rois={rois}
              ocrResults={ocrResults}
              setOcrResults={handleGroundTruthResultsChange}
              onBackToStudio={() => setCurrentStep("studio")}
              onApproveAndSave={handleApproveAndSave}
              imageList={imagesList}
              currentImageIndex={currentIndex}
              onImageIndexChange={(nextIdx) => setCurrentIndex(nextIdx)}
            />
            {textPreviewItems.length > 0 && (
              <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-col gap-2 border-b border-slate-100 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <h2 className="text-sm font-black text-slate-900">Text Preview</h2>
                    <p className="mt-0.5 text-xs font-semibold text-slate-500">
                      แสดงค่าข้อความแบบ Key-Value จาก Ground Truth ปัจจุบันของหน้า {currentIndex + 1}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {textPreviewCopyStatus && (
                      <span className="text-[10px] font-black text-emerald-600">{textPreviewCopyStatus}</span>
                    )}
                    <button
                      type="button"
                      onClick={handleCopyTextPreview}
                      className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-xs font-black text-indigo-700 hover:bg-indigo-100"
                    >
                      คัดลอก
                    </button>
                  </div>
                </div>
                <div className="max-h-56 overflow-auto bg-slate-50/60 p-3">
                  <dl className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {textPreviewItems.map((item) => (
                      <div key={item.id} className="grid gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2 sm:grid-cols-[minmax(120px,0.45fr)_minmax(0,1fr)]">
                        <dt className="min-w-0 truncate text-[11px] font-black text-slate-700" title={item.key}>
                          {item.key}
                        </dt>
                        <dd className="min-w-0 whitespace-pre-wrap break-words text-xs font-semibold leading-relaxed text-slate-600" title={item.value || "-"}>
                          {item.value || <span className="text-slate-400">-</span>}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </section>
            )}
            <section className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
              <div>
                <h2 className="text-sm font-black text-slate-800 uppercase tracking-wide">Actions</h2>
                <p className="text-xs font-semibold text-slate-500">
                  ส่งออกผลลัพธ์หรือส่งคำขอให้ผู้ดูแลระบบตรวจสอบ Template
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setIsExportMenuOpen(true)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-black text-slate-700 hover:bg-slate-50"
                >
                  Export
                </button>
                <button
                  type="button"
                  onClick={handleOpenExportWord}
                  className="hidden rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-black text-slate-700 hover:bg-slate-50"
                >
                  Export Word
                </button>
                <div className="hidden rounded-xl border border-slate-200 bg-white p-2">
                  <select
                    value={excelExportMode}
                    onChange={(event) => setExcelExportMode(event.target.value as "fields" | "tables" | "fields_tables")}
                    className="mb-2 w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] font-bold text-slate-600 outline-none"
                  >
                    <option value="fields_tables">Fields + Tables</option>
                    <option value="fields">Fields</option>
                    <option value="tables">Tables</option>
                  </select>
                  <button
                    type="button"
                    onClick={handleOpenExportExcel}
                    className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-xs font-black text-white hover:bg-emerald-700"
                  >
                    Export Excel
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleOpenExportJson}
                  className="hidden rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-black text-slate-700 hover:bg-slate-50"
                >
                  ส่งออก JSON
                </button>
                <button
                  type="button"
                  onClick={handleOpenExportImages}
                  className="hidden rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-black text-slate-700 hover:bg-slate-50"
                >
                  Export Images ZIP
                </button>
                <button
                  type="button"
                  onClick={() => setIsTemplateRequestOpen(true)}
                  className="rounded-xl bg-indigo-600 px-4 py-3 text-xs font-black text-white shadow-sm hover:bg-indigo-700"
                >
                  ส่งคำขอ Template ใหม่
                </button>
              </div>
            </section>
            <TemplateRequestPanel
              imagesList={imagesList}
              rois={rois}
              ocrResults={ocrResults}
              isOpen={isTemplateRequestOpen}
              onClose={() => setIsTemplateRequestOpen(false)}
            />
            {isExportMenuOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
                <section className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
                  <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
                    <div>
                      <h2 className="text-sm font-black uppercase tracking-wide text-slate-900">Export Preview</h2>
                      <p className="mt-1 text-xs font-semibold text-slate-500">
                        ตรวจตัวอย่างจากค่า OCR/Ground Truth ปัจจุบันก่อนสร้างไฟล์จริง
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsExportMenuOpen(false)}
                      className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-black text-white hover:bg-slate-800"
                    >
                      Close
                    </button>
                  </div>

                  <div className="grid min-h-0 flex-1 gap-0 overflow-hidden lg:grid-cols-[280px_1fr]">
                    <aside className="space-y-5 overflow-auto border-b border-slate-200 bg-slate-50 p-5 lg:border-b-0 lg:border-r">
                      <div>
                        <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">Format</p>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          {exportFormats.map((format) => (
                            <button
                              key={format.key}
                              type="button"
                              onClick={() => setExportFormat(format.key)}
                              className={`rounded-lg border px-3 py-2 text-xs font-black ${
                                exportFormat === format.key
                                  ? "border-blue-300 bg-blue-50 text-blue-700"
                                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                              }`}
                            >
                              {format.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">Content</p>
                        <div className="mt-2 space-y-2">
                          {[
                            ["text", "Text"],
                            ["tables", "Tables"],
                            ["images", "Images"],
                          ].map(([key, label]) => (
                            <label key={key} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700">
                              <input
                                type="checkbox"
                                checked={exportContent[key as keyof ExportContentOptions]}
                                onChange={() => toggleExportContent(key as keyof ExportContentOptions)}
                                className="h-4 w-4 rounded border-slate-300 text-blue-600"
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                      </div>

                      <div>
                        <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">Options</p>
                        <div className="mt-2 space-y-2">
                          {[
                            ["showFieldNames", "Show Field Names"],
                            ["showDocumentTitle", "Show Document Title"],
                          ].map(([key, label]) => (
                            <label key={key} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700">
                              <input
                                type="checkbox"
                                checked={exportOptions[key as keyof ExportDisplayOptions]}
                                onChange={() => toggleExportOption(key as keyof ExportDisplayOptions)}
                                className="h-4 w-4 rounded border-slate-300 text-blue-600"
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                      </div>
                    </aside>

                    <div className="min-h-0 overflow-auto bg-slate-100 p-5">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">Preview</p>
                          <h3 className="text-sm font-black text-slate-950">{exportFormats.find((format) => format.key === exportFormat)?.label}</h3>
                        </div>
                        <span className="rounded-full bg-white px-3 py-1 text-[10px] font-black text-slate-500 shadow-sm">
                          {exportPreviewResults.length} fields
                        </span>
                      </div>
                      {renderExportPreview()}
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 border-t border-slate-200 bg-white px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs font-semibold text-slate-500">
                      Preview จะอัปเดตทันทีเมื่อเปลี่ยน Format, Content หรือ Options
                    </p>
                    <button
                      type="button"
                      onClick={() => requestExport(exportFormat)}
                      className="rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-black text-white shadow-sm hover:bg-indigo-700"
                    >
                      Export {exportFormats.find((format) => format.key === exportFormat)?.label}
                    </button>
                  </div>
                </section>
              </div>
            )}
            {exportJson && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
                <section className="flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
                  <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-sm font-black uppercase tracking-wide text-slate-900">Export JSON</h2>
                      <p className="mt-1 text-xs font-semibold text-slate-500">
                        JSON แบบย่อจากผล OCR ที่ตรวจและแก้ไขแล้ว
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={handleCopyExportJson}
                        className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700 hover:bg-slate-50"
                      >
                        Copy JSON
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadTextFile(`ocr-export-${Date.now()}.json`, exportJson)}
                        className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-xs font-black text-indigo-700 hover:bg-indigo-100"
                      >
                        Download JSON
                      </button>
                      <button
                        type="button"
                        onClick={() => setExportJson("")}
                        className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-black text-white hover:bg-slate-800"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                  {copyStatus && (
                    <div className="border-b border-slate-100 bg-emerald-50 px-5 py-2 text-xs font-bold text-emerald-700">
                      {copyStatus}
                    </div>
                  )}
                  {exportPreviewPayload && (
                    <div className="grid gap-3 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-bold text-slate-600 sm:grid-cols-3">
                      <div>Template: <span className="text-slate-900">{exportPreviewPayload.template || "Custom OCR"}</span></div>
                      <div>Pages: <span className="tabular-nums text-slate-900">{exportPreviewPayload.page_count}</span></div>
                      <div>Fields: <span className="tabular-nums text-slate-900">{exportFieldCount}</span></div>
                    </div>
                  )}
                  <div className="min-h-0 flex-1 overflow-auto bg-slate-950 p-4">
                    <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-slate-100">
                      {exportJson}
                    </pre>
                  </div>
                </section>
              </div>
            )}
            {exportText && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
                <section className="flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
                  <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-sm font-black uppercase tracking-wide text-slate-900">Export Text</h2>
                      <p className="mt-1 text-xs font-semibold text-slate-500">
                        Plain text summary from the reviewed OCR result.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={handleCopyExportText}
                        className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700 hover:bg-slate-50"
                      >
                        Copy Text
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadTextFile(`ocr-export-${Date.now()}.txt`, exportText, "text/plain")}
                        className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-xs font-black text-indigo-700 hover:bg-indigo-100"
                      >
                        Download TXT
                      </button>
                      <button
                        type="button"
                        onClick={() => setExportText("")}
                        className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-black text-white hover:bg-slate-800"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                  {copyStatus && (
                    <div className="border-b border-slate-100 bg-emerald-50 px-5 py-2 text-xs font-bold text-emerald-700">
                      {copyStatus}
                    </div>
                  )}
                  {exportPreviewPayload && (
                    <div className="grid gap-3 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-bold text-slate-600 sm:grid-cols-3">
                      <div>Template: <span className="text-slate-900">{exportPreviewPayload.template || "Custom OCR"}</span></div>
                      <div>Pages: <span className="tabular-nums text-slate-900">{exportPreviewPayload.page_count}</span></div>
                      <div>Fields: <span className="tabular-nums text-slate-900">{exportFieldCount}</span></div>
                    </div>
                  )}
                  <div className="min-h-0 flex-1 overflow-auto bg-slate-950 p-4">
                    <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-slate-100">
                      {exportText}
                    </pre>
                  </div>
                </section>
              </div>
            )}
            {saveNotice && (
              <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm">
                <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
                  <div className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full ${
                    saveNotice.tone === "success" ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-600"
                  }`}>
                    {saveNotice.tone === "success" ? "✓" : "!"}
                  </div>
                  <h2 className="mt-4 text-center text-base font-black text-slate-950">{saveNotice.title}</h2>
                  <p className="mt-2 text-center text-sm font-semibold leading-relaxed text-slate-500">{saveNotice.message}</p>
                  <button
                    type="button"
                    onClick={() => setSaveNotice(null)}
                    className="mt-5 w-full rounded-xl bg-slate-900 px-4 py-3 text-xs font-black text-white hover:bg-slate-800"
                  >
                    ตกลง
                  </button>
                </section>
              </div>
            )}
            {isExportWarningOpen && (
              <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm">
                <section className="w-full max-w-md rounded-2xl border border-amber-200 bg-white p-6 shadow-2xl">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-600">!</div>
                  <h2 className="mt-4 text-center text-base font-black text-slate-950">ยังไม่ได้บันทึกการเปลี่ยนแปลง</h2>
                  <p className="mt-2 text-center text-sm font-semibold leading-relaxed text-slate-500">
                    ควรบันทึกผล OCR ที่แก้ไขแล้วก่อนส่งออก เพื่อให้แน่ใจว่าไฟล์ที่ส่งออกเป็นข้อมูลล่าสุด
                  </p>
                  <div className="mt-5 grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setIsExportWarningOpen(false)}
                      className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-black text-slate-700 hover:bg-slate-50"
                    >
                      กลับไปบันทึก
                    </button>
                    <button
                      type="button"
                      onClick={continuePendingExport}
                      className="rounded-xl bg-indigo-600 px-4 py-3 text-xs font-black text-white hover:bg-indigo-700"
                    >
                      ส่งออกต่อ
                    </button>
                  </div>
                </section>
              </div>
            )}
          </>
        )}

        {isTemplateDecisionOpen && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/45 px-4 backdrop-blur-sm">
            <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-2xl">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600" />
              </div>
              <h2 className="mt-5 text-base font-black text-slate-950">กำลังค้นหา Template</h2>
              <p className="mt-2 text-sm font-semibold leading-relaxed text-slate-500">
                ระบบกำลังวิเคราะห์เอกสารและเลือก Template ที่เหมาะสมที่สุด
              </p>
              <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-xs font-bold text-slate-700">
                {templateDecisionStatus || "กำลังประมวลผล..."}
              </div>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
