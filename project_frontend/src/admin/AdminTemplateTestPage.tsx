"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Info, XCircle } from "lucide-react";
import RoiLayer from "../shared/workspace/RoiLayer";
import { WorkspaceRoi } from "../shared/workspace/RoiBox";
import WorkspaceCanvas from "../shared/workspace/WorkspaceCanvas";
import { DEFAULT_WORKSPACE_IMAGE_METRICS, ratioToImageBox, WorkspaceImageMetrics } from "../shared/workspace/roiGeometry";
import { IgnoreRegion, Template, TemplateField, TemplatePage, TemplateStatus } from "../types/ocr";
import {
  ADMIN_API_BASE_URL,
  EmbeddingJob,
  PrepublishCandidate,
  PrepublishDetectionTestResult,
  PrepublishSimulationResult,
  confirmTemplatePublish,
  createEmbeddingJob,
  failEmbeddingJobDev,
  fetchLatestEmbeddingJob,
  fetchTemplateBundle,
  runPrepublishDetectionTest,
  runPrepublishSimulation,
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
  passed?: boolean;
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

const prepublishSimulationSteps = [
  "Generate Global Embedding",
  "Searching Templates",
  "Top 5 Retrieved",
  "Running Image Anchors",
  "Running Text Anchors",
  "Re-ranking",
  "Completed",
];

const formatPrepublishScore = (value?: number | null) => (typeof value === "number" ? value.toFixed(2) : "N/A");

const readPrepublishValue = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
};

function DraftSummaryCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
      <div className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</div>
      <div className="mt-1 text-lg font-black text-slate-900">{value}</div>
    </div>
  );
}

function DraftSectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">{title}</h3>
      {subtitle && <p className="mt-1 text-[11px] font-semibold text-slate-500">{subtitle}</p>}
    </div>
  );
}

function DraftStatusPill({ passed, label }: { passed: boolean; label?: string }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ${passed ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
      {label || (passed ? "PASS" : "FAIL")}
    </span>
  );
}

function DraftCandidateCard({
  candidate,
  open,
  onToggle,
}: {
  candidate: PrepublishCandidate;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 px-4 py-3 text-left">
        {open ? <ChevronDown size={16} className="mt-0.5 text-slate-400" /> : <ChevronRight size={16} className="mt-0.5 text-slate-400" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-black text-slate-900">#{candidate.rank}</span>
            <span className="text-xs font-black text-slate-900">{candidate.templateName || candidate.templateId}</span>
            {candidate.isCurrentDraft && <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[9px] font-black uppercase text-indigo-700">Current Draft</span>}
            <DraftStatusPill passed={candidate.finalPassed} label={candidate.decision || (candidate.finalPassed ? "PASS" : "REVIEW")} />
          </div>
          <div className="mt-2 grid gap-2 text-[10px] font-bold text-slate-500 sm:grid-cols-3 xl:grid-cols-6">
            <span>Global {formatPrepublishScore(candidate.globalScore)}</span>
            <span>Image {formatPrepublishScore(candidate.imageAnchorScore)}</span>
            <span>Text {formatPrepublishScore(candidate.textAnchorScore)}</span>
            <span>Verify {formatPrepublishScore(candidate.verificationScore)}</span>
            <span>Final {formatPrepublishScore(candidate.finalScore)}</span>
            <span>Align {candidate.alignmentStatus || "N/A"}</span>
          </div>
        </div>
      </button>
      {open && (
        <div className="border-t border-slate-100 p-4">
          <div className="grid gap-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
            <DraftSummaryCard label="Template ID" value={candidate.templateId} />
            <DraftSummaryCard label="Template Status" value={candidate.templateStatus || "N/A"} />
            <DraftSummaryCard label="Page Count" value={candidate.pageCount ?? "N/A"} />
            <DraftSummaryCard label="Field Count" value={candidate.fieldCount ?? "N/A"} />
          </div>
          {candidate.verificationDetails && candidate.verificationDetails.length > 0 && (
            <div className="mt-4 rounded-xl bg-slate-50 p-3">
              <h4 className="text-[10px] font-black uppercase tracking-wider text-slate-500">Verification Checklist</h4>
              <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <table className="min-w-full divide-y divide-slate-100 text-[11px]">
                  <thead className="bg-slate-50 text-[9px] font-black uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Anchor</th>
                      <th className="px-3 py-2 text-left">Type</th>
                      <th className="px-3 py-2 text-left">Required</th>
                      <th className="px-3 py-2 text-left">Score</th>
                      <th className="px-3 py-2 text-left">Result</th>
                      <th className="px-3 py-2 text-left">Reason</th>
                      <th className="px-3 py-2 text-left">Expected</th>
                      <th className="px-3 py-2 text-left">Actual</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {candidate.verificationDetails.map((detail, index) => {
                      const required = Boolean(readPrepublishValue(detail, ["required", "required_for_verification"]));
                      const passed = Boolean(readPrepublishValue(detail, ["passed", "final_passed"]));
                      return (
                        <tr key={`${candidate.templateId}-check-${index}`} className={required && !passed ? "bg-red-50" : undefined}>
                          <td className="px-3 py-2 font-black text-slate-900">
                            {String(readPrepublishValue(detail, ["field_name", "anchor_name", "name", "display_label"]) || `Anchor ${index + 1}`)}
                          </td>
                          <td className="px-3 py-2 font-semibold text-slate-600">
                            {String(readPrepublishValue(detail, ["anchor_type", "verification_method", "match_type"]) || "verification")}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase ${required ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"}`}>
                              {required ? "Required" : "Optional"}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-black text-slate-900">
                            {formatPrepublishScore(Number(readPrepublishValue(detail, ["score", "field_score", "similarity_score", "dino_similarity_score"]) || 0))}
                          </td>
                          <td className="px-3 py-2">
                            <DraftStatusPill passed={passed} label={passed ? "PASS" : "FAIL"} />
                          </td>
                          <td className="px-3 py-2 font-semibold text-slate-600">
                            {String(readPrepublishValue(detail, ["failure_reason", "error", "status"]) || "N/A")}
                          </td>
                          <td className="max-w-[180px] truncate px-3 py-2 font-semibold text-slate-600">
                            {String(readPrepublishValue(detail, ["expected_text"]) || "N/A")}
                          </td>
                          <td className="max-w-[180px] truncate px-3 py-2 font-semibold text-slate-600">
                            {String(readPrepublishValue(detail, ["actual_text", "ocr_text"]) || "N/A")}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {candidate.verificationDetails.some((detail) => Boolean(readPrepublishValue(detail, ["required", "required_for_verification"])) && !Boolean(readPrepublishValue(detail, ["passed", "final_passed"]))) && (
                <p className="mt-3 rounded-lg bg-red-50 p-3 text-xs font-bold text-red-700">
                  Candidate นี้ถูกปฏิเสธด้วย required_verification_failed เพราะมี Required Verification Anchor อย่างน้อย 1 รายการที่ FAIL.
                </p>
              )}
              <h4 className="mt-4 text-[10px] font-black uppercase tracking-wider text-slate-500">ROI Preview / Debug</h4>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {candidate.verificationDetails.map((detail, index) => (
                  <div key={`${candidate.templateId}-detail-${index}`} className="rounded-lg bg-white p-3 text-xs font-semibold text-slate-600">
                    <div className="font-black text-slate-900">
                      {String(readPrepublishValue(detail, ["field_name", "anchor_name", "name", "display_label"]) || `Detail ${index + 1}`)}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-[10px]">
                      <span>{String(readPrepublishValue(detail, ["anchor_type", "verification_method", "match_type"]) || "verification")}</span>
                      <span>Score {formatPrepublishScore(Number(readPrepublishValue(detail, ["score", "field_score", "similarity_score"]) || 0))}</span>
                      <span>Weight {String(readPrepublishValue(detail, ["weight", "verification_weight"]) || "N/A")}</span>
                      <span>{String(readPrepublishValue(detail, ["status", "decision", "failure_reason"]) || "N/A")}</span>
                    </div>
                    {(readPrepublishValue(detail, ["expected_text"]) || readPrepublishValue(detail, ["actual_text", "ocr_text"])) && (
                      <div className="mt-2 grid gap-2 text-[10px] md:grid-cols-2">
                        <p className="rounded bg-slate-50 p-2">Expected: {String(readPrepublishValue(detail, ["expected_text"]) || "N/A")}</p>
                        <p className="rounded bg-slate-50 p-2">Actual: {String(readPrepublishValue(detail, ["actual_text", "ocr_text"]) || "N/A")}</p>
                      </div>
                    )}
                    {(readPrepublishValue(detail, ["reference_crop_preview_data_url", "reference_crop_preview_url"]) ||
                      readPrepublishValue(detail, ["current_crop_preview_data_url", "current_crop_preview_url"])) && (
                      <div className="mt-3 grid gap-2 md:grid-cols-2">
                        <div className="rounded border border-slate-100 bg-slate-50 p-2">
                          <div className="text-[9px] font-black uppercase text-slate-400">Reference ROI</div>
                          {readPrepublishValue(detail, ["reference_crop_preview_data_url", "reference_crop_preview_url"]) ? (
                            <img
                              src={String(readPrepublishValue(detail, ["reference_crop_preview_data_url", "reference_crop_preview_url"]))}
                              alt=""
                              className="mt-2 h-24 w-full rounded object-contain"
                            />
                          ) : (
                            <p className="mt-2 text-[10px] text-slate-400">No preview</p>
                          )}
                        </div>
                        <div className="rounded border border-slate-100 bg-slate-50 p-2">
                          <div className="text-[9px] font-black uppercase text-slate-400">Test ROI</div>
                          {readPrepublishValue(detail, ["current_crop_preview_data_url", "current_crop_preview_url"]) ? (
                            <img
                              src={String(readPrepublishValue(detail, ["current_crop_preview_data_url", "current_crop_preview_url"]))}
                              alt=""
                              className="mt-2 h-24 w-full rounded object-contain"
                            />
                          ) : (
                            <p className="mt-2 text-[10px] text-slate-400">No preview</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AdminTemplateTestPage({ templateId }: { templateId: string }) {
  const { templates, pages: statePages, fields: stateFields } = useAdminState();
  const fallbackTemplate = templates.find((item) => item.id === templateId) || null;
  const [template, setTemplate] = useState<Template | null>(fallbackTemplate);
  const [pages, setPages] = useState<TemplatePage[]>(statePages.filter((page) => page.templateId === templateId));
  const [fields, setFields] = useState<TemplateField[]>(stateFields.filter((field) => field.templateId === templateId));
  const [currentPage, setCurrentPage] = useState(0);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [imageMetrics, setImageMetrics] = useState<WorkspaceImageMetrics>(DEFAULT_WORKSPACE_IMAGE_METRICS);
  const [loadStatus, setLoadStatus] = useState<"loading" | "loaded" | "fallback" | "error">("loading");
  const [ocrResults, setOcrResults] = useState<OcrPreviewResult[]>([]);
  const [ocrStatus, setOcrStatus] = useState("");
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [simulation, setSimulation] = useState<PrepublishSimulationResult | null>(null);
  const [simulationAction, setSimulationAction] = useState<"run" | "confirm" | null>(null);
  const [simulationStep, setSimulationStep] = useState(0);
  const [simulationError, setSimulationError] = useState("");
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [expandedCandidates, setExpandedCandidates] = useState<Record<string, boolean>>({});
  const [validationStep, setValidationStep] = useState(1);
  const [testDocumentFile, setTestDocumentFile] = useState<File | null>(null);
  const [testDocumentPreviewUrl, setTestDocumentPreviewUrl] = useState<string | null>(null);
  const [detectionTest, setDetectionTest] = useState<PrepublishDetectionTestResult | null>(null);
  const [detectionTestAction, setDetectionTestAction] = useState(false);
  const [detectionTestError, setDetectionTestError] = useState("");
  const [expandedDetectionCandidates, setExpandedDetectionCandidates] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoadStatus("loading");
      try {
        const bundle = await fetchTemplateBundle(templateId);
        if (cancelled) return;
        setTemplate(bundle.template);
        setPages(bundle.pages);
        setFields(bundle.fields);
        setLoadStatus("loaded");
      } catch (error) {
        console.warn("Using template pre-publish fallback because backend template data is unavailable.", error);
        if (cancelled) return;
        setLoadStatus(fallbackTemplate ? "fallback" : "error");
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [fallbackTemplate, templateId]);

  useEffect(() => {
    if (simulationAction !== "run") return;
    setSimulationStep(0);
    const intervalId = window.setInterval(() => {
      setSimulationStep((step) => Math.min(step + 1, prepublishSimulationSteps.length - 1));
    }, 700);
    return () => window.clearInterval(intervalId);
  }, [simulationAction]);

  useEffect(() => {
    return () => {
      if (testDocumentPreviewUrl) URL.revokeObjectURL(testDocumentPreviewUrl);
    };
  }, [testDocumentPreviewUrl]);

  const safePages = pages.length > 0 ? pages : [{ id: "empty", templateId, pageNumber: 1, sampleImageUrl: samplePage, similarityThreshold: 0.75, finalConfidenceThreshold: 0.8 }];
  const safeCurrentPage = Math.min(currentPage, Math.max(safePages.length - 1, 0));
  const currentPageNumber = safePages[safeCurrentPage]?.pageNumber || safeCurrentPage + 1;
  const currentPageImage = safePages[safeCurrentPage]?.normalizedImageUrl || safePages[safeCurrentPage]?.sampleImageUrl || samplePage;
  const extractionFields = fields.filter((field) => !field.useForVerification);
  const verificationAnchors = fields.filter((field) => field.useForVerification);
  const textAnchors = verificationAnchors.filter((field) => field.dataType !== "image");
  const imageAnchors = verificationAnchors.filter((field) => field.dataType === "image");
  const currentPageFields = extractionFields.filter((field) => field.pageNumber === currentPageNumber);
  const currentPageAnchors = verificationAnchors.filter((field) => field.pageNumber === currentPageNumber);
  const selectedField = selectedFieldId ? fields.find((field) => field.id === selectedFieldId) : null;
  const selectedRoiId = selectedFieldId
    ? stableNumericId(`${selectedField?.useForVerification ? "anchor" : "field"}:${selectedFieldId}`)
    : null;
  const rois = useMemo(() => fields.map((field) => fieldToRoi(field, imageMetrics)), [fields, imageMetrics]);
  const resultsByPage = ocrResults.reduce<Record<number, OcrPreviewResult[]>>((acc, result) => {
    acc[result.pageNumber] = [...(acc[result.pageNumber] || []), result];
    return acc;
  }, {});
  const topCandidates = simulation?.candidates.slice(0, 5) || [];
  const simulationPassed = Boolean(simulation?.separationAnalysis.simulationPassed);
  const detectionTestPassed = Boolean(detectionTest?.passed && detectionTest.draftTemplateRank === 1);
  const publishPrerequisitesMet = Boolean(simulationPassed && detectionTest);
  const overallReady = publishPrerequisitesMet && (!detectionTest || detectionTestPassed);
  const canRunDetectionTest = Boolean(simulation?.temporaryEmbedding && simulationAction === null && testDocumentFile && !detectionTestAction);
  const canConfirmPublish = publishPrerequisitesMet && simulationAction === null && template?.status !== "active";

  const runPreviewOcr = async () => {
    setIsPreviewing(true);
    setOcrStatus("Running OCR on extraction fields...");
    setOcrResults([]);

    try {
      const nextResults: OcrPreviewResult[] = [];
      for (const field of extractionFields) {
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
            ocrText: "(image crop ready)",
            roiPreviewUrl: roiPreviewUrl || undefined,
            passed: Boolean(roiPreviewUrl),
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
          passed: ocrText.trim().length > 0,
        });
      }

      setOcrResults(nextResults);
      setOcrStatus(`OCR preview complete for ${nextResults.length} extraction fields.`);
    } catch (error) {
      console.error(error);
      setOcrStatus("OCR preview failed. Check the OCR backend and image data.");
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleRunPrepublishSimulation = async () => {
    setSimulationAction("run");
    setSimulationError("");
    setStatusMessage("");
    setPublishConfirmed(false);
    try {
      const result = await runPrepublishSimulation(templateId);
      setSimulation(result);
      setTemplate(result.template);
      setSimulationStep(prepublishSimulationSteps.length - 1);
      setStatusMessage("Temporary embedding simulation completed. Review candidate ranking and readiness before publishing.");
    } catch (error) {
      console.warn("Pre-publish simulation failed.", error);
      setSimulationError(error instanceof Error ? error.message : "Pre-publish simulation failed.");
    } finally {
      setSimulationAction(null);
    }
  };

  const handleTestDocumentChange = (file: File | null) => {
    if (testDocumentPreviewUrl) URL.revokeObjectURL(testDocumentPreviewUrl);
    setTestDocumentFile(file);
    setDetectionTest(null);
    setDetectionTestError("");
    if (file && file.type.startsWith("image/")) {
      setTestDocumentPreviewUrl(URL.createObjectURL(file));
    } else {
      setTestDocumentPreviewUrl(null);
    }
  };

  const handleRunDetectionTest = async () => {
    if (!testDocumentFile) return;
    setDetectionTestAction(true);
    setDetectionTestError("");
    setStatusMessage("");
    try {
      const result = await runPrepublishDetectionTest(templateId, testDocumentFile);
      setDetectionTest(result);
      setStatusMessage("New document detection test completed. Review unified candidate ranking before publishing.");
    } catch (error) {
      console.warn("Pre-publish new document detection test failed.", error);
      setDetectionTestError(error instanceof Error ? error.message : "New document detection test failed.");
    } finally {
      setDetectionTestAction(false);
    }
  };

  const handleConfirmPublish = async () => {
    setSimulationAction("confirm");
    setSimulationError("");
    setStatusMessage("");
    try {
      const result = await confirmTemplatePublish(templateId);
      setTemplate(result.template);
      setPublishConfirmed(true);
      setStatusMessage("Real embedding generated, stored, and template published as Active.");
    } catch (error) {
      console.warn("Template publish failed.", error);
      setSimulationError(error instanceof Error ? error.message : "Template publish failed.");
    } finally {
      setSimulationAction(null);
    }
  };

  if (loadStatus === "loading") {
    return <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500 shadow-sm">Loading draft validation...</section>;
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
            <h2 className="text-lg font-black text-slate-900">Pre-Publish Template Validation</h2>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              Draft-only validation. Detection Lab remains separate and only tests published Active templates.
            </p>
            {loadStatus === "fallback" && <p className="mt-2 text-xs font-bold text-amber-600">Showing local fallback because backend template data is unavailable.</p>}
            {statusMessage && <p className="mt-2 text-xs font-bold text-emerald-600">{statusMessage}</p>}
            {simulationError && <p className="mt-2 text-xs font-bold text-red-600">{simulationError}</p>}
          </div>
          <Link href={`/admin/templates/${templateId}/edit`} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700">
            Back to Edit Template
          </Link>
        </div>
        <div className="mt-4 grid gap-2 lg:grid-cols-5">
          {[
            [1, "Review ROI & OCR"],
            [2, "Embedding Simulation"],
            [3, "New Document Test"],
            [4, "Candidate Details"],
            [5, "Publish Review"],
          ].map(([step, label]) => (
            <button
              key={String(step)}
              type="button"
              onClick={() => setValidationStep(Number(step))}
              className={`rounded-xl border px-3 py-2 text-left text-[11px] font-black transition-colors ${
                validationStep === step
                  ? "border-indigo-500 bg-indigo-600 text-white"
                  : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-white"
              }`}
            >
              <span className="block text-[9px] uppercase opacity-75">Step {step}</span>
              {label}
            </button>
          ))}
        </div>
      </div>

      {validationStep === 1 && (
      <>
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <DraftSectionHeader title="1. Draft Template Summary" subtitle="This page validates the draft before any production embedding is saved." />
          <span className="w-fit rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">
            {template.status}
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <DraftSummaryCard label="Template Name" value={template.name} />
          <DraftSummaryCard label="Status" value={simulation?.draftSummary.status || template.status} />
          <DraftSummaryCard label="Pages" value={simulation?.draftSummary.pageCount ?? safePages.length} />
          <DraftSummaryCard label="Extraction Fields" value={simulation?.draftSummary.extractionFieldCount ?? extractionFields.length} />
          <DraftSummaryCard label="Text Anchors" value={simulation?.draftSummary.textAnchorCount ?? textAnchors.length} />
          <DraftSummaryCard label="Image Anchors" value={simulation?.draftSummary.imageAnchorCount ?? imageAnchors.length} />
          <DraftSummaryCard label="DINOv2 Model" value={simulation?.temporaryEmbedding.modelName || "Not simulated"} />
          <DraftSummaryCard label="Embedding Dimension" value={simulation?.temporaryEmbedding.embeddingDimension || "Not simulated"} />
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <DraftSectionHeader title="2. ROI & OCR Preview" subtitle="Review extraction ROI and test OCR before creating a temporary embedding." />
          <button
            type="button"
            onClick={runPreviewOcr}
            disabled={isPreviewing || extractionFields.length === 0}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white disabled:bg-slate-300 disabled:text-slate-500"
          >
            {isPreviewing ? "Previewing..." : ocrResults.length > 0 ? "Retest OCR" : "Preview OCR Fields"}
          </button>
        </div>
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
        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <WorkspaceCanvas imageSrc={currentPageImage} className="h-[560px]" onImageMetricsChange={setImageMetrics}>
            <RoiLayer
              rois={rois}
              currentPage={safeCurrentPage}
              selectedId={selectedRoiId}
              readonly
              showLabels
              onSelect={(id) => {
                const field = fields.find((item) => stableNumericId(`${item.useForVerification ? "anchor" : "field"}:${item.id}`) === id);
                if (field) setSelectedFieldId(field.id);
              }}
            />
          </WorkspaceCanvas>
          <aside className="space-y-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <h4 className="text-xs font-black text-slate-800">Page {currentPageNumber} Extraction Fields</h4>
              <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
                {currentPageFields.length === 0 ? (
                  <p className="rounded-lg bg-white p-3 text-xs font-semibold text-slate-500">No extraction fields on this page.</p>
                ) : (
                  currentPageFields.map((field) => (
                    <button
                      key={field.id}
                      type="button"
                      onClick={() => setSelectedFieldId(field.id)}
                      className={`w-full rounded-lg border p-3 text-left text-xs ${selectedFieldId === field.id ? "border-indigo-400 bg-indigo-50 text-indigo-900" : "border-slate-200 bg-white text-slate-700"}`}
                    >
                      <div className="font-black">{field.displayLabel}</div>
                      <div className="mt-1 text-[10px] font-bold text-slate-500">{field.fieldName}</div>
                      <div className="mt-1 text-[9px] font-black uppercase text-slate-400">{field.extractionMethod}</div>
                    </button>
                  ))
                )}
              </div>
            </div>
            <div className="rounded-xl border border-orange-100 bg-orange-50 p-3">
              <h4 className="text-xs font-black text-orange-900">Page {currentPageNumber} Verification Anchors</h4>
              <div className="mt-3 space-y-2">
                {currentPageAnchors.length === 0 ? (
                  <p className="text-xs font-semibold text-orange-700">No anchors on this page.</p>
                ) : (
                  currentPageAnchors.map((anchor) => (
                    <button
                      key={anchor.id}
                      type="button"
                      onClick={() => setSelectedFieldId(anchor.id)}
                      className={`w-full rounded-lg border p-3 text-left text-xs ${selectedFieldId === anchor.id ? "border-orange-400 bg-white text-orange-900" : "border-orange-100 bg-white/70 text-orange-800"}`}
                    >
                      <div className="font-black">{anchor.displayLabel}</div>
                      <div className="mt-1 text-[10px] font-bold">Expected: {anchor.expectedText || "N/A"}</div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </aside>
        </div>
        {ocrStatus && <p className="mt-3 text-xs font-bold text-slate-600">{ocrStatus}</p>}
        <div className="mt-4 space-y-4">
          {ocrResults.length === 0 ? (
            <p className="rounded-xl bg-slate-50 p-4 text-xs font-semibold text-slate-500">No OCR preview results yet.</p>
          ) : (
            Object.entries(resultsByPage).map(([pageNumber, pageResults]) => (
              <div key={pageNumber} className="rounded-xl border border-slate-200 p-3">
                <h4 className="text-xs font-black text-slate-800">Page {pageNumber}</h4>
                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {pageResults.map((result) => (
                    <div key={result.id} className="rounded-xl bg-slate-50 p-3 text-xs">
                      <div className="flex gap-3">
                        {result.roiPreviewUrl && <img src={result.roiPreviewUrl} alt="" className="h-16 w-24 rounded-lg border border-slate-200 bg-white object-contain" />}
                        <div className="min-w-0 flex-1">
                          <div className="font-black text-slate-900">{result.displayLabel}</div>
                          <div className="mt-0.5 text-[10px] font-bold text-slate-500">{result.fieldName}</div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <DraftStatusPill passed={Boolean(result.passed)} />
                            <span className="rounded-full bg-slate-200 px-2 py-1 text-[10px] font-black uppercase text-slate-600">
                              Confidence {result.confidence !== undefined ? result.confidence.toFixed(2) : "N/A"}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 rounded-lg bg-white p-2 font-semibold text-slate-700">{result.ocrText || "(empty)"}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
      </>
      )}

      {validationStep === 2 && (
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <DraftSectionHeader
            title="3. Temporary Embedding Simulation"
            subtitle="Run this after reviewing ROI and OCR preview. The temporary embedding is used only for this pre-publish test."
          />
          <button
            type="button"
            onClick={handleRunPrepublishSimulation}
            disabled={simulationAction !== null}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white disabled:bg-slate-300 disabled:text-slate-500"
          >
            {simulationAction === "run" ? "Simulating..." : simulation ? "Run Again" : "Run Simulation"}
          </button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-7">
          {prepublishSimulationSteps.map((step, index) => {
            const isDone = Boolean(simulation) || index < simulationStep;
            const isCurrent = simulationAction === "run" && index === simulationStep;
            return (
              <div
                key={step}
                className={`rounded-xl border p-3 text-xs font-black ${
                  isDone
                    ? "border-emerald-100 bg-emerald-50 text-emerald-700"
                    : isCurrent
                      ? "border-indigo-100 bg-indigo-50 text-indigo-700"
                      : "border-slate-100 bg-slate-50 text-slate-400"
                }`}
              >
                {isDone ? <CheckCircle2 size={15} /> : isCurrent ? <Info size={15} /> : <span className="block h-[15px]" />}
                <div className="mt-2">{step}</div>
              </div>
            );
          })}
        </div>
        {simulation?.temporaryEmbedding && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <DraftSummaryCard label="Status" value={simulation.temporaryEmbedding.status} />
            <DraftSummaryCard label="Model" value={simulation.temporaryEmbedding.modelName || "N/A"} />
            <DraftSummaryCard label="Engine" value={simulation.temporaryEmbedding.engine} />
            <DraftSummaryCard label="Dimension" value={simulation.temporaryEmbedding.embeddingDimension} />
            <DraftSummaryCard label="Generated" value={simulation.temporaryEmbedding.generatedAt || "N/A"} />
          </div>
        )}
      </section>
      )}

      {validationStep === 3 && (
      <>
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <DraftSectionHeader
            title="4. Test with a New Document"
            subtitle="Upload a different image or multi-page PDF to compare this draft temporary embedding against published templates."
          />
          <button
            type="button"
            onClick={handleRunDetectionTest}
            disabled={!canRunDetectionTest}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white disabled:bg-slate-300 disabled:text-slate-500"
          >
            {detectionTestAction ? "Running..." : "Run Detection Test"}
          </button>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <label className="block text-xs font-black uppercase tracking-wider text-slate-700">Test Document</label>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              onChange={(event) => handleTestDocumentChange(event.target.files?.[0] || null)}
              className="mt-3 block w-full text-xs font-semibold text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-600 file:px-3 file:py-2 file:text-xs file:font-black file:text-white"
            />
            {testDocumentFile && (
              <div className="mt-3 rounded-lg bg-white p-3 text-xs font-semibold text-slate-600">
                <div className="font-black text-slate-900">{testDocumentFile.name}</div>
                <div className="mt-1">{Math.round(testDocumentFile.size / 1024)} KB</div>
              </div>
            )}
            {testDocumentPreviewUrl ? (
              <img src={testDocumentPreviewUrl} alt="" className="mt-3 max-h-56 w-full rounded-xl border border-slate-200 bg-white object-contain" />
            ) : (
              <div className="mt-3 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-xs font-semibold text-slate-500">
                {testDocumentFile?.type === "application/pdf" ? "PDF selected. Preview will be generated by backend during test." : "PNG, JPEG, WebP, or PDF"}
              </div>
            )}
            {!simulation?.temporaryEmbedding && (
              <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-700">
                Run Temporary Embedding Simulation before testing a new document.
              </p>
            )}
          </div>

          <div className="space-y-4">
            {detectionTestError && <p className="rounded-xl bg-red-50 p-3 text-xs font-black text-red-700">{detectionTestError}</p>}
            {!detectionTest ? (
              <div className="rounded-xl bg-slate-50 p-4 text-xs font-semibold text-slate-500">
                No new document detection test has been run yet.
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <DraftSummaryCard label="Matched" value={detectionTest.matched ? "YES" : "NO"} />
                  <DraftSummaryCard label="Selected Template" value={detectionTest.selectedTemplate?.templateName || detectionTest.selectedTemplate?.templateId || "N/A"} />
                  <DraftSummaryCard label="Selected Type" value={detectionTest.selectedTemplateType || "N/A"} />
                  <DraftSummaryCard label="Final Confidence" value={formatPrepublishScore(detectionTest.finalConfidence)} />
                  <DraftSummaryCard label="Decision Reason" value={detectionTest.decisionReason || "N/A"} />
                  <DraftSummaryCard label="Draft Template Rank" value={detectionTest.draftTemplateRank ?? "N/A"} />
                  <DraftSummaryCard label="Result" value={detectionTest.passed ? "PASS" : detectionTest.warning ? "WARNING" : "FAIL"} />
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <DraftSectionHeader title="Candidate Ranking" subtitle="Draft temporary embedding and published Qdrant embeddings are ranked together." />
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-xs">
            <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Rank</th>
                <th className="px-3 py-2 text-left">Template Name</th>
                <th className="px-3 py-2 text-left">Source</th>
                <th className="px-3 py-2 text-left">Final</th>
                <th className="px-3 py-2 text-left">Retrieval</th>
                <th className="px-3 py-2 text-left">Verification</th>
                <th className="px-3 py-2 text-left">Text Anchor</th>
                <th className="px-3 py-2 text-left">Image Anchor</th>
                <th className="px-3 py-2 text-left">Decision</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {(detectionTest?.candidates || []).length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center font-semibold text-slate-500">
                    Run Detection Test to see unified candidates.
                  </td>
                </tr>
              ) : (
                detectionTest?.candidates.map((candidate) => (
                  <tr key={`${candidate.templateId}-${candidate.rank}-test`} className={candidate.isCurrentDraft ? "bg-indigo-50" : undefined}>
                    <td className="px-3 py-2 font-black text-slate-900">#{candidate.rank}</td>
                    <td className="px-3 py-2 font-bold text-slate-800">{candidate.templateName || candidate.templateId}</td>
                    <td className="px-3 py-2 font-semibold text-slate-600">
                      {candidate.isCurrentDraft ? "Draft / Temporary Embedding" : candidate.sourceLabel || "Published / Qdrant Embedding"}
                    </td>
                    <td className="px-3 py-2 font-black text-slate-900">{formatPrepublishScore(candidate.finalScore)}</td>
                    <td className="px-3 py-2">{formatPrepublishScore(candidate.globalScore)}</td>
                    <td className="px-3 py-2">{formatPrepublishScore(candidate.verificationScore)}</td>
                    <td className="px-3 py-2">{formatPrepublishScore(candidate.textAnchorScore)}</td>
                    <td className="px-3 py-2">{formatPrepublishScore(candidate.imageAnchorScore)}</td>
                    <td className="px-3 py-2">
                      <DraftStatusPill passed={candidate.finalPassed} label={candidate.decision || (candidate.finalPassed ? "PASS" : "FAIL")} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-4 space-y-3">
          {(detectionTest?.candidates || []).map((candidate) => {
            const key = `${candidate.templateId}-${candidate.rank}-detail`;
            return (
              <DraftCandidateCard
                key={key}
                candidate={candidate}
                open={Boolean(expandedDetectionCandidates[key])}
                onToggle={() => setExpandedDetectionCandidates((prev) => ({ ...prev, [key]: !prev[key] }))}
              />
            );
          })}
        </div>
      </section>
      </>
      )}

      {validationStep === 4 && (
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <DraftSectionHeader title="Candidate Details" subtitle="Open a candidate to inspect retrieval, anchor, verification, preview, and decision details." />
        <div className="mt-4 space-y-3">
          {(detectionTest?.candidates || []).length === 0 ? (
            <p className="rounded-xl bg-slate-50 p-4 text-xs font-semibold text-slate-500">Run New Document Detection Test to inspect candidate details.</p>
          ) : (
            detectionTest?.candidates.map((candidate) => {
              const key = `${candidate.templateId}-${candidate.rank}-detail-step`;
              return (
                <DraftCandidateCard
                  key={key}
                  candidate={candidate}
                  open={Boolean(expandedDetectionCandidates[key])}
                  onToggle={() => setExpandedDetectionCandidates((prev) => ({ ...prev, [key]: !prev[key] }))}
                />
              );
            })
          )}
        </div>
      </section>
      )}

      {false && (
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <DraftSectionHeader title="7. Verification Anchor Results" subtitle="Text anchors use OCR comparison. Image anchors use temporary image-feature similarity when available." />
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {(simulation?.verificationAnchorResults || []).length > 0 ? (
            (simulation?.verificationAnchorResults || []).map((anchor, index) => {
              const anchorType = String(readPrepublishValue(anchor, ["anchor_type", "type", "verification_method"]) || "text");
              const passed = Boolean(readPrepublishValue(anchor, ["passed", "final_passed"]));
              return (
                <div key={`anchor-result-${index}`} className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-black text-slate-900">{String(readPrepublishValue(anchor, ["anchor_name", "field_name", "name", "display_label"]) || `Anchor ${index + 1}`)}</div>
                      <div className="mt-1 text-[10px] font-black uppercase text-slate-400">{anchorType}</div>
                    </div>
                    <DraftStatusPill passed={passed} />
                  </div>
                  {anchorType === "image" ? (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-lg bg-white p-3">
                        <div className="text-[10px] font-black uppercase text-slate-400">Reference Preview</div>
                        {readPrepublishValue(anchor, ["reference_crop_preview_data_url", "reference_crop_preview_url"]) ? (
                          <img
                            src={String(readPrepublishValue(anchor, ["reference_crop_preview_data_url", "reference_crop_preview_url"]))}
                            alt=""
                            className="mt-2 h-28 w-full rounded-lg object-contain"
                          />
                        ) : (
                          <div className="mt-2 text-xs font-semibold text-slate-500">Preview unavailable</div>
                        )}
                      </div>
                      <div className="rounded-lg bg-white p-3">
                        <div className="text-[10px] font-black uppercase text-slate-400">Test Preview</div>
                        {readPrepublishValue(anchor, ["current_crop_preview_data_url", "current_crop_preview_url"]) ? (
                          <img
                            src={String(readPrepublishValue(anchor, ["current_crop_preview_data_url", "current_crop_preview_url"]))}
                            alt=""
                            className="mt-2 h-28 w-full rounded-lg object-contain"
                          />
                        ) : (
                          <div className="mt-2 text-xs font-semibold text-slate-500">Preview unavailable</div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <p className="rounded-lg bg-white p-3 font-semibold text-slate-700">Expected: {String(readPrepublishValue(anchor, ["expected_text", "expectedText"]) || "N/A")}</p>
                      <p className="rounded-lg bg-white p-3 font-semibold text-slate-700">OCR: {String(readPrepublishValue(anchor, ["actual_text", "ocr_text", "actualText"]) || "N/A")}</p>
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2 text-[10px] font-black uppercase text-slate-500">
                    <span className="rounded-full bg-white px-2 py-1">Similarity {formatPrepublishScore(Number(readPrepublishValue(anchor, ["dino_similarity_score", "similarity_score", "score", "field_score"]) || 0))}</span>
                    <span className="rounded-full bg-white px-2 py-1">Weight {String(readPrepublishValue(anchor, ["weight", "verification_weight"]) || "N/A")}</span>
                    {readPrepublishValue(anchor, ["embedding_id"]) && (
                      <span className="rounded-full bg-white px-2 py-1">{String(readPrepublishValue(anchor, ["embedding_id"]))}</span>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <p className="rounded-xl bg-slate-50 p-4 text-xs font-semibold text-slate-500 lg:col-span-2">Run Simulation to see verification anchor results.</p>
          )}
        </div>
      </section>
      )}

      {validationStep === 5 && (
      <>
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <DraftSectionHeader title="Template Separation" subtitle="Final separation summary before publishing." />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <DraftSummaryCard label="Closest Existing Template" value={simulation?.separationAnalysis.conflictTemplates[0]?.templateName || "N/A"} />
          <DraftSummaryCard label="Similarity" value={formatPrepublishScore(simulation?.separationAnalysis.conflictTemplates[0]?.finalScore)} />
          <DraftSummaryCard label="Conflict Detection" value={(simulation?.separationAnalysis.status || "not_ready").replaceAll("_", " ")} />
          <DraftSummaryCard label="Recommendation" value={simulation?.separationAnalysis.message || (simulationPassed ? "Ready" : "Run Simulation")} />
        </div>
        {detectionTest && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <DraftSummaryCard label="New Doc Draft Rank" value={detectionTest.separationResult.draftTemplateRank ?? "N/A"} />
            <DraftSummaryCard label="Draft Final Score" value={formatPrepublishScore(detectionTest.separationResult.draftFinalScore)} />
            <DraftSummaryCard label="Closest Published" value={detectionTest.separationResult.closestPublishedTemplate || "N/A"} />
            <DraftSummaryCard label="Closest Published Score" value={formatPrepublishScore(detectionTest.separationResult.closestPublishedScore)} />
            <DraftSummaryCard label="New Doc Recommendation" value={detectionTest.separationResult.recommendation || "N/A"} />
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <DraftSectionHeader title="Publish Review" subtitle="Final checklist before generating permanent embeddings and publishing." />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[
            ["Extraction Fields", extractionFields.length > 0 && (ocrResults.length === 0 || ocrResults.every((result) => Boolean(result.passed)))],
            ["Verification Anchors", verificationAnchors.length > 0],
            ["Global Retrieval", topCandidates.length > 0],
            ["Temporary Embedding", Boolean(simulation?.temporaryEmbedding && !simulation.temporaryEmbedding.persisted)],
            ["New Document Test", detectionTestPassed],
            ["Template Separation", simulationPassed],
            ["Overall", overallReady],
          ].map(([label, passed]) => (
            <div key={String(label)} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 p-3">
              <span className="text-xs font-black text-slate-800">{String(label)}</span>
              <DraftStatusPill passed={Boolean(passed)} label={Boolean(passed) ? "PASS" : "WAIT"} />
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h4 className="text-xs font-black uppercase tracking-wider text-slate-700">
                {overallReady ? "READY TO PUBLISH" : "NOT READY"}
              </h4>
              <p className="mt-2 text-xs font-semibold text-slate-500">
                Confirm generates the real global embedding, permanent image-anchor embeddings, vector-store entry, and publishes only after every operation succeeds.
              </p>
              {!simulationPassed && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-700">Run Simulation must pass before publishing.</p>}
              {simulationPassed && !detectionTest && (
                <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-700">
                  Run at least one New Document Detection Test before publishing.
                </p>
              )}
              {detectionTest && !detectionTestPassed && (
                <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-700">
                  Warning: the draft template did not clearly rank first in the new document test. Review the candidate ranking before publishing.
                </p>
              )}
              {publishConfirmed && <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-xs font-black text-emerald-700">Template published successfully.</p>}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                onClick={handleConfirmPublish}
                disabled={!canConfirmPublish}
                className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-black text-emerald-700 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
              >
                {simulationAction === "confirm" ? "Publishing..." : "Confirm and Generate Real Embedding"}
              </button>
              <button
                type="button"
                onClick={handleConfirmPublish}
                disabled={!canConfirmPublish}
                className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-black text-white disabled:bg-slate-300 disabled:text-slate-500"
              >
                {template.status === "active" ? "Publish Template Complete" : "Publish Template"}
              </button>
            </div>
          </div>
        </div>
      </section>
      </>
      )}
    </section>
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

function LegacyAdminTemplateTestPage({ templateId }: { templateId: string }) {
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
  const [simulation, setSimulation] = useState<PrepublishSimulationResult | null>(null);
  const [simulationAction, setSimulationAction] = useState<"run" | "confirm" | null>(null);
  const [simulationError, setSimulationError] = useState("");
  const [publishConfirmed, setPublishConfirmed] = useState(false);

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
  const canConfirmPrepublish = Boolean(
    simulation?.separationAnalysis.simulationPassed &&
      template?.status !== "active" &&
      simulationAction !== "run" &&
      simulationAction !== "confirm"
  );

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

  const handleRunPrepublishSimulation = async () => {
    setSimulationAction("run");
    setSimulationError("");
    setStatusMessage("");
    setStatusError("");
    setPublishConfirmed(false);
    try {
      const result = await runPrepublishSimulation(templateId);
      setSimulation(result);
      setTemplate(result.template);
      setStatusMessage("Pre-publish simulation completed. Review the ranking before publishing.");
    } catch (error) {
      console.warn("Pre-publish simulation failed.", error);
      setSimulationError(error instanceof Error ? error.message : "Pre-publish simulation failed.");
    } finally {
      setSimulationAction(null);
    }
  };

  const handleConfirmPublish = async () => {
    setSimulationAction("confirm");
    setSimulationError("");
    setStatusMessage("");
    setStatusError("");
    try {
      const result = await confirmTemplatePublish(templateId);
      setLatestEmbeddingJob(result.job);
      setTemplate(result.template);
      setPublishConfirmed(true);
      setStatusMessage("Real embedding generated and template published as Active.");
    } catch (error) {
      console.warn("Template publish failed.", error);
      setSimulationError(error instanceof Error ? error.message : "Template publish failed.");
    } finally {
      setSimulationAction(null);
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
            <h2 className="text-lg font-black text-slate-900">Pre-Publish Template Validation</h2>
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
          </div>
        </div>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Draft Template Summary</h3>
            <p className="mt-1 text-sm font-black text-slate-900">{simulation?.draftSummary.templateName || template.name}</p>
            <p className="mt-1 text-[11px] font-semibold text-slate-500">Template ID: {template.id}</p>
          </div>
          <span className="w-fit rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">
            {simulation?.draftSummary.status || template.status}
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Pages", simulation?.draftSummary.pageCount ?? pages.length],
            ["Extraction Fields", simulation?.draftSummary.extractionFieldCount ?? fields.filter((field) => !field.useForVerification).length],
            ["Text Anchors", simulation?.draftSummary.textAnchorCount ?? fields.filter((field) => field.useForVerification && field.dataType !== "image").length],
            ["Image Anchors", simulation?.draftSummary.imageAnchorCount ?? fields.filter((field) => field.useForVerification && field.dataType === "image").length],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</div>
              <div className="mt-1 text-xl font-black text-slate-900">{value}</div>
            </div>
          ))}
        </div>
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

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-4">
          <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Test With Unseen Document Before Publish</h3>
          <p className="mt-1 text-[11px] font-semibold text-slate-500">
            Draft templates are not visible to the production detection pipeline until they are published.
          </p>
        </div>
        <div className="rounded-xl border border-amber-100 bg-amber-50 p-4 text-xs font-semibold text-amber-800">
          This step is disabled for Draft templates. Use the separate Detection Lab after publishing, when the template is Active and stored in the production vector store.
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Temporary Embedding Simulation</h3>
            <p className="mt-1 text-[11px] font-semibold text-slate-500">
              Run this after ROI and OCR preview. The temporary embedding is used only for this pre-publish test.
            </p>
            {simulation?.temporaryEmbedding ? (
              <div className="mt-3 grid gap-2 text-xs font-semibold text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
                <p>Model: {simulation.temporaryEmbedding.modelName || "N/A"}</p>
                <p>Engine: {simulation.temporaryEmbedding.engine}</p>
                <p>Dimension: {simulation.temporaryEmbedding.embeddingDimension}</p>
                <p>Generated: {simulation.temporaryEmbedding.generatedAt || "N/A"}</p>
              </div>
            ) : (
              <p className="mt-3 text-xs font-semibold text-slate-500">No simulation has been run yet.</p>
            )}
            {simulationError && <p className="mt-3 rounded-xl bg-red-50 p-3 text-xs font-black text-red-700">{simulationError}</p>}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              onClick={handleRunPrepublishSimulation}
              disabled={simulationAction !== null}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white disabled:bg-slate-300 disabled:text-slate-500"
            >
              {simulationAction === "run" ? "Simulating..." : simulation ? "Run Again" : "Run Simulation"}
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Publish Confirmation</h3>
            <p className="mt-2 text-xs font-semibold text-slate-500">
              Publish is enabled only after the simulation passes. Confirmation creates the real embedding, stores it in the production vector store, and marks the template Active.
            </p>
            {!simulation?.separationAnalysis.simulationPassed && (
              <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-700">
                Run Simulation must pass before publishing.
              </p>
            )}
            {publishConfirmed && <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-xs font-black text-emerald-700">Template published successfully.</p>}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              onClick={handleConfirmPublish}
              disabled={!canConfirmPrepublish}
              className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-black text-emerald-700 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
            >
              {simulationAction === "confirm" ? "Publishing..." : "Confirm and Generate Real Embedding"}
            </button>
            <button type="button" disabled className="rounded-xl bg-slate-300 px-4 py-2 text-xs font-black text-slate-500">
              Publish {template.status === "active" ? "Complete" : "Locked"}
            </button>
          </div>
        </div>
      </section>

    </section>
  );
}
