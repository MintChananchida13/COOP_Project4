"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import RoiLayer from "../shared/workspace/RoiLayer";
import { WorkspaceRoi } from "../shared/workspace/RoiBox";
import WorkspaceCanvas from "../shared/workspace/WorkspaceCanvas";
import { DEFAULT_WORKSPACE_IMAGE_METRICS, ratioToImageBox, WorkspaceImageMetrics } from "../shared/workspace/roiGeometry";
import { IgnoreRegion, Template, TemplateField, TemplatePage, TemplateStatus } from "../types/ocr";
import {
  ADMIN_API_BASE_URL,
  EmbeddingJob,
  createEmbeddingJob,
  failEmbeddingJobDev,
  fetchLatestEmbeddingJob,
  fetchTemplateBundle,
  runEmbeddingJobDev,
  updateTemplateStatus,
} from "./adminApi";
import { samplePage } from "./adminMockData";
import { useAdminState } from "./AdminState";

interface OcrPreviewResult {
  id: string;
  pageNumber: number;
  fieldName: string;
  displayLabel: string;
  extractionMethod: string;
  ocrText: string;
  confidence?: number;
  roiPreviewUrl?: string;
  expectedText?: string;
  verificationStatus?: "pass" | "fail" | "not_configured";
}

type ValidationSeverity = "error" | "warning" | "pass";

interface ValidationItem {
  severity: ValidationSeverity;
  message: string;
}

interface ReadinessMetric {
  label: string;
  status: ValidationSeverity | "info";
  value?: string;
  message?: string;
}

interface ReadinessDashboard {
  integrity: ReadinessMetric[];
  extraction: ReadinessMetric[];
  layout: ReadinessMetric[];
  readinessReasons: ReadinessMetric[];
  recommendations: string[];
  errors: string[];
  warnings: string[];
  passedCount: number;
  score: number;
  scoreLabel: "Excellent" | "Good" | "Needs Review" | "Not Ready";
  roiCoverage: number;
  ignoreCoverage: number;
  ready: boolean;
}

interface EmbeddingInputPreview {
  page_index: number;
  preview_path?: string;
  preview_data_url?: string;
  width?: number;
  height?: number;
  ignore_count?: number;
}

const stableNumericId = (value: string) =>
  Math.abs(value.split("").reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7));

const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);

const isValidRoi = (roi?: TemplateField["roi"] | IgnoreRegion["roi"]) =>
  Boolean(
    roi &&
      isNumber(roi.xRatio) &&
      isNumber(roi.yRatio) &&
      isNumber(roi.widthRatio) &&
      isNumber(roi.heightRatio) &&
      roi.xRatio >= 0 &&
      roi.xRatio <= 1 &&
      roi.yRatio >= 0 &&
      roi.yRatio <= 1 &&
      roi.widthRatio > 0 &&
      roi.widthRatio <= 1 &&
      roi.heightRatio > 0 &&
      roi.heightRatio <= 1
  );

const expectedMethodForDataType = (dataType?: string) => {
  if (dataType === "table") return "ocr_table";
  if (dataType === "image") return "extract_image";
  return "ocr_text";
};

const normalizeDataType = (dataType?: string) => (dataType === "string" ? "text" : dataType || "");

const roiOverlaps = (a: TemplateField["roi"], b: IgnoreRegion["roi"]) => {
  const aRight = a.xRatio + a.widthRatio;
  const aBottom = a.yRatio + a.heightRatio;
  const bRight = b.xRatio + b.widthRatio;
  const bBottom = b.yRatio + b.heightRatio;
  return a.xRatio < bRight && aRight > b.xRatio && a.yRatio < bBottom && aBottom > b.yRatio;
};

const roiArea = (roi?: TemplateField["roi"] | IgnoreRegion["roi"]) => {
  if (!roi || !isValidRoi(roi)) return 0;
  return roi.widthRatio * roi.heightRatio;
};

const roiOverlapRatio = (a: TemplateField["roi"], b: TemplateField["roi"]) => {
  if (!isValidRoi(a) || !isValidRoi(b)) return 0;
  const left = Math.max(a.xRatio, b.xRatio);
  const top = Math.max(a.yRatio, b.yRatio);
  const right = Math.min(a.xRatio + a.widthRatio, b.xRatio + b.widthRatio);
  const bottom = Math.min(a.yRatio + a.heightRatio, b.yRatio + b.heightRatio);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  if (width === 0 || height === 0) return 0;
  return (width * height) / Math.max(Math.min(roiArea(a), roiArea(b)), 0.000001);
};

const scoreLabelFor = (score: number): ReadinessDashboard["scoreLabel"] => {
  if (score >= 90) return "Excellent";
  if (score >= 85) return "Good";
  if (score >= 70) return "Needs Review";
  return "Not Ready";
};

const parseEmbeddingMetadata = (metadataJson?: string | null) => {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as {
      engine?: string;
      version?: string;
      model_name?: string;
      vector_dimension?: number;
      input_count?: number;
      device?: string | null;
      vector_store_engine?: string;
      vector_store_collection?: string;
      vector_store_status?: string;
      pages?: number;
      page_count?: number;
      warning?: string;
      embedding_input_previews?: EmbeddingInputPreview[];
    };
    return parsed;
  } catch {
    return null;
  }
};

const formatJobDuration = (startedAt?: string | null, completedAt?: string | null) => {
  if (!startedAt || !completedAt) return null;
  const started = new Date(startedAt).getTime();
  const completed = new Date(completedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return null;
  const seconds = Math.max(0, Math.round((completed - started) / 1000));
  return `${seconds}s`;
};

const buildReadinessDashboard = (
  template: Template,
  pages: TemplatePage[],
  fields: TemplateField[],
  ignoreRegions: IgnoreRegion[]
): ReadinessDashboard => {
  const integrity: ReadinessMetric[] = [
    {
      label: "Template Name",
      status: template.name.trim() ? "pass" : "error",
      value: template.name || "Missing",
      message: template.name.trim() ? undefined : "Validation Error: template name is required.",
    },
    {
      label: "Template Status",
      status: template.status ? "pass" : "error",
      value: template.status || "Missing",
      message: template.status ? undefined : "Validation Error: template status is required.",
    },
    {
      label: "Total Pages",
      status: pages.length > 0 ? "pass" : "error",
      value: String(pages.length),
      message: pages.length > 0 ? undefined : "Validation Error: at least one page is required.",
    },
    {
      label: "Total Fields",
      status: fields.length > 0 ? "pass" : "error",
      value: String(fields.length),
      message: fields.length > 0 ? undefined : "Validation Error: at least one field is required.",
    },
    {
      label: "Ignore Regions Count",
      status: "info",
      value: String(ignoreRegions.length),
      message: ignoreRegions.length > 0 ? undefined : "Ignore regions are optional.",
    },
  ];

  const extraction: ReadinessMetric[] = [];
  fields.forEach((field) => {
    const fieldLabel = field.displayLabel || field.fieldName || field.id;
    const dataType = normalizeDataType(field.dataType);
    const expectedMethod = expectedMethodForDataType(dataType);
    const checks: ReadinessMetric[] = [
      {
        label: `${fieldLabel}: field key`,
        status: field.fieldName?.trim() ? "pass" : "error",
        message: field.fieldName?.trim() ? undefined : `Field "${fieldLabel}" is missing field key.`,
      },
      {
        label: `${fieldLabel}: display label`,
        status: field.displayLabel?.trim() ? "pass" : "error",
        message: field.displayLabel?.trim() ? undefined : `Field "${fieldLabel}" is missing display label.`,
      },
      {
        label: `${fieldLabel}: page index`,
        status: Number.isInteger(field.pageNumber) && field.pageNumber >= 1 ? "pass" : "error",
        value: String(field.pageNumber || "Missing"),
        message: Number.isInteger(field.pageNumber) && field.pageNumber >= 1 ? undefined : `Field "${fieldLabel}" has invalid page index.`,
      },
      {
        label: `${fieldLabel}: ROI exists`,
        status: field.roi ? "pass" : "error",
        message: field.roi ? undefined : `Field "${fieldLabel}" is missing ROI.`,
      },
      {
        label: `${fieldLabel}: ROI ratios`,
        status: isValidRoi(field.roi) ? "pass" : "error",
        message: isValidRoi(field.roi) ? undefined : `Field "${fieldLabel}" ROI ratios must be numbers between 0 and 1 with width and height greater than 0.`,
      },
      {
        label: `${fieldLabel}: data type`,
        status: dataType ? "pass" : "error",
        value: dataType || "Missing",
        message: dataType ? undefined : `Field "${fieldLabel}" is missing data_type.`,
      },
      {
        label: `${fieldLabel}: extraction method`,
        status: field.extractionMethod ? "pass" : "error",
        value: field.extractionMethod || "Missing",
        message: field.extractionMethod ? undefined : `Field "${fieldLabel}" is missing extraction_method.`,
      },
      {
        label: `${fieldLabel}: type-method mapping`,
        status: dataType && field.extractionMethod === expectedMethod ? "pass" : "error",
        value: dataType ? `${dataType} -> ${field.extractionMethod || "missing"}` : undefined,
        message:
          dataType && field.extractionMethod === expectedMethod
            ? undefined
            : `Field "${fieldLabel}" has data_type "${dataType || "missing"}" but expected extraction_method "${expectedMethod}".`,
      },
    ];
    extraction.push(...checks);
  });

  const totalPageArea = Math.max(pages.length || 1, 1);
  const roiCoverage = fields.reduce((sum, field) => sum + roiArea(field.roi), 0) / totalPageArea;
  const ignoreCoverage = ignoreRegions.reduce((sum, region) => sum + roiArea(region.roi), 0) / totalPageArea;
  const layout: ReadinessMetric[] = [];

  layout.push({
    label: "ROI Coverage",
    status: roiCoverage < 0.05 ? "warning" : roiCoverage > 0.7 ? "warning" : "pass",
    value: `${Math.round(roiCoverage * 100)}%`,
    message:
      roiCoverage < 0.05
        ? "Very Low ROI coverage. Confirm that all fields needed for extraction are marked."
        : roiCoverage > 0.7
          ? "Very High ROI coverage. Large ROI coverage may reduce extraction precision."
          : "Normal ROI coverage.",
  });

  fields.forEach((field, index) => {
    fields.slice(index + 1).forEach((otherField) => {
      if (field.pageNumber !== otherField.pageNumber) return;
      const overlap = roiOverlapRatio(field.roi, otherField.roi);
      if (overlap > 0.5) {
        layout.push({
          label: "Field Overlap",
          status: "error",
          value: `${Math.round(overlap * 100)}%`,
          message: `Fields "${field.displayLabel || field.fieldName}" and "${otherField.displayLabel || otherField.fieldName}" overlap by more than 50%.`,
        });
      } else if (overlap > 0.2) {
        layout.push({
          label: "Field Overlap",
          status: "warning",
          value: `${Math.round(overlap * 100)}%`,
          message: `Fields "${field.displayLabel || field.fieldName}" and "${otherField.displayLabel || otherField.fieldName}" overlap by more than 20%.`,
        });
      }
    });
  });

  if (ignoreRegions.length === 0) {
    layout.push({
      label: "Ignore Region Analysis",
      status: "info",
      message:
        "Ignore regions are optional. If this document contains logos, QR codes, barcodes, stamps, or watermarks, consider masking them before generating embeddings.",
    });
  } else {
    ignoreRegions.forEach((region) => {
      layout.push({
        label: `Ignore Region: ${region.fieldName || region.id}`,
        status: isValidRoi(region.roi) ? "pass" : "error",
        message: isValidRoi(region.roi) ? "Ignore region ROI is valid." : `Ignore region "${region.fieldName || region.id}" has invalid ROI ratios.`,
      });
    });
  }

  layout.push({
    label: "Ignore Region Coverage",
    status: ignoreCoverage > 0.6 ? "warning" : "pass",
    value: `${Math.round(ignoreCoverage * 100)}%`,
    message:
      ignoreCoverage > 0.6
        ? "Ignored area is above 60%. Too much masking may reduce layout information."
        : "Ignore region coverage is acceptable.",
  });

  ignoreRegions.forEach((region) => {
    fields
      .filter((field) => field.pageNumber === region.pageNumber && isValidRoi(field.roi) && isValidRoi(region.roi))
      .forEach((field) => {
        if (roiOverlaps(field.roi, region.roi)) {
          layout.push({
            label: "Ignore Region Overlap",
            status: "warning",
            message: `Ignore region "${region.fieldName || region.id}" overlaps field "${field.displayLabel || field.fieldName}" on page ${region.pageNumber}.`,
          });
        }
      });
  });

  const allMetrics = [...integrity, ...extraction, ...layout];
  const errors = allMetrics.filter((item) => item.status === "error").map((item) => item.message || item.label);
  const warnings = allMetrics.filter((item) => item.status === "warning").map((item) => item.message || item.label);
  const passedCount = allMetrics.filter((item) => item.status === "pass").length;

  const ratio = (items: ReadinessMetric[]) => {
    const scored = items.filter((item) => item.status !== "info");
    if (scored.length === 0) return 1;
    return scored.filter((item) => item.status === "pass").length / scored.length;
  };
  const integrityScore = ratio(integrity) * 40;
  const extractionScore = ratio(extraction) * 30;
  const layoutScore = ratio(layout) * 20;
  const warningPenalty = Math.min(10, warnings.length * 2);
  const errorPenalty = Math.min(40, errors.length * 8);
  const score = Math.max(0, Math.min(100, Math.round(integrityScore + extractionScore + layoutScore + 10 - warningPenalty - errorPenalty)));
  const ready = errors.length === 0 && score >= 70;

  const recommendations: string[] = [];
  if (ignoreRegions.length === 0) recommendations.push("Consider adding ignore regions around logos, QR codes, barcodes, stamps, or watermarks.");
  if (layout.some((item) => item.label === "Field Overlap" && item.status !== "pass")) recommendations.push("Reduce overlapping ROIs so each field captures only its own content.");
  if (roiCoverage > 0.7) recommendations.push("ROI coverage is high. Shrink large ROIs to improve extraction precision.");
  if (fields.some((field) => /^field_\d+$/i.test(field.fieldName) || /^Field \d+$/i.test(field.displayLabel))) recommendations.push("Rename generic field labels and keys to meaningful document terms.");
  if (pages.some((page) => !page.pageName?.trim())) recommendations.push("Add page descriptions or page names for easier template maintenance.");

  const readinessReasons: ReadinessMetric[] = [
    { label: "Validation passed", status: errors.length === 0 ? "pass" : "error", message: errors.length === 0 ? undefined : "Resolve blocking validation errors." },
    { label: "ROI mapping valid", status: extraction.some((item) => item.label.includes("ROI") && item.status === "error") ? "error" : "pass" },
    { label: "Extraction methods configured", status: extraction.some((item) => item.label.includes("extraction method") && item.status === "error") ? "error" : "pass" },
    ...(ignoreRegions.length === 0 ? [{ label: "No ignore regions configured", status: "warning" as const, message: "Optional, but may be useful before embedding." }] : []),
    ...(roiCoverage > 0.7 ? [{ label: "ROI coverage is very high", status: "warning" as const, message: "Large ROI coverage may reduce extraction precision." }] : []),
  ];

  return {
    integrity,
    extraction,
    layout,
    readinessReasons,
    recommendations,
    errors,
    warnings,
    passedCount,
    score,
    scoreLabel: scoreLabelFor(score),
    roiCoverage,
    ignoreCoverage,
    ready,
  };
};

const buildValidationItems = (
  template: Template,
  pages: TemplatePage[],
  fields: TemplateField[],
  ignoreRegions: IgnoreRegion[]
): ValidationItem[] => {
  const items: ValidationItem[] = [];
  const add = (condition: boolean, passMessage: string, failMessage: string, severity: ValidationSeverity = "error") => {
    items.push({ severity: condition ? "pass" : severity, message: condition ? passMessage : failMessage });
  };

  add(template.name.trim().length > 0, "Template has a name.", "Template must have a name.");
  add(pages.length > 0, "Template has at least one page.", "Template must have at least one page.");
  add(fields.length > 0, "Template has at least one field.", "Template must have at least one field.");

  fields.forEach((field) => {
    const fieldLabel = field.displayLabel || field.fieldName || field.id;
    const dataType = normalizeDataType(field.dataType);
    const expectedMethod = expectedMethodForDataType(dataType);

    add(
      Boolean(field.fieldName?.trim() && field.displayLabel?.trim()),
      `Field "${fieldLabel}" has label and key.`,
      `Field "${fieldLabel}" must have both field name and display label.`
    );
    add(
      Number.isInteger(field.pageNumber) && field.pageNumber >= 1,
      `Field "${fieldLabel}" has a page index.`,
      `Field "${fieldLabel}" must have a valid page index.`
    );
    add(Boolean(field.roi), `Field "${fieldLabel}" has ROI.`, `Field "${fieldLabel}" must have ROI.`);
    add(isValidRoi(field.roi), `Field "${fieldLabel}" has valid ROI ratios.`, `Field "${fieldLabel}" ROI ratios must be numbers between 0 and 1, with width and height greater than 0.`);
    add(Boolean(dataType), `Field "${fieldLabel}" has data type.`, `Field "${fieldLabel}" must have data_type.`);
    add(Boolean(field.extractionMethod), `Field "${fieldLabel}" has extraction method.`, `Field "${fieldLabel}" must have extraction_method.`);
    add(
      !dataType || !field.extractionMethod || field.extractionMethod === expectedMethod,
      `Field "${fieldLabel}" data type matches extraction method.`,
      `Field "${fieldLabel}" has data_type "${dataType || "missing"}" but extraction_method "${field.extractionMethod || "missing"}"; expected "${expectedMethod}".`
    );
  });

  ignoreRegions.forEach((region) => {
    const regionLabel = region.fieldName || region.id;
    add(
      isValidRoi(region.roi),
      `Ignore region "${regionLabel}" has valid ROI ratios.`,
      `Ignore region "${regionLabel}" ROI ratios must be numbers between 0 and 1, with width and height greater than 0.`
    );

    fields
      .filter((field) => field.pageNumber === region.pageNumber && isValidRoi(field.roi) && isValidRoi(region.roi))
      .forEach((field) => {
        if (roiOverlaps(field.roi, region.roi)) {
          items.push({
            severity: "warning",
            message: `Ignore region "${regionLabel}" overlaps field "${field.displayLabel || field.fieldName}" on page ${region.pageNumber}.`,
          });
        }
      });
  });

  if (ignoreRegions.length === 0) {
    items.push({ severity: "warning", message: "No ignore regions configured. This is allowed, but layout embedding may include noisy areas." });
  }

  return items;
};

const fieldToRoi = (field: TemplateField, metrics: WorkspaceImageMetrics): WorkspaceRoi & { kind: string; pageNumber: number } => {
  const box = ratioToImageBox(field.roi, metrics);
  return {
    id: stableNumericId(`field:${field.id}`),
    fieldName: field.displayLabel || field.fieldName,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    pageIndex: field.pageNumber - 1,
    pageNumber: field.pageNumber,
    kind: "template_field",
    type: field.dataType === "table" ? "table" : field.dataType === "image" ? "image" : "text",
  };
};

const ignoreToRoi = (region: IgnoreRegion, metrics: WorkspaceImageMetrics): WorkspaceRoi & { kind: string; pageNumber: number } => {
  const box = ratioToImageBox(region.roi, metrics);
  return {
    id: stableNumericId(`ignore:${region.id}`),
    fieldName: `Ignore: ${region.fieldName}`,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    pageIndex: region.pageNumber - 1,
    pageNumber: region.pageNumber,
    kind: "ignore_region",
    type: "text",
  };
};

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });

const cropFieldPreview = async (imageSrc: string, field: TemplateField) => {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement("canvas");
  const x = Math.max(0, field.roi.xRatio * image.naturalWidth);
  const y = Math.max(0, field.roi.yRatio * image.naturalHeight);
  const width = Math.max(1, field.roi.widthRatio * image.naturalWidth);
  const height = Math.max(1, field.roi.heightRatio * image.naturalHeight);
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, x, y, width, height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.92);
};

const evaluateVerification = (field: TemplateField, ocrText: string): OcrPreviewResult["verificationStatus"] => {
  if (!field.useForVerification) return undefined;
  if (!field.expectedText) return "not_configured";
  return ocrText.toLowerCase().includes(field.expectedText.toLowerCase()) ? "pass" : "fail";
};

function LayoutPreviewCanvas({
  imageSrc,
  ignoreRegions,
}: {
  imageSrc: string;
  ignoreRegions: IgnoreRegion[];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    const draw = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      try {
        const image = await loadImage(imageSrc);
        if (cancelled) return;
        canvas.width = image.naturalWidth || 750;
        canvas.height = image.naturalHeight || 1000;
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        ignoreRegions.forEach((region) => {
          ctx.fillStyle = "rgba(15, 23, 42, 0.82)";
          ctx.fillRect(
            region.roi.xRatio * canvas.width,
            region.roi.yRatio * canvas.height,
            region.roi.widthRatio * canvas.width,
            region.roi.heightRatio * canvas.height
          );
        });
      } catch {
        canvas.width = 750;
        canvas.height = 1000;
        ctx.fillStyle = "#f8fafc";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    };

    draw();
    return () => {
      cancelled = true;
    };
  }, [imageSrc, ignoreRegions]);

  return <canvas ref={canvasRef} className="max-h-[420px] w-full rounded-xl border border-slate-200 bg-white object-contain" />;
}

function StatusIcon({ status }: { status: ReadinessMetric["status"] }) {
  if (status === "pass") return <CheckCircle2 size={15} className="shrink-0 text-emerald-600" />;
  if (status === "warning") return <AlertTriangle size={15} className="shrink-0 text-amber-600" />;
  if (status === "error") return <XCircle size={15} className="shrink-0 text-red-600" />;
  return <Info size={15} className="shrink-0 text-sky-600" />;
}

function ProgressBar({ value, tone = "indigo" }: { value: number; tone?: "indigo" | "emerald" | "amber" | "red" | "sky" }) {
  const width = `${Math.max(0, Math.min(100, Math.round(value)))}%`;
  const colorClass = {
    indigo: "bg-indigo-600",
    emerald: "bg-emerald-600",
    amber: "bg-amber-500",
    red: "bg-red-600",
    sky: "bg-sky-600",
  }[tone];
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={`h-full rounded-full ${colorClass}`} style={{ width }} />
    </div>
  );
}

function MetricList({ items, limit }: { items: ReadinessMetric[]; limit?: number }) {
  const visibleItems = limit ? items.slice(0, limit) : items;
  return (
    <div className="mt-3 space-y-2">
      {visibleItems.map((item, index) => (
        <div key={`${item.label}-${index}`} className="flex gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs">
          <StatusIcon status={item.status} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 font-black text-slate-800">
              <span>{item.label}</span>
              {item.value && <span className="rounded bg-white px-1.5 py-0.5 text-[9px] font-black uppercase text-slate-500">{item.value}</span>}
            </div>
            {item.message && <p className="mt-0.5 font-semibold text-slate-500">{item.message}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AdminTemplateTestPage({ templateId }: { templateId: string }) {
  const { templates, pages: statePages, fields: stateFields, ignoreRegions: stateIgnoreRegions } = useAdminState();
  const fallbackTemplate = templates.find((item) => item.id === templateId) || null;
  const [template, setTemplate] = useState<Template | null>(fallbackTemplate);
  const [pages, setPages] = useState<TemplatePage[]>(statePages.filter((page) => page.templateId === templateId));
  const [fields, setFields] = useState<TemplateField[]>(stateFields.filter((field) => field.templateId === templateId));
  const [ignoreRegions, setIgnoreRegions] = useState<IgnoreRegion[]>(stateIgnoreRegions.filter((region) => region.templateId === templateId));
  const [currentPage, setCurrentPage] = useState(0);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [imageMetrics, setImageMetrics] = useState<WorkspaceImageMetrics>(DEFAULT_WORKSPACE_IMAGE_METRICS);
  const [loadStatus, setLoadStatus] = useState<"loading" | "loaded" | "fallback" | "error">("loading");
  const [ocrStatus, setOcrStatus] = useState("");
  const [ocrResults, setOcrResults] = useState<OcrPreviewResult[]>([]);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [showValidationDetails, setShowValidationDetails] = useState(false);
  const [openValidationGroups, setOpenValidationGroups] = useState({
    integrity: false,
    extraction: false,
    layout: false,
  });
  const [statusAction, setStatusAction] = useState<TemplateStatus | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusError, setStatusError] = useState("");
  const [latestEmbeddingJob, setLatestEmbeddingJob] = useState<EmbeddingJob | null>(null);
  const [jobAction, setJobAction] = useState<"create" | "run" | "fail" | null>(null);
  const [isPollingJob, setIsPollingJob] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoadStatus("loading");
      try {
        const [bundle, embeddingJob] = await Promise.all([
          fetchTemplateBundle(templateId),
          fetchLatestEmbeddingJob(templateId).catch((error) => {
            console.warn("Embedding job load failed.", error);
            return null;
          }),
        ]);
        if (cancelled) return;
        setTemplate(bundle.template);
        setPages(bundle.pages);
        setFields(bundle.fields);
        setIgnoreRegions(bundle.ignoreRegions);
        setLatestEmbeddingJob(embeddingJob);
        setLoadStatus("loaded");
      } catch (error) {
        console.warn("Using template test mock fallback because backend template data is unavailable.", error);
        if (cancelled) return;
        setLatestEmbeddingJob(null);
        setLoadStatus(fallbackTemplate ? "fallback" : "error");
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [fallbackTemplate, templateId]);

  useEffect(() => {
    if (!latestEmbeddingJob) return;
    const shouldPoll = isPollingJob || latestEmbeddingJob.status === "running";
    if (!shouldPoll || latestEmbeddingJob.status === "completed" || latestEmbeddingJob.status === "failed") {
      if (isPollingJob) setIsPollingJob(false);
      return;
    }

    let cancelled = false;
    const intervalId = window.setInterval(async () => {
      try {
        const job = await fetchLatestEmbeddingJob(templateId);
        if (cancelled) return;
        setLatestEmbeddingJob(job);
        if (job?.status === "completed" || job?.status === "failed") {
          setIsPollingJob(false);
          const bundle = await fetchTemplateBundle(templateId);
          if (!cancelled) setTemplate(bundle.template);
        }
      } catch (error) {
        console.warn("Embedding job polling failed.", error);
      }
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isPollingJob, latestEmbeddingJob, templateId]);

  const safePages = pages.length > 0 ? pages : [{ id: "empty", templateId, pageNumber: 1, sampleImageUrl: samplePage, similarityThreshold: 0.75, finalConfidenceThreshold: 0.8 }];
  const safeCurrentPage = Math.min(currentPage, Math.max(safePages.length - 1, 0));
  const currentPageNumber = safeCurrentPage + 1;
  const currentPageImage = safePages[safeCurrentPage]?.normalizedImageUrl || safePages[safeCurrentPage]?.sampleImageUrl || samplePage;
  const currentPageFields = fields.filter((field) => field.pageNumber === currentPageNumber);
  const currentPageIgnoreRegions = ignoreRegions.filter((region) => region.pageNumber === currentPageNumber);

  const rois = useMemo(
    () => [
      ...fields.map((field) => fieldToRoi(field, imageMetrics)),
      ...ignoreRegions.map((region) => ignoreToRoi(region, imageMetrics)),
    ],
    [fields, ignoreRegions, imageMetrics]
  );

  const selectedRoiId = selectedFieldId ? stableNumericId(`field:${selectedFieldId}`) : null;
  const selectedField = selectedFieldId ? fields.find((field) => field.id === selectedFieldId) : null;
  const resultsByPage = ocrResults.reduce<Record<number, OcrPreviewResult[]>>((acc, result) => {
    acc[result.pageNumber] = [...(acc[result.pageNumber] || []), result];
    return acc;
  }, {});
  const readinessDashboard = useMemo(
    () => (template ? buildReadinessDashboard(template, pages, fields, ignoreRegions) : null),
    [fields, ignoreRegions, pages, template]
  );
  const validationAllowsLifecycle = Boolean(readinessDashboard?.ready);
  const isStatusActionLoading = statusAction !== null;
  const isJobActionLoading = jobAction !== null;
  const canMarkValidated = validationAllowsLifecycle && template?.status === "draft";
  const canCreateEmbeddingPlaceholder =
    validationAllowsLifecycle &&
    template?.status === "validated" &&
    latestEmbeddingJob?.status !== "queued" &&
    latestEmbeddingJob?.status !== "running";
  const isEmbeddingPending = template?.status === "embedding_pending";
  const isActive = template?.status === "active";
  const isEmbeddingJobRunning = latestEmbeddingJob?.status === "running" || jobAction === "run";
  const canRunEmbeddingJob = latestEmbeddingJob?.status === "queued" && !isJobActionLoading;
  const canFailEmbeddingJob = latestEmbeddingJob?.status === "queued" && !isJobActionLoading;
  const canRetryEmbeddingJob = validationAllowsLifecycle && template?.status === "validated" && latestEmbeddingJob?.status === "failed" && !isJobActionLoading;
  const embeddingMetadata = parseEmbeddingMetadata(latestEmbeddingJob?.metadataJson);
  const embeddingDuration = formatJobDuration(latestEmbeddingJob?.startedAt, latestEmbeddingJob?.completedAt);
  const embeddingInputPreviews = embeddingMetadata?.embedding_input_previews || [];
  const currentEmbeddingPreview =
    embeddingInputPreviews.find((preview) => preview.page_index === currentPageNumber) || embeddingInputPreviews[0] || null;

  const persistTemplateStatus = async (status: TemplateStatus, successMessage: string) => {
    setStatusAction(status);
    setStatusMessage("");
    setStatusError("");
    try {
      const bundle = await updateTemplateStatus(templateId, status);
      setTemplate(bundle.template);
      setPages(bundle.pages);
      setFields(bundle.fields);
      setIgnoreRegions(bundle.ignoreRegions);
      setStatusMessage(successMessage);
    } catch (error) {
      console.warn("Template status update failed.", error);
      setStatusError(error instanceof Error ? error.message : "Template status update failed.");
    } finally {
      setStatusAction(null);
    }
  };

  const handleCreateEmbeddingJob = async () => {
    setJobAction("create");
    setStatusMessage("");
    setStatusError("");
    try {
      const result = await createEmbeddingJob(templateId);
      setLatestEmbeddingJob(result.job);
      setTemplate(result.template);
      setIsPollingJob(false);
      setStatusMessage("Embedding job placeholder created.");
    } catch (error) {
      console.warn("Embedding job creation failed.", error);
      setStatusError(error instanceof Error ? error.message : "Embedding job creation failed.");
    } finally {
      setJobAction(null);
    }
  };

  const handleRunEmbeddingJobDev = async () => {
    if (!latestEmbeddingJob) return;
    setJobAction("run");
    setIsPollingJob(true);
    setStatusMessage("");
    setStatusError("");
    setLatestEmbeddingJob((job) => (job ? { ...job, status: "running", startedAt: job.startedAt || new Date().toISOString() } : job));
    try {
      const result = await runEmbeddingJobDev(latestEmbeddingJob.id);
      setLatestEmbeddingJob(result.job);
      setTemplate(result.template);
      setStatusMessage("Embedding generation stub completed. Template is active.");
      setIsPollingJob(false);
    } catch (error) {
      console.warn("Embedding job run failed.", error);
      setStatusError(error instanceof Error ? error.message : "Embedding job run failed.");
      setIsPollingJob(false);
    } finally {
      setJobAction(null);
    }
  };

  const handleFailEmbeddingJobDev = async () => {
    if (!latestEmbeddingJob) return;
    setJobAction("fail");
    setStatusMessage("");
    setStatusError("");
    try {
      const result = await failEmbeddingJobDev(latestEmbeddingJob.id);
      setLatestEmbeddingJob(result.job);
      setTemplate(result.template);
      setIsPollingJob(false);
      setStatusMessage("Embedding job marked failed. Template returned to validated.");
    } catch (error) {
      console.warn("Embedding job failure update failed.", error);
      setStatusError(error instanceof Error ? error.message : "Embedding job failure update failed.");
    } finally {
      setJobAction(null);
    }
  };

  const runPreviewOcr = async () => {
    setIsPreviewing(true);
    setOcrStatus("Running OCR preview for template fields...");
    setOcrResults([]);

    try {
      const nextResults: OcrPreviewResult[] = [];
      for (const field of fields) {
        const page = safePages.find((item) => item.pageNumber === field.pageNumber);
        const imageSrc = page?.normalizedImageUrl || page?.sampleImageUrl || samplePage;
        const roiPreviewUrl = await cropFieldPreview(imageSrc, field);

        if (field.extractionMethod === "extract_image") {
          nextResults.push({
            id: field.id,
            pageNumber: field.pageNumber,
            fieldName: field.fieldName,
            displayLabel: field.displayLabel,
            extractionMethod: field.extractionMethod,
            ocrText: "(image extraction preview)",
            roiPreviewUrl: roiPreviewUrl || undefined,
            verificationStatus: evaluateVerification(field, ""),
          });
          continue;
        }

        const response = await fetch(`${ADMIN_API_BASE_URL}/api/ai/process`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image: roiPreviewUrl,
            rois: [{ fieldName: field.fieldName, x: 0, y: 0, width: 9999, height: 9999 }],
          }),
        });
        const json = await response.json();
        const result = json?.extracted_data?.[0];
        const ocrText = result?.text || "";

        nextResults.push({
          id: field.id,
          pageNumber: field.pageNumber,
          fieldName: field.fieldName,
          displayLabel: field.displayLabel,
          extractionMethod: field.extractionMethod,
          ocrText,
          confidence: typeof result?.confidence === "number" ? result.confidence : undefined,
          roiPreviewUrl: roiPreviewUrl || undefined,
          expectedText: field.expectedText,
          verificationStatus: evaluateVerification(field, ocrText),
        });
      }

      setOcrResults(nextResults);
      setOcrStatus(`OCR preview complete for ${nextResults.length} fields.`);
    } catch (error) {
      console.error(error);
      setOcrStatus("OCR preview failed. Check backend OCR service and image accessibility.");
    } finally {
      setIsPreviewing(false);
    }
  };

  if (loadStatus === "loading") {
    return <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500 shadow-sm">Loading template test preview...</section>;
  }

  if (!template) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-black text-slate-900">Template not found</h2>
        <Link href="/admin/templates" className="mt-4 inline-flex rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white">
          Back to Templates
        </Link>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-lg font-black text-slate-900">Template Test Preview</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <p className="text-xs font-semibold text-slate-500">{template.name}</p>
              <span
                className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ${
                  isActive
                    ? "bg-emerald-100 text-emerald-700"
                    : isEmbeddingPending
                      ? "bg-amber-100 text-amber-700"
                      : template.status === "validated"
                        ? "bg-sky-100 text-sky-700"
                        : "bg-slate-100 text-slate-600"
                }`}
              >
                {isActive ? "Active" : isEmbeddingPending ? "Embedding Pending" : template.status}
              </span>
              {isActive && <span className="text-[10px] font-black uppercase text-emerald-700">Ready for detection pipeline</span>}
            </div>
            {loadStatus === "fallback" && <p className="mt-2 text-xs font-bold text-amber-600">Showing local fallback because backend template data is unavailable.</p>}
            {!validationAllowsLifecycle && readinessDashboard && (
              <p className="mt-2 text-xs font-bold text-red-600">
                Lifecycle actions disabled: resolve validation errors and keep readiness score at 70 or above.
              </p>
            )}
            {statusMessage && <p className="mt-2 text-xs font-bold text-emerald-600">{statusMessage}</p>}
            {statusError && <p className="mt-2 text-xs font-bold text-red-600">{statusError}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`/admin/templates/${templateId}/edit`} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700">
              Back to Edit Template
            </Link>
            <button
              type="button"
              onClick={() => persistTemplateStatus("validated", "Template marked as validated.")}
              disabled={!canMarkValidated || isStatusActionLoading}
              className="rounded-xl bg-sky-600 px-4 py-2 text-xs font-black text-white disabled:bg-slate-300 disabled:text-slate-500"
            >
              {statusAction === "validated" ? "Saving..." : "Mark as Validated"}
            </button>
            <button
              type="button"
              onClick={handleCreateEmbeddingJob}
              disabled={!canCreateEmbeddingPlaceholder || isStatusActionLoading || isJobActionLoading || isEmbeddingJobRunning}
              className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-black text-emerald-700 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
            >
              {jobAction === "create" ? "Creating..." : "Generate Embedding"}
            </button>
            <button
              type="button"
              onClick={() => persistTemplateStatus("active", "Template marked active for the future detection pipeline.")}
              disabled={isStatusActionLoading || template.status === "active"}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700 disabled:bg-slate-100 disabled:text-slate-400"
            >
              {statusAction === "active" ? "Saving..." : "Mark Active (Dev)"}
            </button>
            <button type="button" disabled className="rounded-xl bg-slate-300 px-4 py-2 text-xs font-black text-slate-500">
              Approve Disabled
            </button>
          </div>
        </div>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Embedding Job Status</h3>
            {latestEmbeddingJob ? (
              <div className="mt-2 space-y-1 text-xs font-semibold text-slate-600">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ${
                      latestEmbeddingJob.status === "completed"
                        ? "bg-emerald-100 text-emerald-700"
                        : latestEmbeddingJob.status === "failed"
                          ? "bg-red-100 text-red-700"
                          : latestEmbeddingJob.status === "running"
                            ? "bg-sky-100 text-sky-700"
                            : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {latestEmbeddingJob.status}
                  </span>
                  <span>Job ID: {latestEmbeddingJob.id}</span>
                </div>
                {isEmbeddingJobRunning && (
                  <div className="mt-2 flex items-center gap-2 rounded-xl border border-sky-100 bg-sky-50 px-3 py-2 font-black text-sky-700">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-sky-200 border-t-sky-700" />
                    Generating embedding...
                  </div>
                )}
                <div className="mt-2 grid gap-1 sm:grid-cols-2">
                  {latestEmbeddingJob.requestedAt && <p>Requested: {latestEmbeddingJob.requestedAt}</p>}
                  {latestEmbeddingJob.startedAt && <p>Started: {latestEmbeddingJob.startedAt}</p>}
                  {latestEmbeddingJob.completedAt && <p>Completed: {latestEmbeddingJob.completedAt}</p>}
                  {embeddingDuration && <p>Duration: {embeddingDuration}</p>}
                </div>
                {(embeddingMetadata || latestEmbeddingJob.vectorId) && (
                  <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50 p-3 text-[11px] font-bold text-emerald-800">
                    <div className="font-black uppercase tracking-wider">Embedding Metadata</div>
                    {embeddingMetadata?.engine && <p className="mt-1">Engine: {embeddingMetadata.engine}</p>}
                    {embeddingMetadata?.version && <p>Version: {embeddingMetadata.version}</p>}
                    {embeddingMetadata?.model_name && <p>Model: {embeddingMetadata.model_name}</p>}
                    {embeddingMetadata?.vector_dimension !== undefined && <p>Vector Dimension: {embeddingMetadata.vector_dimension}</p>}
                    {embeddingMetadata?.input_count !== undefined && <p>Input Count: {embeddingMetadata.input_count}</p>}
                    {embeddingMetadata?.device && <p>Device: {embeddingMetadata.device}</p>}
                    {embeddingMetadata?.vector_store_engine && <p>Vector Store: {embeddingMetadata.vector_store_engine}</p>}
                    {embeddingMetadata?.vector_store_collection && <p>Collection: {embeddingMetadata.vector_store_collection}</p>}
                    {embeddingMetadata?.vector_store_status && <p>Store Status: {embeddingMetadata.vector_store_status}</p>}
                    {(embeddingMetadata?.page_count !== undefined || embeddingMetadata?.pages !== undefined) && (
                      <p>Pages: {embeddingMetadata.page_count ?? embeddingMetadata.pages}</p>
                    )}
                    {latestEmbeddingJob.vectorId && <p>Vector ID: {latestEmbeddingJob.vectorId}</p>}
                  </div>
                )}
                {latestEmbeddingJob.errorMessage && <p className="font-black text-red-700">Error: {latestEmbeddingJob.errorMessage}</p>}
                {latestEmbeddingJob.status === "completed" && <p className="font-black text-emerald-700">Ready for detection pipeline.</p>}
                {latestEmbeddingJob.status === "failed" && <p className="font-black text-amber-700">You can generate a new embedding job after fixing or retrying.</p>}
              </div>
            ) : (
              <p className="mt-2 text-xs font-semibold text-slate-500">No embedding job has been created for this template yet.</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {latestEmbeddingJob?.status === "queued" && (
              <>
                <button
                  type="button"
                  onClick={handleRunEmbeddingJobDev}
                  disabled={!canRunEmbeddingJob}
                  className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-2 text-xs font-black text-sky-700 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
                >
                  {jobAction === "run" ? "Running..." : "Run Embedding (Dev)"}
                </button>
                <button
                  type="button"
                  onClick={handleFailEmbeddingJobDev}
                  disabled={!canFailEmbeddingJob}
                  className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-xs font-black text-red-700 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
                >
                  {jobAction === "fail" ? "Failing..." : "Fail Job (Dev)"}
                </button>
              </>
            )}
            {latestEmbeddingJob?.status === "failed" && (
              <button
                type="button"
                onClick={handleCreateEmbeddingJob}
                disabled={!canRetryEmbeddingJob}
                className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-2 text-xs font-black text-sky-700 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
              >
                {jobAction === "create" ? "Retrying..." : "Retry"}
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Embedding Input Preview</h3>
            <p className="mt-1 text-[11px] font-semibold text-slate-500">
              This is the image that will be sent to the future embedding model.
            </p>
          </div>
          {embeddingInputPreviews.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {embeddingInputPreviews.map((preview) => (
                <button
                  key={`embedding-preview-page-${preview.page_index}`}
                  type="button"
                  onClick={() => {
                    const pageIndex = safePages.findIndex((page) => page.pageNumber === preview.page_index);
                    if (pageIndex >= 0) setCurrentPage(pageIndex);
                  }}
                  className={`rounded-lg px-3 py-1.5 text-[10px] font-black ${
                    currentEmbeddingPreview?.page_index === preview.page_index
                      ? "bg-emerald-600 text-white"
                      : "border border-slate-200 bg-white text-slate-600"
                  }`}
                >
                  Page {preview.page_index}
                </button>
              ))}
            </div>
          )}
        </div>

        {currentEmbeddingPreview?.preview_data_url ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px]">
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
              <img
                src={currentEmbeddingPreview.preview_data_url}
                alt={`Embedding input preview page ${currentEmbeddingPreview.page_index}`}
                className="max-h-[520px] w-full object-contain"
              />
            </div>
            <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-3 text-xs font-bold text-emerald-800">
              <div className="font-black uppercase tracking-wider">Preview Details</div>
              <p className="mt-2">Page: {currentEmbeddingPreview.page_index}</p>
              {currentEmbeddingPreview.width && currentEmbeddingPreview.height && (
                <p>
                  Size: {currentEmbeddingPreview.width} x {currentEmbeddingPreview.height}
                </p>
              )}
              <p>Ignore Regions Masked: {currentEmbeddingPreview.ignore_count ?? 0}</p>
              {embeddingMetadata?.warning && <p className="mt-2 text-amber-700">Warning: {embeddingMetadata.warning}</p>}
            </div>
          </div>
        ) : (
          <div className="mt-4 rounded-xl bg-slate-50 p-4 text-xs font-semibold text-slate-500">
            <p>Embedding preview will be available after running the embedding preparation job.</p>
            {embeddingMetadata?.warning && <p className="mt-2 font-black text-amber-700">Warning: {embeddingMetadata.warning}</p>}
          </div>
        )}
      </section>

      {readinessDashboard && (
        <section className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Embedding Readiness Dashboard</h3>
                <p className={`mt-1 text-sm font-black ${readinessDashboard.ready ? "text-emerald-700" : "text-red-700"}`}>
                  Ready for Embedding: {readinessDashboard.ready ? "YES" : "NO"}
                </p>
              </div>
              <div className="min-w-[240px] rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Readiness Score</span>
                  <span
                    className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ${
                      readinessDashboard.scoreLabel === "Excellent"
                        ? "bg-emerald-100 text-emerald-700"
                        : readinessDashboard.scoreLabel === "Good"
                          ? "bg-sky-100 text-sky-700"
                          : readinessDashboard.scoreLabel === "Needs Review"
                            ? "bg-amber-100 text-amber-700"
                            : "bg-red-100 text-red-700"
                    }`}
                  >
                    {readinessDashboard.scoreLabel}
                  </span>
                </div>
                <div className="mt-2 flex items-end gap-2">
                  <span className="text-3xl font-black text-slate-900">{readinessDashboard.score}</span>
                  <span className="pb-1 text-xs font-bold text-slate-400">/ 100</span>
                </div>
                <div className="mt-2">
                  <ProgressBar
                    value={readinessDashboard.score}
                    tone={readinessDashboard.score >= 85 ? "emerald" : readinessDashboard.score >= 70 ? "amber" : "red"}
                  />
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2 text-[10px] font-black uppercase">
              <span className="rounded-full bg-red-100 px-2.5 py-1 text-red-700">{readinessDashboard.errors.length} errors</span>
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-700">{readinessDashboard.warnings.length} warnings</span>
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-700">{readinessDashboard.passedCount} passed checks</span>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h4 className="text-xs font-black uppercase tracking-wider text-slate-700">Embedding Readiness</h4>
              <MetricList items={readinessDashboard.readinessReasons} />
              {readinessDashboard.errors.length > 0 && (
                <div className="mt-3 rounded-xl border border-red-100 bg-red-50 p-3">
                  <h5 className="text-[10px] font-black uppercase tracking-wider text-red-700">Blocking Errors</h5>
                  <ul className="mt-2 space-y-1.5 text-xs font-semibold text-red-800">
                    {readinessDashboard.errors.map((message, index) => (
                      <li key={`dashboard-error-${index}`}>- {message}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h4 className="text-xs font-black uppercase tracking-wider text-slate-700">Recommendations</h4>
              {readinessDashboard.recommendations.length === 0 ? (
                <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-xs font-bold text-emerald-700">
                  No recommendations. Current template setup looks ready for embedding preparation.
                </p>
              ) : (
                <ul className="mt-3 space-y-2 text-xs font-semibold text-slate-600">
                  {readinessDashboard.recommendations.map((recommendation, index) => (
                    <li key={`recommendation-${index}`} className="flex gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                      <Info size={14} className="mt-0.5 shrink-0 text-sky-600" />
                      <span>{recommendation}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h4 className="text-xs font-black uppercase tracking-wider text-slate-700">Validation Details</h4>
                <p className="mt-1 text-[11px] font-semibold text-slate-500">
                  Detailed checks are hidden by default to keep this dashboard focused.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowValidationDetails((value) => !value)}
                className="w-fit rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700 hover:bg-slate-50"
              >
                {showValidationDetails ? "Hide Validation Details" : "View Validation Details"}
              </button>
            </div>

            {showValidationDetails && (
              <div className="mt-4 space-y-3">
                <div className="rounded-xl border border-slate-200">
                  <button
                    type="button"
                    onClick={() => setOpenValidationGroups((prev) => ({ ...prev, integrity: !prev.integrity }))}
                    className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-black uppercase tracking-wider text-slate-700"
                  >
                    Template Integrity
                    <span className="text-[10px] text-slate-400">{openValidationGroups.integrity ? "Hide" : "Show"}</span>
                  </button>
                  {openValidationGroups.integrity && <div className="border-t border-slate-100 p-4"><MetricList items={readinessDashboard.integrity} /></div>}
                </div>

                <div className="rounded-xl border border-slate-200">
                  <button
                    type="button"
                    onClick={() => setOpenValidationGroups((prev) => ({ ...prev, extraction: !prev.extraction }))}
                    className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-black uppercase tracking-wider text-slate-700"
                  >
                    Extraction Quality
                    <span className="text-[10px] text-slate-400">{openValidationGroups.extraction ? "Hide" : "Show"}</span>
                  </button>
                  {openValidationGroups.extraction && (
                    <div className="border-t border-slate-100 p-4">
                      <div className="flex flex-wrap gap-2 text-[10px] font-black uppercase">
                        <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-700">
                          {readinessDashboard.extraction.filter((item) => item.status === "pass").length} passed
                        </span>
                        <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-700">
                          {readinessDashboard.extraction.filter((item) => item.status === "warning").length} warnings
                        </span>
                        <span className="rounded-full bg-red-100 px-2.5 py-1 text-red-700">
                          {readinessDashboard.extraction.filter((item) => item.status === "error").length} errors
                        </span>
                      </div>
                      <MetricList items={readinessDashboard.extraction} />
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-slate-200">
                  <button
                    type="button"
                    onClick={() => setOpenValidationGroups((prev) => ({ ...prev, layout: !prev.layout }))}
                    className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-black uppercase tracking-wider text-slate-700"
                  >
                    Layout Quality
                    <span className="text-[10px] text-slate-400">{openValidationGroups.layout ? "Hide" : "Show"}</span>
                  </button>
                  {openValidationGroups.layout && (
                    <div className="border-t border-slate-100 p-4">
                      <div className="grid gap-4 lg:grid-cols-2">
                        <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                          <div className="flex items-center justify-between text-xs font-black text-slate-700">
                            <span>ROI Coverage</span>
                            <span>{Math.round(readinessDashboard.roiCoverage * 100)}%</span>
                          </div>
                          <div className="mt-2">
                            <ProgressBar
                              value={readinessDashboard.roiCoverage * 100}
                              tone={readinessDashboard.roiCoverage > 0.7 ? "amber" : readinessDashboard.roiCoverage < 0.05 ? "sky" : "emerald"}
                            />
                          </div>
                        </div>
                        <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                          <div className="flex items-center justify-between text-xs font-black text-slate-700">
                            <span>Ignore Region Coverage</span>
                            <span>{Math.round(readinessDashboard.ignoreCoverage * 100)}%</span>
                          </div>
                          <div className="mt-2">
                            <ProgressBar value={readinessDashboard.ignoreCoverage * 100} tone={readinessDashboard.ignoreCoverage > 0.6 ? "amber" : "sky"} />
                          </div>
                        </div>
                      </div>
                      <MetricList items={readinessDashboard.layout} />
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        </section>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Field ROI Preview</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {safePages.map((page, index) => (
              <button
                key={page.id}
                type="button"
                onClick={() => setCurrentPage(index)}
                className={`rounded-lg px-3 py-1.5 text-[10px] font-black ${safeCurrentPage === index ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-600"}`}
              >
                Page {page.pageNumber}
              </button>
            ))}
          </div>
          <div className="mt-3">
            <WorkspaceCanvas imageSrc={currentPageImage} className="h-[620px]" onImageMetricsChange={setImageMetrics}>
              <RoiLayer
                rois={rois}
                currentPage={safeCurrentPage}
                selectedId={selectedRoiId}
                readonly
                showLabels
                onSelect={(id) => {
                  const field = fields.find((item) => stableNumericId(`field:${item.id}`) === id);
                  if (field) setSelectedFieldId(field.id);
                }}
              />
            </WorkspaceCanvas>
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Page {currentPageNumber} Fields</h3>
            <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
              {currentPageFields.length === 0 ? (
                <p className="rounded-xl bg-slate-50 p-3 text-xs font-semibold text-slate-500">No template fields on this page.</p>
              ) : (
                currentPageFields.map((field) => (
                  <button
                    key={field.id}
                    type="button"
                    onClick={() => setSelectedFieldId(field.id)}
                    className={`w-full rounded-xl border p-3 text-left text-xs transition-colors ${selectedFieldId === field.id ? "border-sky-400 bg-sky-50 text-sky-900" : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-white"}`}
                  >
                    <div className="font-black">{field.displayLabel}</div>
                    <div className="mt-1 text-[10px] font-bold text-slate-500">{field.fieldName}</div>
                    <div className="mt-1 text-[9px] font-black uppercase text-slate-400">{field.extractionMethod}</div>
                  </button>
                ))
              )}
            </div>
            {selectedField && (
              <div className="mt-3 rounded-xl bg-sky-50 p-3 text-xs font-semibold text-sky-900">
                Selected: {selectedField.displayLabel} on page {selectedField.pageNumber}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Layout Preview for Embedding</h3>
            <p className="mt-1 text-[11px] font-semibold text-slate-500">Ignore regions are masked before future embedding generation.</p>
            <div className="mt-3">
              <LayoutPreviewCanvas imageSrc={currentPageImage} ignoreRegions={currentPageIgnoreRegions} />
            </div>
          </section>
        </aside>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">OCR Result Preview</h3>
            <p className="mt-1 text-[11px] font-semibold text-slate-500">Runs OCR only on template field ROI, grouped by page.</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={runPreviewOcr} disabled={isPreviewing || fields.length === 0} className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white disabled:bg-slate-300 disabled:text-slate-500">
              {isPreviewing ? "Previewing..." : ocrResults.length > 0 ? "Retest" : "Preview OCR Fields"}
            </button>
          </div>
        </div>
        {ocrStatus && <p className="mt-3 text-xs font-bold text-slate-600">{ocrStatus}</p>}
        <div className="mt-4 space-y-4">
          {ocrResults.length === 0 ? (
            <p className="rounded-xl bg-slate-50 p-4 text-xs font-semibold text-slate-500">No OCR preview results yet.</p>
          ) : (
            Object.entries(resultsByPage).map(([pageNumber, pageResults]) => (
              <div key={pageNumber} className="rounded-xl border border-slate-200 p-3">
                <h4 className="text-xs font-black text-slate-800">Page {pageNumber}</h4>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {pageResults.map((result) => (
                    <div key={result.id} className="rounded-xl bg-slate-50 p-3 text-xs">
                      <div className="flex gap-3">
                        {result.roiPreviewUrl && <img src={result.roiPreviewUrl} alt="" className="h-16 w-24 rounded-lg border border-slate-200 bg-white object-contain" />}
                        <div className="min-w-0 flex-1">
                          <div className="font-black text-slate-900">{result.displayLabel}</div>
                          <div className="mt-0.5 text-[10px] font-bold text-slate-500">{result.fieldName}</div>
                          <div className="mt-1 text-[10px] font-black uppercase text-indigo-600">{result.extractionMethod}</div>
                        </div>
                      </div>
                      <div className="mt-3 rounded-lg bg-white p-2 font-semibold text-slate-700">{result.ocrText || "(empty)"}</div>
                      <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-black uppercase">
                        <span className="rounded-full bg-slate-200 px-2 py-1 text-slate-600">Confidence {result.confidence !== undefined ? result.confidence.toFixed(2) : "N/A"}</span>
                        {result.verificationStatus && (
                          <span className={`rounded-full px-2 py-1 ${result.verificationStatus === "pass" ? "bg-emerald-100 text-emerald-700" : result.verificationStatus === "fail" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                            Verification {result.verificationStatus}
                          </span>
                        )}
                      </div>
                      {result.expectedText && <div className="mt-2 text-[10px] font-semibold text-slate-500">Expected: {result.expectedText}</div>}
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

    </section>
  );
}
