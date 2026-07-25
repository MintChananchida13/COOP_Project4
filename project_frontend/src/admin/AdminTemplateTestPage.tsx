"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Info, XCircle } from "lucide-react";
import RoiLayer from "../shared/workspace/RoiLayer";
import { WorkspaceRoi } from "../shared/workspace/RoiBox";
import WorkspaceCanvas from "../shared/workspace/WorkspaceCanvas";
import { DEFAULT_WORKSPACE_IMAGE_METRICS, ratioToImageBox, WorkspaceImageMetrics } from "../shared/workspace/roiGeometry";
import { IgnoreRegion, Template, TemplateField, TemplatePage } from "../types/ocr";
import {
  ADMIN_API_BASE_URL,
  PrepublishCandidate,
  PrepublishDetectionTestResult,
  PrepublishSimulationResult,
  confirmTemplatePublish,
  fetchTemplateBundle,
  runPrepublishDetectionTest,
  runPrepublishSimulation,
  updateTemplateApi,
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

const DEFAULT_FINAL_CONFIDENCE_THRESHOLD = 0.75;
const DEFAULT_MATCHING_WEIGHTS = {
  layoutWeight: 0.4,
  textAnchorWeight: 0.3,
  imageAnchorWeight: 0.3,
};

const stableNumericId = (value: string) =>
  Math.abs(value.split("").reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7));

const clampUnit = (value: number) => Math.max(0, Math.min(1, value));

const readMatchingWeights = (weights: {
  layoutWeight?: number | null;
  textAnchorWeight?: number | null;
  imageAnchorWeight?: number | null;
}) => ({
  layoutWeight: clampUnit(Number.isFinite(weights.layoutWeight) ? Number(weights.layoutWeight) : DEFAULT_MATCHING_WEIGHTS.layoutWeight),
  textAnchorWeight: clampUnit(Number.isFinite(weights.textAnchorWeight) ? Number(weights.textAnchorWeight) : DEFAULT_MATCHING_WEIGHTS.textAnchorWeight),
  imageAnchorWeight: clampUnit(Number.isFinite(weights.imageAnchorWeight) ? Number(weights.imageAnchorWeight) : DEFAULT_MATCHING_WEIGHTS.imageAnchorWeight),
});

const normalizeMatchingWeights = (weights: {
  layoutWeight?: number | null;
  textAnchorWeight?: number | null;
  imageAnchorWeight?: number | null;
}) => {
  const raw = readMatchingWeights(weights);
  const total = raw.layoutWeight + raw.textAnchorWeight + raw.imageAnchorWeight;
  if (total <= 0) return DEFAULT_MATCHING_WEIGHTS;
  return {
    layoutWeight: Number((raw.layoutWeight / total).toFixed(4)),
    textAnchorWeight: Number((raw.textAnchorWeight / total).toFixed(4)),
    imageAnchorWeight: Number((raw.imageAnchorWeight / total).toFixed(4)),
  };
};

const formatWeightPercent = (value: number) => `${Math.round(value * 100)}%`;

const roundWeight = (value: number) => Number(clampUnit(value).toFixed(4));

const calculateMatchingWeights = ({
  layoutWeight,
  textAnchorCount,
  imageAnchorCount,
  preferredTextWeight,
}: {
  layoutWeight: number;
  textAnchorCount: number;
  imageAnchorCount: number;
  preferredTextWeight?: number;
}) => {
  const hasText = textAnchorCount > 0;
  const hasImage = imageAnchorCount > 0;
  if (!hasText && !hasImage) {
    return { layoutWeight: 1, textAnchorWeight: 0, imageAnchorWeight: 0 };
  }

  const layout = roundWeight(Math.max(0.3, Math.min(0.5, layoutWeight)));
  const remaining = roundWeight(1 - layout);
  if (hasText && hasImage) {
    const text = preferredTextWeight === undefined
      ? roundWeight(remaining / 2)
      : roundWeight(Math.max(0, Math.min(remaining, preferredTextWeight)));
    return {
      layoutWeight: layout,
      textAnchorWeight: text,
      imageAnchorWeight: roundWeight(remaining - text),
    };
  }
  if (hasText) return { layoutWeight: layout, textAnchorWeight: remaining, imageAnchorWeight: 0 };
  return { layoutWeight: layout, textAnchorWeight: 0, imageAnchorWeight: remaining };
};

const fieldToRoi = (field: TemplateField, metrics: WorkspaceImageMetrics): WorkspaceRoi & { kind: string; pageNumber: number } => {
  const box = ratioToImageBox(field.roi, metrics);
  const isAnchor = field.useForVerification;
  return {
    id: stableNumericId(`${isAnchor ? "anchor" : "field"}:${field.id}`),
    fieldName: field.displayLabel || field.fieldName,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    pageIndex: field.pageNumber - 1,
    pageNumber: field.pageNumber,
    kind: isAnchor ? "verification_anchor" : "extraction_field",
    type: field.dataType === "table" ? "table" : field.dataType === "image" ? "image" : "text",
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
  "Generate Layout Signature",
  "Searching Layout Candidates",
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

const isImageVerificationRecord = (record: Record<string, unknown>) => {
  const typeText = String(readPrepublishValue(record, ["anchor_type", "verification_method", "match_type", "type"]) || "").toLowerCase();
  return typeText.includes("image");
};

const readVerificationRecordScore = (record: Record<string, unknown>) => {
  const value = isImageVerificationRecord(record)
    ? readPrepublishValue(record, ["evidence_score", "image_category_score", "field_score", "score"])
    : readPrepublishValue(record, ["text_match_score", "field_score", "score", "similarity_score", "text_similarity_score"]);
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
};

function DraftSummaryCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
      <div className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</div>
      <div className="mt-1 text-lg font-black text-slate-900">{value}</div>
    </div>
  );
}

function DraftOverviewMetric({ label, value, tone = "slate" }: { label: string; value: string | number; tone?: "slate" | "indigo" | "orange" | "emerald" }) {
  const toneClass = {
    slate: "border-slate-200 bg-slate-50 text-slate-900",
    indigo: "border-indigo-100 bg-indigo-50 text-indigo-950",
    orange: "border-orange-100 bg-orange-50 text-orange-950",
    emerald: "border-emerald-100 bg-emerald-50 text-emerald-950",
  }[tone];
  const labelClass = {
    slate: "text-slate-500",
    indigo: "text-indigo-600",
    orange: "text-orange-700",
    emerald: "text-emerald-700",
  }[tone];
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${toneClass}`}>
      <div className={`text-[9px] font-black uppercase tracking-wider ${labelClass}`}>{label}</div>
      <div className="mt-1 truncate text-sm font-black">{value}</div>
    </div>
  );
}

function MatchingWeightsPanel({
  matchingWeights,
  effectiveMatchingWeights,
  textAnchorCount,
  imageAnchorCount,
  onLayoutChange,
  onTextChange,
  onImageChange,
  onWeightBlur,
  onUseRecommended,
}: {
  matchingWeights: typeof DEFAULT_MATCHING_WEIGHTS;
  effectiveMatchingWeights: typeof DEFAULT_MATCHING_WEIGHTS;
  textAnchorCount: number;
  imageAnchorCount: number;
  onLayoutChange: (value: number) => void;
  onTextChange: (value: number) => void;
  onImageChange: (value: number) => void;
  onWeightBlur: () => void;
  onUseRecommended: () => void;
}) {
  const hasText = textAnchorCount > 0;
  const hasImage = imageAnchorCount > 0;
  const hasAnyAnchor = hasText || hasImage;
  const remaining = Math.round((1 - effectiveMatchingWeights.layoutWeight) * 100);
  const layoutPercent = Math.round(effectiveMatchingWeights.layoutWeight * 100);
  const textPercent = Math.round(effectiveMatchingWeights.textAnchorWeight * 100);
  const imagePercent = Math.round(effectiveMatchingWeights.imageAnchorWeight * 100);
  const textImageLocked = hasText && hasImage;
  const layoutOptions = [30, 35, 40, 45, 50];

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-700">Matching Weights</h4>
          <p className="mt-1 text-[11px] font-semibold leading-relaxed text-slate-500">
            กำหนดน้ำหนัก Layout แล้วระบบจะคำนวณส่วนที่เหลือให้ Text/Image Anchors อัตโนมัติ
          </p>
        </div>
        <button
          type="button"
          onClick={onUseRecommended}
          className="ui-stable-action rounded-xl border border-slate-200 bg-white px-3 py-2 text-[10px] font-black text-slate-700 hover:border-indigo-200 hover:text-indigo-700"
        >
          ใช้ค่าแนะนำ
        </button>
      </div>

      <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="block min-w-36">
            <span className="block text-[10px] font-black uppercase tracking-wider text-slate-500">Layout</span>
            <select
              value={layoutPercent}
              disabled={!hasAnyAnchor}
              onChange={(event) => onLayoutChange(Number(event.target.value) / 100)}
              onBlur={onWeightBlur}
              className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-black text-slate-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
            >
              {hasAnyAnchor ? layoutOptions.map((value) => <option key={value} value={value}>{value}%</option>) : <option value={100}>100%</option>}
            </select>
          </label>
          <input
            type="range"
            min={hasAnyAnchor ? 30 : 100}
            max={hasAnyAnchor ? 50 : 100}
            step={5}
            value={layoutPercent}
            disabled={!hasAnyAnchor}
            onChange={(event) => onLayoutChange(Number(event.target.value) / 100)}
            onMouseUp={onWeightBlur}
            onTouchEnd={onWeightBlur}
            className="w-full accent-indigo-600 disabled:opacity-50"
          />
        </div>
        <p className="mt-2 text-[10px] font-semibold text-slate-500">
          Layout can be 30-50% in 5% steps. Remaining is {remaining}%.
        </p>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <label className="block rounded-lg border border-slate-100 bg-slate-50 p-3">
          <span className="block text-[10px] font-black uppercase tracking-wider text-slate-500">Text</span>
          <input
            type="range"
            min="0"
            max={remaining}
            step="1"
            value={textPercent}
            disabled={!hasText || !textImageLocked}
            onChange={(event) => onTextChange(Number(event.target.value) / 100)}
            onMouseUp={onWeightBlur}
            onTouchEnd={onWeightBlur}
            className="mt-3 w-full accent-emerald-600 disabled:opacity-50"
          />
          <span className="mt-1 block text-sm font-black text-slate-800">{textPercent}%</span>
          <span className="mt-1 block text-[10px] font-semibold text-slate-500">
            {!hasText ? "No Text Anchor" : textImageLocked ? "Moving Text updates Image automatically" : "Uses all Remaining"}
          </span>
        </label>

        <label className="block rounded-lg border border-slate-100 bg-slate-50 p-3">
          <span className="block text-[10px] font-black uppercase tracking-wider text-slate-500">Image</span>
          <input
            type="range"
            min="0"
            max={remaining}
            step="1"
            value={imagePercent}
            disabled={!hasImage || !textImageLocked}
            onChange={(event) => onImageChange(Number(event.target.value) / 100)}
            onMouseUp={onWeightBlur}
            onTouchEnd={onWeightBlur}
            className="mt-3 w-full accent-sky-600 disabled:opacity-50"
          />
          <span className="mt-1 block text-sm font-black text-slate-800">{imagePercent}%</span>
          <span className="mt-1 block text-[10px] font-semibold text-slate-500">
            {!hasImage ? "No Image Anchor" : textImageLocked ? "Moving Image updates Text automatically" : "Uses all Remaining"}
          </span>
        </label>
      </div>

      <div className="mt-3 rounded-lg bg-indigo-50 px-3 py-2 text-[11px] font-bold text-indigo-800">
        Effective Matching Weights: Layout {formatWeightPercent(effectiveMatchingWeights.layoutWeight)} / Text {formatWeightPercent(effectiveMatchingWeights.textAnchorWeight)} / Image {formatWeightPercent(effectiveMatchingWeights.imageAnchorWeight)}
        {!hasAnyAnchor && <span className="block text-[10px] text-indigo-600">No Text/Image Anchor. Layout is 100%.</span>}
        {hasText && hasImage && <span className="block text-[10px] text-indigo-600">Text + Image always equals Remaining.</span>}
      </div>
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
            <span>Layout {formatPrepublishScore(candidate.globalScore)}</span>
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
            <DraftSummaryCard label="Alignment" value={candidate.alignmentStatus || "N/A"} />
            <DraftSummaryCard label="Verification Image" value={candidate.verificationSourceUsed || "N/A"} />
            <DraftSummaryCard label="Alignment Reason" value={candidate.alignmentReason || "N/A"} />
          </div>
          {candidate.alignmentDetails && candidate.alignmentDetails.length > 0 && (
            <details className="mt-4 rounded-xl bg-slate-50 p-3 text-xs">
              <summary className="cursor-pointer text-[10px] font-black uppercase tracking-wider text-slate-500">
                Alignment Details
              </summary>
              <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-white p-3 text-[10px] font-semibold text-slate-600">
                {JSON.stringify(candidate.alignmentDetails, null, 2)}
              </pre>
            </details>
          )}
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
                            {formatPrepublishScore(readVerificationRecordScore(detail))}
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
                      <span>Score {formatPrepublishScore(readVerificationRecordScore(detail))}</span>
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
  const [anchorPreviewResults, setAnchorPreviewResults] = useState<OcrPreviewResult[]>([]);
  const [ocrStatus, setOcrStatus] = useState("");
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [simulation, setSimulation] = useState<PrepublishSimulationResult | null>(null);
  const [simulationAction, setSimulationAction] = useState<"run" | "confirm" | null>(null);
  const [simulationStep, setSimulationStep] = useState(0);
  const [simulationError, setSimulationError] = useState("");
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
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
  const anchorPreviewsByPage = anchorPreviewResults.reduce<Record<number, OcrPreviewResult[]>>((acc, result) => {
    acc[result.pageNumber] = [...(acc[result.pageNumber] || []), result];
    return acc;
  }, {});
  const simulationPassed = Boolean(simulation?.separationAnalysis.simulationPassed);
  const detectionTestPassed = Boolean(detectionTest?.passed && detectionTest.draftTemplateRank === 1);
  const publishPrerequisitesMet = Boolean(simulationPassed && detectionTestPassed);
  const overallReady = publishPrerequisitesMet;
  const ocrPreviewPassed = Boolean(
    extractionFields.length > 0 &&
      ocrResults.length > 0 &&
      ocrResults.every((result) => Boolean(result.passed))
  );
  const canRunDetectionTest = Boolean(simulationPassed && simulationAction === null && testDocumentFile && !detectionTestAction);
  const canConfirmPublish = publishPrerequisitesMet && simulationAction === null && template?.status !== "active";
  const finalConfidenceThreshold = typeof template?.finalConfidenceThreshold === "number" && Number.isFinite(template.finalConfidenceThreshold)
    ? template.finalConfidenceThreshold
    : DEFAULT_FINAL_CONFIDENCE_THRESHOLD;
  const matchingWeights = useMemo(() => {
    const configured = readMatchingWeights({
      layoutWeight: template?.layoutWeight,
      textAnchorWeight: template?.textAnchorWeight,
      imageAnchorWeight: template?.imageAnchorWeight,
    });
    return calculateMatchingWeights({
      layoutWeight: configured.layoutWeight,
      textAnchorCount: textAnchors.length,
      imageAnchorCount: imageAnchors.length,
      preferredTextWeight: configured.textAnchorWeight,
    });
  }, [imageAnchors.length, template?.imageAnchorWeight, template?.layoutWeight, template?.textAnchorWeight, textAnchors.length]);
  const effectiveMatchingWeights = matchingWeights;
  const validationSteps = [
    { step: 1, label: "Review ROI & OCR", enabled: true, done: ocrPreviewPassed },
    { step: 2, label: "Layout Simulation", enabled: ocrPreviewPassed, done: simulationPassed },
    { step: 3, label: "New Document Test", enabled: simulationPassed, done: Boolean(detectionTest) },
    { step: 4, label: "Publish Review", enabled: Boolean(detectionTest), done: overallReady },
  ];
  const layoutSignaturePages =
    simulation?.layoutSignaturePages?.length
      ? simulation.layoutSignaturePages
      : simulation?.temporaryEmbedding.layoutSignaturePages?.length
        ? simulation.temporaryEmbedding.layoutSignaturePages
        : safePages.map((page) => ({
            templatePageId: page.id,
            pageNumber: page.pageNumber,
            status: simulationAction === "run" ? "running" : "pending",
            engine: "layout_signature",
            version: null,
            modelName: null,
            labelCount: null,
            imageUrl: page.normalizedImageUrl || page.sampleImageUrl || samplePage,
            persisted: false,
            reason: null,
          }));
  const goToValidationStep = (step: number) => {
    const target = validationSteps.find((item) => item.step === step);
    if (!target?.enabled) return;
    setValidationStep(step);
  };

  const runPreviewOcr = async () => {
    setIsPreviewing(true);
    setOcrStatus("Running OCR on extraction fields...");
    setOcrResults([]);
    setAnchorPreviewResults([]);

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
      const nextAnchorPreviews: OcrPreviewResult[] = [];
      for (const anchor of verificationAnchors) {
        const page = safePages.find((item) => item.pageNumber === anchor.pageNumber);
        const imageSrc = page?.normalizedImageUrl || page?.sampleImageUrl || samplePage;
        const roiPreviewUrl = await cropFieldPreview(imageSrc, anchor);
        const isImageAnchor = anchor.dataType === "image";
        nextAnchorPreviews.push({
          id: anchor.id,
          pageNumber: anchor.pageNumber,
          fieldName: anchor.fieldName,
          displayLabel: anchor.displayLabel,
          extractionMethod: isImageAnchor ? "image_feature" : "ocr_text",
          ocrText: isImageAnchor ? "(image anchor crop ready)" : anchor.expectedText || "",
          roiPreviewUrl: roiPreviewUrl || undefined,
          expectedText: anchor.expectedText || undefined,
          verificationStatus: isImageAnchor || anchor.expectedText?.trim() ? "pass" : "not_configured",
          passed: Boolean(roiPreviewUrl && (isImageAnchor || anchor.expectedText?.trim())),
        });
      }
      setAnchorPreviewResults(nextAnchorPreviews);
      setOcrStatus(`OCR preview complete for ${nextResults.length} extraction fields and ${nextAnchorPreviews.length} verification anchors.`);
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
      setStatusMessage("Temporary layout signature simulation completed. Review candidate ranking and readiness before publishing.");
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
      setStatusMessage("Layout signature generated, image anchors validated with SigLIP, and template published as Active.");
    } catch (error) {
      console.warn("Template publish failed.", error);
      setSimulationError(error instanceof Error ? error.message : "Template publish failed.");
    } finally {
      setSimulationAction(null);
    }
  };

  const persistFinalConfidenceThreshold = async () => {
    if (!template) return;
    const nextThreshold = Math.max(0, Math.min(1, finalConfidenceThreshold));
    setStatusMessage("");
    setSimulationError("");
    try {
      const bundle = await updateTemplateApi(templateId, { finalConfidenceThreshold: nextThreshold });
      setTemplate(bundle.template);
      setPages(bundle.pages);
      setFields(bundle.fields);
      setStatusMessage("Final confidence threshold saved.");
    } catch (error) {
      console.warn("Final confidence threshold save failed.", error);
      setSimulationError(error instanceof Error ? error.message : "Final confidence threshold save failed.");
    }
  };

  const updateMatchingWeightsDraft = (weights: typeof DEFAULT_MATCHING_WEIGHTS) => {
    setTemplate((current) => current ? { ...current, ...weights } : current);
  };

  const updateLayoutWeightDraft = (value: number) => {
    updateMatchingWeightsDraft(calculateMatchingWeights({
      layoutWeight: Number.isFinite(value) ? value : DEFAULT_MATCHING_WEIGHTS.layoutWeight,
      textAnchorCount: textAnchors.length,
      imageAnchorCount: imageAnchors.length,
    }));
  };

  const updateTextWeightDraft = (value: number) => {
    updateMatchingWeightsDraft(calculateMatchingWeights({
      layoutWeight: matchingWeights.layoutWeight,
      textAnchorCount: textAnchors.length,
      imageAnchorCount: imageAnchors.length,
      preferredTextWeight: value,
    }));
  };

  const updateImageWeightDraft = (value: number) => {
    const remaining = 1 - matchingWeights.layoutWeight;
    updateMatchingWeightsDraft(calculateMatchingWeights({
      layoutWeight: matchingWeights.layoutWeight,
      textAnchorCount: textAnchors.length,
      imageAnchorCount: imageAnchors.length,
      preferredTextWeight: Math.max(0, remaining - value),
    }));
  };

  const persistMatchingWeights = async (weights = matchingWeights) => {
    if (!template) return;
    const configured = calculateMatchingWeights({
      layoutWeight: weights.layoutWeight,
      textAnchorCount: textAnchors.length,
      imageAnchorCount: imageAnchors.length,
      preferredTextWeight: weights.textAnchorWeight,
    });
    const nextWeights = configured;
    setStatusMessage("");
    setSimulationError("");
    try {
      const bundle = await updateTemplateApi(templateId, nextWeights);
      setTemplate(bundle.template);
      setPages(bundle.pages);
      setFields(bundle.fields);
      setStatusMessage("Matching weights saved.");
    } catch (error) {
      console.warn("Matching weights save failed.", error);
      setSimulationError(error instanceof Error ? error.message : "Matching weights save failed.");
    }
  };

  const applyRecommendedMatchingWeights = async () => {
    const recommended = calculateMatchingWeights({
      layoutWeight: DEFAULT_MATCHING_WEIGHTS.layoutWeight,
      textAnchorCount: textAnchors.length,
      imageAnchorCount: imageAnchors.length,
    });
    updateMatchingWeightsDraft(recommended);
    await persistMatchingWeights(recommended);
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
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {validationSteps.map(({ step, label, enabled, done }) => (
            <button
              key={step}
              type="button"
              onClick={() => goToValidationStep(step)}
              disabled={!enabled}
              className={`rounded-xl border px-3 py-2 text-left text-[11px] font-black transition-colors ${
                validationStep === step
                  ? "border-indigo-500 bg-indigo-600 text-white"
                  : enabled
                    ? done
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-white"
                      : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-white"
                    : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
              }`}
            >
              <span className="block text-[9px] uppercase opacity-75">Step {step}</span>
              <span className="block">{label}</span>
              <span className="mt-1 block text-[9px] uppercase opacity-70">{done ? "Done" : enabled ? "Ready" : "Locked"}</span>
            </button>
          ))}
        </div>
      </div>

      {validationStep === 1 && (
      <>
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <DraftSectionHeader title="Draft Template Summary" subtitle="ตรวจสอบข้อมูลหลักของ Draft Template ก่อนทดสอบ OCR และ Simulation." />
          <span className="w-fit rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-black uppercase tracking-wide text-slate-700">
            {template.status}
          </span>
        </div>
        <div className="mt-4 rounded-xl border border-slate-100 bg-white p-3">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <DraftOverviewMetric label="Template Name" value={template.name} />
            <DraftOverviewMetric label="Status" value={simulation?.draftSummary.status || template.status} tone="emerald" />
            <DraftOverviewMetric label="Pages" value={simulation?.draftSummary.pageCount ?? safePages.length} />
            <DraftOverviewMetric label="Extraction Fields" value={simulation?.draftSummary.extractionFieldCount ?? extractionFields.length} tone="indigo" />
            <DraftOverviewMetric label="Text Anchors" value={simulation?.draftSummary.textAnchorCount ?? textAnchors.length} tone="orange" />
            <DraftOverviewMetric label="Image Anchors" value={simulation?.draftSummary.imageAnchorCount ?? imageAnchors.length} tone="orange" />
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-700">Decision Settings</h4>
              <p className="mt-1 text-[11px] font-semibold text-slate-500">
                ใช้เป็นเกณฑ์ตัดสิน Final Score ในขั้น New Document Test และตอน Publish
              </p>
            </div>
            <label className="block w-full max-w-xs space-y-1">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Final Confidence Threshold</span>
              <input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={finalConfidenceThreshold}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setTemplate((current) => current ? { ...current, finalConfidenceThreshold: Number.isFinite(value) ? value : DEFAULT_FINAL_CONFIDENCE_THRESHOLD } : current);
                }}
                onBlur={persistFinalConfidenceThreshold}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-black text-slate-800"
              />
              <span className="block text-[10px] font-semibold text-slate-500">ค่าเริ่มต้นที่แนะนำ: 0.75</span>
            </label>
          </div>
        </div>
      </section>

      <MatchingWeightsPanel
        matchingWeights={matchingWeights}
        effectiveMatchingWeights={effectiveMatchingWeights}
        textAnchorCount={textAnchors.length}
        imageAnchorCount={imageAnchors.length}
        onLayoutChange={updateLayoutWeightDraft}
        onTextChange={updateTextWeightDraft}
        onImageChange={updateImageWeightDraft}
        onWeightBlur={() => persistMatchingWeights()}
        onUseRecommended={applyRecommendedMatchingWeights}
      />

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <DraftSectionHeader title="ROI & OCR Preview" subtitle="ต้อง Preview OCR ให้ผ่านก่อน จึงจะไปขั้น Simulation ได้." />
          <button
            type="button"
            onClick={runPreviewOcr}
            disabled={isPreviewing || extractionFields.length === 0}
            className="ui-stable-action-lg rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white disabled:bg-slate-300 disabled:text-slate-500"
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
            <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-black text-indigo-950">Page {currentPageNumber} Extraction Fields</h4>
                <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[9px] font-black uppercase text-white">Blue ROI</span>
              </div>
              <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
                {currentPageFields.length === 0 ? (
                  <p className="rounded-lg bg-white p-3 text-xs font-semibold text-indigo-500">No extraction fields on this page.</p>
                ) : (
                  currentPageFields.map((field) => (
                    <button
                      key={field.id}
                      type="button"
                      onClick={() => setSelectedFieldId(field.id)}
                      className={`w-full rounded-lg border p-3 text-left text-xs transition-colors ${
                        selectedFieldId === field.id
                          ? "border-indigo-500 bg-white text-indigo-950 shadow-sm ring-2 ring-indigo-200"
                          : "border-indigo-100 bg-white/85 text-indigo-900 hover:border-indigo-300"
                      }`}
                    >
                      <div className="font-black">{field.displayLabel}</div>
                      <div className="mt-1 text-[10px] font-bold text-indigo-500">{field.fieldName}</div>
                      <div className="mt-2 w-fit rounded-full bg-indigo-100 px-2 py-0.5 text-[9px] font-black uppercase text-indigo-700">{field.extractionMethod}</div>
                    </button>
                  ))
                )}
              </div>
            </div>
            <div className="rounded-xl border border-orange-200 bg-orange-50/80 p-3">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-black text-orange-950">Page {currentPageNumber} Verification Anchors</h4>
                <span className="rounded-full bg-orange-600 px-2 py-0.5 text-[9px] font-black uppercase text-white">Orange ROI</span>
              </div>
              <div className="mt-3 space-y-2">
                {currentPageAnchors.length === 0 ? (
                  <p className="text-xs font-semibold text-orange-700">No anchors on this page.</p>
                ) : (
                  currentPageAnchors.map((anchor) => (
                    <button
                      key={anchor.id}
                      type="button"
                      onClick={() => setSelectedFieldId(anchor.id)}
                      className={`w-full rounded-lg border p-3 text-left text-xs transition-colors ${
                        selectedFieldId === anchor.id
                          ? "border-orange-500 bg-white text-orange-950 shadow-sm ring-2 ring-orange-200"
                          : "border-orange-100 bg-white/80 text-orange-900 hover:border-orange-300"
                      }`}
                    >
                      <div className="font-black">{anchor.displayLabel}</div>
                      <div className="mt-1 text-[10px] font-bold text-orange-700">Expected: {anchor.expectedText || "N/A"}</div>
                      <div className="mt-2 w-fit rounded-full bg-orange-100 px-2 py-0.5 text-[9px] font-black uppercase text-orange-700">
                        {anchor.dataType === "image" ? "Image Anchor" : "Text Anchor"}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </aside>
        </div>
        {ocrStatus && <p className="mt-3 text-xs font-bold text-slate-600">{ocrStatus}</p>}
        {(ocrResults.length > 0 || anchorPreviewResults.length > 0) && (
          <div className="mt-4 rounded-xl border border-orange-200 bg-orange-50/70 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h4 className="text-xs font-black text-orange-950">Verification Anchors Preview</h4>
                <p className="mt-1 text-[11px] font-semibold text-orange-700">
                  แสดง ROI ที่ใช้ยืนยัน Template เท่านั้น ไม่ใช่ข้อมูลที่จะส่งออกให้ผู้ใช้
                </p>
              </div>
              <span className="w-fit rounded-full bg-orange-600 px-2.5 py-1 text-[10px] font-black uppercase text-white">
                {verificationAnchors.length} Anchors
              </span>
            </div>
            <div className="mt-3 space-y-3">
              {verificationAnchors.length === 0 ? (
                <p className="rounded-lg bg-white p-3 text-xs font-semibold text-orange-600">ยังไม่มี Verification Anchors สำหรับ Template นี้</p>
              ) : (
                safePages.map((page) => {
                  const pageAnchors = verificationAnchors.filter((anchor) => anchor.pageNumber === page.pageNumber);
                  const pagePreviews = anchorPreviewsByPage[page.pageNumber] || [];
                  if (pageAnchors.length === 0) return null;
                  return (
                    <div key={`anchor-preview-${page.id}`} className="rounded-xl border border-orange-100 bg-white p-3">
                      <h5 className="text-[11px] font-black uppercase tracking-wider text-orange-800">Page {page.pageNumber}</h5>
                      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {pageAnchors.map((anchor) => {
                          const preview = pagePreviews.find((item) => item.id === anchor.id);
                          const isImageAnchor = anchor.dataType === "image";
                          return (
                            <button
                              key={anchor.id}
                              type="button"
                              onClick={() => setSelectedFieldId(anchor.id)}
                              className={`rounded-xl border p-3 text-left text-xs transition-colors ${
                                selectedFieldId === anchor.id
                                  ? "border-orange-500 bg-orange-50 text-orange-950 ring-2 ring-orange-200"
                                  : "border-orange-100 bg-white text-slate-800 hover:border-orange-300"
                              }`}
                            >
                              <div className="flex gap-3">
                                {preview?.roiPreviewUrl ? (
                                  <img src={preview.roiPreviewUrl} alt="" className="h-16 w-24 rounded-lg border border-orange-100 bg-white object-contain" />
                                ) : (
                                  <div className="flex h-16 w-24 items-center justify-center rounded-lg border border-dashed border-orange-200 bg-orange-50 text-[10px] font-bold text-orange-400">
                                    No preview
                                  </div>
                                )}
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-black text-slate-900">{anchor.displayLabel}</div>
                                  <div className="mt-0.5 text-[10px] font-bold text-slate-500">{anchor.fieldName}</div>
                                  <div className="mt-2 flex flex-wrap gap-1">
                                    <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[9px] font-black uppercase text-orange-700">
                                      {isImageAnchor ? "Image Anchor" : "Text Anchor"}
                                    </span>
                                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-black uppercase text-slate-600">
                                      Weight {anchor.verificationWeight ?? 1}
                                    </span>
                                    {anchor.requiredForVerification && (
                                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-[9px] font-black uppercase text-red-700">Required</span>
                                    )}
                                  </div>
                                </div>
                              </div>
                              {!isImageAnchor && (
                                <div className="mt-3 rounded-lg bg-orange-50 p-2 text-[11px] font-semibold text-orange-900">
                                  Expected: {anchor.expectedText || "ยังไม่ได้กำหนด Expected Text"}
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
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
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <DraftSectionHeader
            title="Temporary Layout Signature Simulation"
            subtitle="ขั้นนี้ทำงานได้หลังจาก ROI & OCR Preview ผ่านแล้วเท่านั้น และไม่บันทึกลง production storage."
          />
          <button
            type="button"
            onClick={handleRunPrepublishSimulation}
            disabled={simulationAction !== null || !ocrPreviewPassed}
            className="ui-stable-action rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white shadow-sm disabled:bg-slate-300 disabled:text-slate-500"
          >
            {simulationAction === "run" ? "Simulating..." : simulation ? "Run Again" : "Run Simulation"}
          </button>
        </div>
        {!ocrPreviewPassed && (
          <p className="mt-4 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-700">
            ต้อง Preview OCR ใน Step 1 ให้ผ่านก่อนจึงจะเริ่ม Simulation ได้
          </p>
        )}
        <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50 p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-700">Simulation Pipeline</h4>
              <p className="mt-1 text-[10px] font-semibold text-slate-500">Temporary only. Nothing is saved to production layout storage.</p>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ${
              simulationAction === "run"
                ? "bg-indigo-100 text-indigo-700"
                : simulation
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-slate-200 text-slate-600"
            }`}>
              {simulationAction === "run" ? "Running" : simulation ? "Completed" : "Not Started"}
            </span>
          </div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-7">
          {prepublishSimulationSteps.map((step, index) => {
            const isDone = Boolean(simulation) || index < simulationStep;
            const isCurrent = simulationAction === "run" && index === simulationStep;
            return (
              <div
                key={step}
                className={`rounded-lg border px-2.5 py-2 text-[10px] font-black ${
                  isDone
                    ? "border-emerald-100 bg-emerald-50 text-emerald-700"
                    : isCurrent
                      ? "border-indigo-100 bg-indigo-50 text-indigo-700"
                      : "border-slate-100 bg-slate-50 text-slate-400"
                }`}
              >
                <div className="flex items-center gap-2">
                  {isDone ? <CheckCircle2 size={14} /> : isCurrent ? <Info size={14} /> : <span className="block h-3.5 w-3.5 rounded-full bg-slate-200" />}
                  <span className="leading-snug">{step}</span>
                </div>
              </div>
            );
          })}
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-slate-100 bg-white p-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-700">Layout Reference Images</h4>
              <p className="mt-1 text-[10px] font-semibold text-slate-500">
                ภาพแต่ละหน้าจะถูกแปลงเป็น Layout Signature ชั่วคราวเพื่อใช้ทดสอบก่อน Publish
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">
              {layoutSignaturePages.filter((page) => page.status === "generated").length}/{layoutSignaturePages.length} generated
            </span>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {layoutSignaturePages.map((page) => {
              const status = page.status || "pending";
              const isGenerated = status === "generated";
              const isRunning = status === "running";
              const isFailed = status === "failed";
              return (
                <div key={`${page.templatePageId || "page"}-${page.pageNumber}`} className="rounded-xl border border-slate-200 bg-slate-50 p-2.5">
                  <div className="flex items-start gap-3">
                    <div className="h-20 w-16 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white">
                      {page.imageUrl ? (
                        <img src={page.imageUrl} alt={`Page ${page.pageNumber}`} className="h-full w-full object-contain" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-[10px] font-bold text-slate-400">No Image</div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-black text-slate-900">Page {page.pageNumber}</div>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase ${
                            isGenerated
                              ? "bg-emerald-100 text-emerald-700"
                              : isRunning
                                ? "bg-indigo-100 text-indigo-700"
                                : isFailed
                                  ? "bg-red-100 text-red-700"
                                  : "bg-slate-200 text-slate-600"
                          }`}
                        >
                          {isGenerated ? "Generated" : isRunning ? "Running" : isFailed ? "Failed" : "Pending"}
                        </span>
                      </div>
                      <div className="mt-2 space-y-1 text-[10px] font-semibold text-slate-500">
                        <p>Engine: {page.engine || "layout_signature"}</p>
                        <p>Model: {page.modelName || "N/A"}</p>
                        <p>Layout boxes: {page.labelCount ?? "N/A"}</p>
                        {page.reason && <p className="text-red-600">Reason: {page.reason}</p>}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {simulation?.temporaryEmbedding && (
          <div className="mt-4 rounded-xl border border-slate-100 bg-white p-3">
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
              <DraftOverviewMetric label="Status" value={simulation.temporaryEmbedding.status} tone="emerald" />
              <DraftOverviewMetric label="Model" value={simulation.temporaryEmbedding.modelName || "N/A"} />
              <DraftOverviewMetric label="Engine" value={simulation.temporaryEmbedding.engine} tone="indigo" />
              <DraftOverviewMetric label="Dimension" value={simulation.temporaryEmbedding.embeddingDimension} />
              <DraftOverviewMetric label="Generated" value={simulation.temporaryEmbedding.generatedAt || "N/A"} />
            </div>
          </div>
        )}
      </section>
      )}

      {validationStep === 3 && (
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <DraftSectionHeader
            title="Test with a New Document"
            subtitle="อัปโหลดเอกสารใหม่เพื่อทดสอบว่า Draft Template นี้ถูกเลือกได้ถูกต้องก่อน Publish."
          />
          <button
            type="button"
            onClick={handleRunDetectionTest}
            disabled={!canRunDetectionTest}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white shadow-sm disabled:bg-slate-300 disabled:text-slate-500"
          >
            {detectionTestAction ? "Running..." : "Run Detection Test"}
          </button>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <label className="block text-[10px] font-black uppercase tracking-wider text-slate-700">Test Document</label>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              onChange={(event) => handleTestDocumentChange(event.target.files?.[0] || null)}
              className="mt-3 block w-full text-[11px] font-semibold text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-600 file:px-3 file:py-2 file:text-[11px] file:font-black file:text-white"
            />
            {testDocumentFile && (
              <div className="mt-3 rounded-lg bg-white p-2.5 text-[11px] font-semibold text-slate-600">
                <div className="truncate font-black text-slate-900">{testDocumentFile.name}</div>
                <div className="mt-1">{Math.round(testDocumentFile.size / 1024)} KB</div>
              </div>
            )}
            {testDocumentPreviewUrl ? (
              <img src={testDocumentPreviewUrl} alt="" className="mt-3 max-h-44 w-full rounded-lg border border-slate-200 bg-white object-contain" />
            ) : (
              <div className="mt-3 rounded-lg border border-dashed border-slate-300 bg-white p-5 text-center text-[11px] font-semibold text-slate-500">
                {testDocumentFile?.type === "application/pdf" ? "PDF selected. Preview will be generated by backend during test." : "PNG, JPEG, WebP, or PDF"}
              </div>
            )}
            {!simulationPassed && (
              <p className="mt-3 rounded-lg bg-amber-50 p-2.5 text-[11px] font-bold text-amber-700">
                ต้อง Run Simulation ให้ผ่านก่อนจึงจะทดสอบเอกสารใหม่ได้
              </p>
            )}
          </div>

          <div className="space-y-3">
            {detectionTestError && <p className="rounded-xl bg-red-50 p-3 text-xs font-black text-red-700">{detectionTestError}</p>}
            {!detectionTest ? (
              <div className="rounded-xl border border-slate-100 bg-slate-50 p-4 text-xs font-semibold text-slate-500">
                No new document detection test has been run yet.
              </div>
            ) : (
              <div className="rounded-xl border border-slate-100 bg-white p-3">
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  <DraftOverviewMetric label="Matched" value={detectionTest.matched ? "YES" : "NO"} tone={detectionTest.matched ? "emerald" : "slate"} />
                  <DraftOverviewMetric label="Selected Template" value={detectionTest.selectedTemplate?.templateName || detectionTest.selectedTemplate?.templateId || "N/A"} />
                  <DraftOverviewMetric label="Selected Type" value={detectionTest.selectedTemplateType || "N/A"} />
                  <DraftOverviewMetric label="Final Confidence" value={formatPrepublishScore(detectionTest.finalConfidence)} tone="indigo" />
                  <DraftOverviewMetric label="Decision Reason" value={detectionTest.decisionReason || "N/A"} />
                  <DraftOverviewMetric label="Draft Template Rank" value={detectionTest.draftTemplateRank ?? "N/A"} />
                  <DraftOverviewMetric label="Result" value={detectionTest.passed ? "PASS" : detectionTest.warning ? "WARNING" : "FAIL"} tone={detectionTest.passed ? "emerald" : detectionTest.warning ? "orange" : "slate"} />
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
      )}

      {validationStep === 3 && detectionTest && (
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <DraftSectionHeader title="Candidate Ranking" subtitle="แสดงผลหลังจาก Run Detection Test แล้วเท่านั้น รายละเอียดเชิงลึกซ่อนอยู่ในปุ่ม expand." />
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-xs">
            <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Rank</th>
                <th className="px-3 py-2 text-left">Template Name</th>
                <th className="px-3 py-2 text-left">Source</th>
                <th className="px-3 py-2 text-left">Final</th>
                <th className="px-3 py-2 text-left">Layout</th>
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
                      {candidate.isCurrentDraft ? "Draft / Temporary Layout Signature" : candidate.sourceLabel || "Published / Layout Signature"}
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
                    <span className="rounded-full bg-white px-2 py-1">Score {formatPrepublishScore(readVerificationRecordScore(anchor))}</span>
                    {readPrepublishValue(anchor, ["image_category_label", "image_category"]) && (
                      <span className="rounded-full bg-white px-2 py-1">{String(readPrepublishValue(anchor, ["image_category_label", "image_category"]))}</span>
                    )}
                    <span className="rounded-full bg-white px-2 py-1">Weight {String(readPrepublishValue(anchor, ["weight", "verification_weight"]) || "N/A")}</span>
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

      {validationStep === 4 && (
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <DraftSectionHeader title="Publish Review" subtitle="ตรวจสอบขั้นตอนสุดท้ายก่อนสร้าง Layout Signature จริงและ Publish Template." />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[
            ["ROI & OCR Preview", ocrPreviewPassed],
            ["Verification Anchors", verificationAnchors.length > 0],
            ["Simulation", simulationPassed],
            ["New Document Test", detectionTestPassed],
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
                Confirm generates the real layout signature, validates image anchors with SigLIP, and publishes only after every operation succeeds.
              </p>
              {!simulationPassed && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-700">Run Simulation must pass before publishing.</p>}
              {simulationPassed && !detectionTest && (
                <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-700">
                  Run at least one New Document Detection Test before publishing.
                </p>
              )}
              {detectionTest && !detectionTestPassed && (
                <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-700">
                  The draft template must rank first and pass the new document test before publishing.
                </p>
              )}
              {publishConfirmed && <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-xs font-black text-emerald-700">Template published successfully.</p>}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                onClick={handleConfirmPublish}
                disabled={!canConfirmPublish}
                className="ui-stable-action-lg rounded-xl bg-emerald-600 px-4 py-2 text-xs font-black text-white disabled:bg-slate-300 disabled:text-slate-500"
              >
                {template.status === "active"
                  ? "Publish Template Complete"
                  : simulationAction === "confirm"
                    ? "Publishing..."
                    : "Confirm and Publish Template"}
              </button>
            </div>
          </div>
        </div>
      </section>
      )}
    </section>
  );
}

