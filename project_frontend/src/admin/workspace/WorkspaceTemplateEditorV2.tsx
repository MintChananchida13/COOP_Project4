"use client";

import { ChevronDown, ChevronUp, Loader2, ScanSearch } from "lucide-react";
import { SetStateAction, useMemo, useRef, useState } from "react";
import { WorkspacePage } from "../../shared/workspace/BaseWorkspace";
import WorkspaceCustomEditor from "../../shared/workspace/WorkspaceCustomEditor";
import { DEFAULT_WORKSPACE_IMAGE_METRICS, ratioToImageBox, WorkspaceImageMetrics } from "../../shared/workspace/roiGeometry";
import { IgnoreRegion, ROI, RoiRatio, TemplateField } from "../../types/ocr";
import { TemplateStepTestResult, testTemplateExtractionFields, testTemplateVerificationAnchors } from "../adminApi";
import TemplateFieldBasicForm from "./TemplateFieldBasicForm";
import TemplateVerificationAnchorForm from "./TemplateVerificationAnchorForm";

interface WorkspaceTemplateEditorProps {
  templateId: string;
  pages: WorkspacePage[];
  currentPage: number;
  onPageChange: (pageIndex: number) => void;
  fields: TemplateField[];
  ignoreRegions: IgnoreRegion[];
  onAddField: (roi?: RoiRatio, defaults?: Partial<TemplateField>) => void;
  onUpdateField: (fieldId: string, patch: Partial<TemplateField>) => void;
  onReorderFields: (orderedFieldIds: string[]) => void;
  onReplacePageExtractionFields: (pageNumber: number, fields: { roi: RoiRatio; defaults: Partial<TemplateField> }[]) => void;
  onDeleteField: (fieldId: string) => void;
  onAddIgnoreRegion: (roi?: RoiRatio) => void;
  onUpdateIgnoreRegion: (regionId: string, patch: Partial<IgnoreRegion>) => void;
  onDeleteIgnoreRegion: (regionId: string) => void;
  onGenerateEmbedding: () => void;
  onRunTestMode: () => void;
}

type EditorStep = "extraction_fields" | "verification_anchors";
type EditorMode = "extraction_fields" | "verification_anchors" | "ignore_regions";
type AdminRoi = ROI & {
  sourceId?: string;
  workspaceKind: EditorMode;
  pageIndex?: number;
};

interface LayoutDetectedRegion {
  field_name?: string;
  type?: "text" | "table" | "image";
  data_type?: "text" | "table" | "image";
  extraction_method?: string;
  confidence?: number;
  roi?: {
    page_number?: number;
    x_ratio?: number;
    y_ratio?: number;
    width_ratio?: number;
    height_ratio?: number;
  };
}

interface LayoutDetectedPage {
  page_index: number;
  page_number: number;
  image_width: number;
  image_height: number;
  regions: LayoutDetectedRegion[];
  message?: string | null;
}

interface LayoutAnalysisResponse {
  success?: boolean;
  pages?: LayoutDetectedPage[];
  detail?: string;
  error?: string;
}

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 outline-none focus:border-indigo-500";

const stableNumericId = (value: string) =>
  Math.abs(value.split("").reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7));

const clampRatio = (value: number) => Math.min(1, Math.max(0, value));

const isAnchor = (field: TemplateField) => field.useForVerification;

const fieldToRoiType = (field: TemplateField): ROI["type"] => {
  if (field.dataType === "table") return "table";
  if (field.dataType === "image") return "image";
  return "text";
};

const roiToRatio = (roi: ROI, pageNumber: number, metrics: WorkspaceImageMetrics): RoiRatio => ({
  pageNumber,
  xRatio: clampRatio((roi.x - metrics.imageOffsetX) / Math.max(metrics.imageWidth, 1)),
  yRatio: clampRatio((roi.y - metrics.imageOffsetY) / Math.max(metrics.imageHeight, 1)),
  widthRatio: clampRatio(roi.width / Math.max(metrics.imageWidth, 1)),
  heightRatio: clampRatio(roi.height / Math.max(metrics.imageHeight, 1)),
});

const normalizeLayoutRegionType = (region: LayoutDetectedRegion): "text" | "table" | "image" => {
  if (region.type === "table" || region.data_type === "table") return "table";
  if (region.type === "image" || region.data_type === "image") return "image";
  return "text";
};

const layoutRegionToDetectedField = (
  region: LayoutDetectedRegion,
  pageNumber: number,
  fieldNumber: number
): { roi: RoiRatio; defaults: Partial<TemplateField> } | null => {
  const roi = region.roi;
  if (!roi) return null;

  const xRatio = Number(roi.x_ratio);
  const yRatio = Number(roi.y_ratio);
  const widthRatio = Number(roi.width_ratio);
  const heightRatio = Number(roi.height_ratio);
  if (![xRatio, yRatio, widthRatio, heightRatio].every(Number.isFinite)) return null;

  const safeRoi = {
    pageNumber,
    xRatio: clampRatio(xRatio),
    yRatio: clampRatio(yRatio),
    widthRatio: clampRatio(widthRatio),
    heightRatio: clampRatio(heightRatio),
  };
  if (safeRoi.widthRatio <= 0 || safeRoi.heightRatio <= 0) return null;

  const dataType = normalizeLayoutRegionType(region);
  const fieldName = `field_${fieldNumber}`;
  return {
    roi: safeRoi,
    defaults: {
      fieldName,
      displayLabel: fieldName,
      dataType,
      extractionMethod: dataType === "image" ? "extract_image" : dataType === "table" ? "table_recognition_v2" : "paddle_thai_ocr",
      userSelectable: true,
      defaultSelected: true,
      useForVerification: false,
      requiredForVerification: false,
      roiPadding: 0,
      sortOrder: fieldNumber,
    },
  };
};

const fieldToRoi = (field: TemplateField, metrics: WorkspaceImageMetrics): AdminRoi => {
  const box = ratioToImageBox(field.roi, metrics);
  const anchor = isAnchor(field);
  return {
    id: stableNumericId(`${anchor ? "anchor" : "field"}:${field.id}`),
    sourceId: field.id,
    workspaceKind: anchor ? "verification_anchors" : "extraction_fields",
    fieldName: field.displayLabel || field.fieldName,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    pageIndex: field.pageNumber - 1,
    type: fieldToRoiType(field),
  };
};

const ignoreToRoi = (region: IgnoreRegion, metrics: WorkspaceImageMetrics): AdminRoi => {
  const box = ratioToImageBox(region.roi, metrics);
  return {
    id: stableNumericId(`ignore:${region.id}`),
    sourceId: region.id,
    workspaceKind: "ignore_regions",
    fieldName: `Ignore: ${region.fieldName}`,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    pageIndex: region.pageNumber - 1,
    type: "text",
  };
};

export default function WorkspaceTemplateEditorV2({
  templateId,
  pages,
  currentPage,
  onPageChange,
  fields,
  ignoreRegions,
  onAddField,
  onUpdateField,
  onReorderFields,
  onReplacePageExtractionFields,
  onDeleteField,
  onAddIgnoreRegion,
  onUpdateIgnoreRegion,
  onDeleteIgnoreRegion,
  onRunTestMode,
}: WorkspaceTemplateEditorProps) {
  const [step, setStep] = useState<EditorStep>("extraction_fields");
  const [mode, setMode] = useState<EditorMode>("extraction_fields");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [imageMetrics, setImageMetrics] = useState<WorkspaceImageMetrics>(DEFAULT_WORKSPACE_IMAGE_METRICS);
  const [testStatus, setTestStatus] = useState("");
  const [testResult, setTestResult] = useState<TemplateStepTestResult | null>(null);
  const [testError, setTestError] = useState("");
  const [testAction, setTestAction] = useState<"extraction" | "verification" | null>(null);
  const [autoDetectStatus, setAutoDetectStatus] = useState("");
  const [autoDetectError, setAutoDetectError] = useState("");
  const [isAutoDetecting, setIsAutoDetecting] = useState(false);
  const pendingRoiRef = useRef<{ mode: EditorMode; roi: RoiRatio } | null>(null);
  const currentPageNumber = currentPage + 1;
  const selectedPage = pages[currentPage];

  const orderedFields = useMemo(
    () =>
      [...fields].sort(
        (left, right) =>
          left.pageNumber - right.pageNumber ||
          (left.sortOrder ?? 0) - (right.sortOrder ?? 0) ||
          left.fieldName.localeCompare(right.fieldName)
      ),
    [fields]
  );
  const extractionFields = orderedFields.filter((field) => !isAnchor(field));
  const verificationAnchors = orderedFields.filter(isAnchor);
  const currentPageExtractionFields = extractionFields.filter((field) => field.pageNumber === currentPageNumber);
  const currentPageAnchors = verificationAnchors.filter((field) => field.pageNumber === currentPageNumber);

  const extractionRois = useMemo(() => extractionFields.map((field) => fieldToRoi(field, imageMetrics)), [extractionFields, imageMetrics]);
  const anchorRois = useMemo(() => verificationAnchors.map((field) => fieldToRoi(field, imageMetrics)), [verificationAnchors, imageMetrics]);
  const ignoreRois = useMemo(() => ignoreRegions.map((region) => ignoreToRoi(region, imageMetrics)), [ignoreRegions, imageMetrics]);
  const activeRois = step === "verification_anchors" ? anchorRois : mode === "ignore_regions" ? ignoreRois : extractionRois;

  const selectedRoi = [...extractionRois, ...anchorRois, ...ignoreRois].find((roi) => roi.id === selectedId);
  const selectedField = selectedRoi?.workspaceKind === "extraction_fields" || selectedRoi?.workspaceKind === "verification_anchors"
    ? fields.find((field) => field.id === selectedRoi.sourceId)
    : null;
  const selectedIgnoreRegion = selectedRoi?.workspaceKind === "ignore_regions"
    ? ignoreRegions.find((region) => region.id === selectedRoi.sourceId)
    : null;
  const selectedAnchor = selectedField && isAnchor(selectedField)
    ? selectedField
    : currentPageAnchors[0] || verificationAnchors[0] || null;
  const selectedExtractionField = selectedField && !isAnchor(selectedField)
    ? selectedField
    : currentPageExtractionFields[0] || extractionFields[0] || null;

  const selectField = (field: TemplateField) => {
    setSelectedId(stableNumericId(`${isAnchor(field) ? "anchor" : "field"}:${field.id}`));
    if (field.pageNumber - 1 !== currentPage) onPageChange(field.pageNumber - 1);
  };

  const setSelectedRoiId = (value: number | null | ((previous: number | null) => number | null)) => {
    setSelectedId((previous) => {
      const next = typeof value === "function" ? value(previous) : value;
      const roi = [...extractionRois, ...anchorRois, ...ignoreRois].find((item) => item.id === next);
      if ((roi?.workspaceKind === "extraction_fields" || roi?.workspaceKind === "verification_anchors") && roi.sourceId) {
        const field = fields.find((item) => item.id === roi.sourceId);
        if (field && field.pageNumber - 1 !== currentPage) onPageChange(field.pageNumber - 1);
      }
      return next;
    });
  };

  const persistRois = (nextRois: SetStateAction<(ROI & { pageIndex?: number })[]>) => {
    const resolved = (typeof nextRois === "function" ? nextRois(activeRois) : nextRois) as AdminRoi[];
    const previousById = new Map(activeRois.map((roi) => [roi.id, roi]));
    const nextById = new Map(resolved.map((roi) => [roi.id, roi]));

    resolved.forEach((roi) => {
      const previous = previousById.get(roi.id);
      if (!previous) {
        const ratio = roiToRatio(roi, currentPageNumber, imageMetrics);
        pendingRoiRef.current = { mode, roi: ratio };
        if (mode === "verification_anchors") {
          const index = verificationAnchors.length + 1;
          onAddField(ratio, {
            fieldName: `anchor_${index}`,
            displayLabel: `Anchor ${index}`,
            dataType: "text",
            userSelectable: false,
            defaultSelected: false,
            useForVerification: true,
            requiredForVerification: false,
            extractionMethod: "ocr_text",
            roiPadding: 6,
            verificationWeight: 1,
            expectedText: "",
            matchType: "contains",
          });
        } else if (mode === "ignore_regions") {
          onAddIgnoreRegion(ratio);
        } else {
          onAddField(ratio, {
            userSelectable: true,
            defaultSelected: true,
            useForVerification: false,
            requiredForVerification: false,
            extractionMethod: "paddle_thai_ocr",
            roiPadding: 0,
          });
        }
        return;
      }

      if (previous.x !== roi.x || previous.y !== roi.y || previous.width !== roi.width || previous.height !== roi.height) {
        const ratio = roiToRatio(roi, (roi.pageIndex ?? currentPage) + 1, imageMetrics);
        if ((previous.workspaceKind === "extraction_fields" || previous.workspaceKind === "verification_anchors") && previous.sourceId) {
          onUpdateField(previous.sourceId, { roi: ratio });
        }
        if (previous.workspaceKind === "ignore_regions" && previous.sourceId) {
          onUpdateIgnoreRegion(previous.sourceId, { roi: ratio });
        }
      }
    });

    activeRois.forEach((roi) => {
      if (!nextById.has(roi.id) && (roi.pageIndex ?? 0) === currentPage && roi.sourceId) {
        if (roi.workspaceKind === "ignore_regions") onDeleteIgnoreRegion(roi.sourceId);
        else onDeleteField(roi.sourceId);
      }
    });
  };

  const anchorMethod = (anchor: TemplateField) => anchor.dataType === "image" ? "image_feature" : "ocr_text";

  const updateAnchorMethod = (anchor: TemplateField, value: string) => {
    if (value === "image_feature") {
      onUpdateField(anchor.id, { dataType: "image", extractionMethod: "extract_image", expectedText: "" });
    } else {
      onUpdateField(anchor.id, { dataType: "text", extractionMethod: "ocr_text" });
    }
  };

  const moveExtractionFieldOrder = (fieldId: string, direction: -1 | 1) => {
    const currentIndex = currentPageExtractionFields.findIndex((field) => field.id === fieldId);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= currentPageExtractionFields.length) return;

    const nextOrder = [...currentPageExtractionFields];
    const [field] = nextOrder.splice(currentIndex, 1);
    nextOrder.splice(nextIndex, 0, field);
    onReorderFields(nextOrder.map((item) => item.id));
    selectField(field);
  };

  const handleAutoDetectExtractionRoi = async () => {
    if (!selectedPage?.src || isAutoDetecting) return;

    setStep("extraction_fields");
    setMode("extraction_fields");
    setSelectedId(null);
    setAutoDetectStatus("");
    setAutoDetectError("");
    setIsAutoDetecting(true);

    try {
      const response = await fetch("http://localhost:8000/api/layout/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          images: [
            {
              page_index: currentPage,
              image: selectedPage.src,
            },
          ],
        }),
      });
      const responseText = await response.text();
      let result: LayoutAnalysisResponse = {};
      try {
        result = responseText ? (JSON.parse(responseText) as LayoutAnalysisResponse) : {};
      } catch {
        result = { error: responseText || response.statusText };
      }

      if (!response.ok || !result.success) {
        if (response.status === 404) {
          throw new Error("ไม่พบ endpoint /api/layout/analyze กรุณา restart backend");
        }
        throw new Error(result.detail || result.error || "สร้าง ROI อัตโนมัติไม่สำเร็จ");
      }

      const detectedPage = (result.pages || []).find((page) => Number(page.page_index) === currentPage) || result.pages?.[0];
      const detectedFields = (detectedPage?.regions || [])
        .map((region, index) => layoutRegionToDetectedField(region, currentPageNumber, index + 1))
        .filter((item): item is { roi: RoiRatio; defaults: Partial<TemplateField> } => item !== null);

      onReplacePageExtractionFields(currentPageNumber, detectedFields);
      setAutoDetectStatus(
        detectedFields.length > 0
          ? `สร้าง ROI อัตโนมัติ ${detectedFields.length} รายการ และลบ Extraction ROI เดิมของหน้านี้ ${currentPageExtractionFields.length} รายการ`
          : `ไม่พบ Text, Table หรือ Image Region ในหน้า ${currentPageNumber} ระบบลบ Extraction ROI เดิมของหน้านี้แล้ว`
      );
    } catch (error) {
      console.error("Admin auto ROI detection failed.", error);
      setAutoDetectError(error instanceof Error ? error.message : "สร้าง ROI อัตโนมัติไม่สำเร็จ");
    } finally {
      setIsAutoDetecting(false);
    }
  };

  const clearStepTest = () => {
    setTestResult(null);
    setTestStatus("");
    setTestError("");
  };

  const runStepTest = async (kind: "extraction" | "verification") => {
    setTestAction(kind);
    setTestError("");
    setTestStatus(kind === "extraction" ? "Testing extraction fields..." : "Testing verification anchors...");
    setTestResult(null);
    try {
      const result =
        kind === "extraction"
          ? await testTemplateExtractionFields(templateId)
          : await testTemplateVerificationAnchors(templateId);
      setTestResult(result);
      setTestStatus(`${kind === "extraction" ? "Extraction" : "Verification"} test complete: ${result.passedCount}/${result.testedCount} passed.`);
    } catch (error) {
      setTestError(error instanceof Error ? error.message : "Step test failed.");
      setTestStatus("");
    } finally {
      setTestAction(null);
    }
  };

  const renderTestResults = (items: TemplateStepTestResult["fields"] | TemplateStepTestResult["anchors"]) => (
    <div className="mt-4 space-y-3">
      {items && items.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item, index) => (
            <div key={`${item.fieldId || item.anchorId || index}-test-result`} className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-black text-slate-800">{item.displayLabel || item.fieldName || "Field"}</div>
                  <div className="mt-0.5 text-[9px] font-bold uppercase text-slate-400">
                    Page {item.pageNumber ?? "N/A"} {item.anchorType === "image" ? "Image Feature" : item.anchorType === "text" ? "OCR Text" : ""}
                  </div>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase ${item.passed ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                  {item.passed ? "PASS" : "FAIL"}
                </span>
              </div>
              {item.anchorType === "image" && (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg border border-slate-100 bg-white p-2">
                    <div className="text-[9px] font-black uppercase text-slate-400">Reference Crop</div>
                    {item.referenceCropPreviewDataUrl || item.referenceCropPreviewUrl ? (
                      <img src={item.referenceCropPreviewDataUrl || item.referenceCropPreviewUrl || ""} alt="" className="mt-2 h-24 w-full rounded-md object-contain" />
                    ) : (
                      <p className="mt-2 text-[10px] font-semibold text-slate-400">No preview</p>
                    )}
                  </div>
                  <div className="rounded-lg border border-slate-100 bg-white p-2">
                    <div className="text-[9px] font-black uppercase text-slate-400">Current Crop</div>
                    {item.currentCropPreviewDataUrl || item.currentCropPreviewUrl ? (
                      <img src={item.currentCropPreviewDataUrl || item.currentCropPreviewUrl || ""} alt="" className="mt-2 h-24 w-full rounded-md object-contain" />
                    ) : (
                      <p className="mt-2 text-[10px] font-semibold text-slate-400">No preview</p>
                    )}
                  </div>
                </div>
              )}
              {(item.ocrText || item.actualText || item.expectedText) && (
                <div className="mt-2 space-y-1 font-semibold text-slate-600">
                  {item.expectedText && <p>Expected: {item.expectedText}</p>}
                  {(item.ocrText || item.actualText) && <p>Result: {item.ocrText || item.actualText}</p>}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1 text-[9px] font-black uppercase">
                {item.confidence !== null && item.confidence !== undefined && (
                  <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-600">Conf {item.confidence.toFixed(2)}</span>
                )}
                {(item.fieldScore !== null && item.fieldScore !== undefined) || (item.score !== null && item.score !== undefined) ? (
                  <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-600">
                    Score {(item.fieldScore ?? item.score ?? 0).toFixed(2)}
                  </span>
                ) : null}
                {item.dinoSimilarityScore !== null && item.dinoSimilarityScore !== undefined && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700">
                    DINO {item.dinoSimilarityScore.toFixed(2)}
                  </span>
                )}
                {item.embeddingId && (
                  <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-600">
                    {item.embeddingId}
                  </span>
                )}
                {item.failureReason && !item.passed && (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700">{item.failureReason}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="mx-auto max-w-7xl space-y-4 pb-20">
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-sm font-black uppercase tracking-wide text-slate-800">
              {step === "verification_anchors" ? "2.2 Verification Anchors" : "2.1 Workspace ROI"}
            </h2>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              {step === "verification_anchors"
                ? "Anchors confirm the template only. They are never returned as extraction results."
                : "Extraction fields are the data returned to the end user."}
            </p>
          </div>
        </div>
      </section>

      <WorkspaceCustomEditor
        previewUrl={selectedPage?.src || ""}
        image={selectedPage?.src || null}
        brightness={100}
        contrast={100}
        rotation={0}
        rois={activeRois}
        setRois={persistRois}
        selectedId={selectedId}
        setSelectedId={setSelectedRoiId}
        onBackToAdjust={() => {}}
        deleteROI={(id) => {
          const roi = activeRois.find((item) => item.id === id);
          if (!roi?.sourceId) return;
          if (roi.workspaceKind === "ignore_regions") onDeleteIgnoreRegion(roi.sourceId);
          else onDeleteField(roi.sourceId);
        }}
        isLoading={false}
        onRunOCR={() => {}}
        onRunFullPageOCR={async () => {}}
        currentIndex={currentPage}
        imagesList={pages.map((page) => page.src)}
        onIndexChange={onPageChange}
        hideOcrActions
        hideStepProgress
        rootClassName="max-w-7xl mx-auto space-y-3"
        onImageMetricsChange={setImageMetrics}
        getRoiBadges={(roi) => (roi as AdminRoi).workspaceKind === "verification_anchors" ? ["ANCHOR"] : []}
        getRoiClassName={(roi, selected) => {
          const adminRoi = roi as AdminRoi;
          const isAnchorRoi = adminRoi.workspaceKind === "verification_anchors";
          const isIgnore = adminRoi.workspaceKind === "ignore_regions";
          if (isAnchorRoi || isIgnore) {
            return `rnd-box-item border transition-shadow pointer-events-auto ${
              selected
                ? "border-amber-700 bg-amber-400/30 shadow-lg z-30 ring-4 ring-amber-300/45"
                : "border-amber-500 bg-amber-400/10 hover:bg-amber-400/15 z-20"
            }`;
          }
          return `rnd-box-item border transition-shadow pointer-events-auto ${
            selected
              ? "border-sky-600 bg-sky-400/25 shadow-lg z-30 ring-4 ring-sky-300/45"
              : "border-indigo-400/80 bg-indigo-50/5 hover:border-indigo-500 hover:bg-indigo-50/10 z-20"
          }`;
        }}
        getRoiLabelClassName={(roi, selected) => {
          const adminRoi = roi as AdminRoi;
          const amber = adminRoi.workspaceKind === "verification_anchors" || adminRoi.workspaceKind === "ignore_regions";
          return `absolute -top-5 left-0 px-1.5 py-0.5 text-[9px] font-sans rounded shadow border flex items-center gap-1.5 pointer-events-auto cursor-pointer ${
            selected
              ? amber ? "bg-amber-700 border-amber-700 text-white font-extrabold" : "bg-sky-600 border-sky-600 text-white font-extrabold"
              : amber ? "bg-white border-amber-200 text-amber-700 font-bold" : "bg-white border-indigo-200 text-indigo-700 font-bold"
          }`;
        }}
        rightPanelRenderer={({ currentPageRois: panelRois, setSelectedId: selectRoi }) => (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {step === "extraction_fields" ? (
              <>
                <section className="space-y-2">
                  <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">ROI Mode</h3>
                  <div className="grid grid-cols-2 rounded-xl border border-slate-200 bg-slate-50 p-1">
                    <button type="button" onClick={() => setMode("extraction_fields")} className={`rounded-lg px-3 py-2 text-[10px] font-black ${mode === "extraction_fields" ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500"}`}>
                      Extraction
                    </button>
                    <button type="button" onClick={() => setMode("ignore_regions")} className={`rounded-lg px-3 py-2 text-[10px] font-black ${mode === "ignore_regions" ? "bg-white text-amber-700 shadow-sm" : "text-slate-500"}`}>
                      Ignore
                    </button>
                  </div>
                </section>
                <section className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Current Page ROI</h3>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-black text-slate-500">{panelRois.length}</span>
                  </div>
                  {mode === "extraction_fields" && (
                    <div className="space-y-2 rounded-lg border border-indigo-100 bg-white p-2.5">
                      <button
                        type="button"
                        onClick={handleAutoDetectExtractionRoi}
                        disabled={isAutoDetecting || !selectedPage?.src}
                        className="flex w-full items-center justify-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-black text-indigo-700 shadow-sm hover:bg-indigo-100 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
                      >
                        {isAutoDetecting ? <Loader2 size={14} className="animate-spin" /> : <ScanSearch size={14} />}
                        {isAutoDetecting ? "กำลังตีกรอบ ROI..." : "ตีกรอบ ROI อัตโนมัติ"}
                      </button>
                      <p className="text-[10px] font-semibold leading-relaxed text-slate-500">
                        วิเคราะห์ Layout ของหน้าปัจจุบันด้วย PP-DocLayoutV3 แล้วสร้าง Extraction ROI ใหม่ โดยลบ ROI เดิมของหน้านี้ก่อนทุกครั้ง
                      </p>
                      {autoDetectStatus && (
                        <p className="rounded-lg bg-emerald-50 px-2.5 py-2 text-[10px] font-bold leading-relaxed text-emerald-700">
                          {autoDetectStatus}
                        </p>
                      )}
                      {autoDetectError && (
                        <p className="rounded-lg bg-red-50 px-2.5 py-2 text-[10px] font-bold leading-relaxed text-red-700">
                          {autoDetectError}
                        </p>
                      )}
                    </div>
                  )}
                  <div className="max-h-52 space-y-1.5 overflow-y-auto pr-1">
                    {panelRois.length === 0 ? (
                      <p className="text-xs font-semibold text-slate-400">No ROI on this page.</p>
                    ) : panelRois.map((roi, index) => {
                      const sourceField = currentPageExtractionFields.find((field) => field.id === (roi as AdminRoi).sourceId);
                      const isSelected = selectedId === roi.id;
                      return (
                        <div
                          key={roi.id}
                          className={`flex items-center gap-1.5 rounded-lg border bg-white px-2 py-2 text-[11px] font-bold ${
                            isSelected ? "border-indigo-300 text-indigo-800 shadow-sm" : "border-slate-200 text-slate-600 hover:bg-slate-50"
                          }`}
                        >
                          <button type="button" onClick={() => selectRoi(roi.id)} className="min-w-0 flex-1 truncate text-left">
                            <span className="mr-1 text-slate-400">{index + 1}.</span>
                            {roi.fieldName}
                          </button>
                          {mode === "extraction_fields" && sourceField && (
                            <div className="flex shrink-0 gap-1">
                              <button
                                type="button"
                                onClick={() => moveExtractionFieldOrder(sourceField.id, -1)}
                                disabled={index === 0}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 shadow-sm transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-300 disabled:shadow-none"
                                title="Move field up"
                                aria-label="Move field up"
                              >
                                <ChevronUp size={14} strokeWidth={2.25} />
                              </button>
                              <button
                                type="button"
                                onClick={() => moveExtractionFieldOrder(sourceField.id, 1)}
                                disabled={index === panelRois.length - 1}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 shadow-sm transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-300 disabled:shadow-none"
                                title="Move field down"
                                aria-label="Move field down"
                              >
                                <ChevronDown size={14} strokeWidth={2.25} />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
                {mode === "extraction_fields" && selectedExtractionField && (
                  <TemplateFieldBasicForm field={selectedExtractionField} onUpdate={onUpdateField} onDelete={onDeleteField} />
                )}
                {mode === "ignore_regions" && selectedIgnoreRegion && (
                  <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                    <h3 className="text-xs font-black uppercase tracking-wider text-amber-800">Ignore Region</h3>
                    <input className={inputClass} value={selectedIgnoreRegion.fieldName} onChange={(event) => onUpdateIgnoreRegion(selectedIgnoreRegion.id, { fieldName: event.target.value })} />
                    <button type="button" onClick={() => onDeleteIgnoreRegion(selectedIgnoreRegion.id)} className="w-full rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-black text-red-700">
                      Delete Ignore Region
                    </button>
                  </section>
                )}
              </>
            ) : (
              <>
                <section className="rounded-xl border border-slate-200 bg-white p-3">
                  <button
                    type="button"
                    onClick={() => {
                      setStep("extraction_fields");
                      setMode("extraction_fields");
                      setSelectedId(null);
                      clearStepTest();
                    }}
                    className="w-full rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-black text-indigo-700 hover:bg-indigo-100"
                  >
                    Back to 2.1 Define Extraction Fields
                  </button>
                </section>
                <section className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3">
                  <h3 className="text-xs font-black uppercase tracking-wider text-amber-900">Verification Anchors</h3>
                  <p className="text-[10px] font-semibold leading-relaxed text-amber-800">
                    Draw fixed text or logo regions used only to confirm the template.
                  </p>
                </section>
                <section className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Page {currentPage + 1} Anchors</h3>
                  <div className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
                    {currentPageAnchors.length === 0 ? (
                      <p className="text-xs font-semibold text-slate-400">Draw an orange ROI to create an anchor.</p>
                    ) : currentPageAnchors.map((anchor) => (
                      <button key={anchor.id} type="button" onClick={() => selectField(anchor)} className={`w-full rounded-lg border px-2 py-2 text-left text-[11px] font-bold ${selectedAnchor?.id === anchor.id ? "border-amber-500 bg-amber-100 text-amber-900" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
                        <div className="truncate">{anchor.displayLabel || anchor.fieldName}</div>
                        <div className="mt-0.5 text-[9px] uppercase tracking-wide text-amber-700">{anchorMethod(anchor) === "image_feature" ? "Image Feature" : "OCR Text"}</div>
                      </button>
                    ))}
                  </div>
                </section>
                {selectedAnchor ? (
                  <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                    <h3 className="text-xs font-black uppercase tracking-wider text-amber-900">Anchor Settings</h3>
                    <label className="space-y-1 block">
                      <span className="text-[9px] font-black uppercase text-slate-400">Name</span>
                      <input className={inputClass} value={selectedAnchor.displayLabel || selectedAnchor.fieldName} onChange={(event) => onUpdateField(selectedAnchor.id, { fieldName: event.target.value, displayLabel: event.target.value })} />
                    </label>
                    <label className="space-y-1 block">
                      <span className="text-[9px] font-black uppercase text-slate-400">Verification Method</span>
                      <select className={inputClass} value={anchorMethod(selectedAnchor)} onChange={(event) => updateAnchorMethod(selectedAnchor, event.target.value)}>
                        <option value="ocr_text">OCR Text</option>
                        <option value="image_feature">Image Feature</option>
                        <option disabled>Logo Match (reserved)</option>
                        <option disabled>Barcode (reserved)</option>
                        <option disabled>QR Code (reserved)</option>
                      </select>
                    </label>
                    <label className="space-y-1 block">
                      <span className="text-[9px] font-black uppercase text-slate-400">ROI Padding</span>
                      <input type="number" min="0" step="1" className={inputClass} value={selectedAnchor.roiPadding ?? 6} onChange={(event) => onUpdateField(selectedAnchor.id, { roiPadding: Number(event.target.value) })} />
                    </label>
                    <label className="space-y-1 block">
                      <span className="text-[9px] font-black uppercase text-slate-400">Weight</span>
                      <input type="number" min="0" step="0.1" className={inputClass} value={selectedAnchor.verificationWeight ?? 1} onChange={(event) => onUpdateField(selectedAnchor.id, { verificationWeight: Number(event.target.value) })} />
                    </label>
                    {anchorMethod(selectedAnchor) === "ocr_text" && (
                      <label className="space-y-1 block">
                        <span className="text-[9px] font-black uppercase text-slate-400">Expected Text</span>
                        <input className={inputClass} value={selectedAnchor.expectedText || ""} onChange={(event) => onUpdateField(selectedAnchor.id, { expectedText: event.target.value })} />
                      </label>
                    )}
                    <button type="button" onClick={() => onDeleteField(selectedAnchor.id)} className="w-full rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-black text-red-700">
                      Delete Anchor
                    </button>
                  </section>
                ) : (
                  <p className="rounded-xl bg-slate-50 p-3 text-xs font-semibold text-slate-500">Draw or select a verification anchor first.</p>
                )}
              </>
            )}
            </div>
          </div>
        )}
      />

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">
              {step === "verification_anchors" ? "Verification Test Result" : "Extraction Test Result"}
            </h3>
            <p className="mt-1 text-[11px] font-semibold text-slate-500">
              {step === "verification_anchors"
                ? "Run OCR/image-anchor checks only for the verification anchors in this template."
                : "Run OCR only on the extraction ROI fields to confirm each ROI can read usable data."}
            </p>
          </div>
          <div className="flex gap-2">
            {step === "verification_anchors" ? (
              <button
                type="button"
                onClick={() => runStepTest("verification")}
                disabled={testAction !== null || verificationAnchors.length === 0}
                className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-black text-amber-800 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
              >
                {testAction === "verification" ? "Testing..." : "Test Verification"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => runStepTest("extraction")}
                disabled={testAction !== null || extractionFields.length === 0}
                className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-xs font-black text-indigo-700 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
              >
                {testAction === "extraction" ? "Testing..." : "Test Extraction"}
              </button>
            )}
          </div>
        </div>
        {testStatus && <p className="mt-3 text-xs font-bold text-slate-600">{testStatus}</p>}
        {testError && <p className="mt-3 rounded-xl bg-red-50 p-3 text-xs font-bold text-red-700">{testError}</p>}
        {testResult && (
          <div className="mt-3 flex flex-wrap gap-2 text-[10px] font-black uppercase">
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">{testResult.testedCount} tested</span>
            <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-700">{testResult.passedCount} passed</span>
            <span className="rounded-full bg-red-100 px-2.5 py-1 text-red-700">{testResult.failedCount} failed</span>
            {testResult.score !== null && testResult.score !== undefined && (
              <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-indigo-700">Score {testResult.score.toFixed(2)}</span>
            )}
          </div>
        )}
        {step === "verification_anchors"
          ? testResult?.anchors && renderTestResults(testResult.anchors)
          : testResult?.fields && renderTestResults(testResult.fields)}
        {!testResult && !testStatus && !testError && (
          <p className="mt-4 rounded-xl bg-slate-50 p-4 text-xs font-semibold text-slate-500">
            No step test results yet.
          </p>
        )}
        {step === "extraction_fields" && (
          <div className="mt-4 flex justify-end border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={() => {
                setStep("verification_anchors");
                setMode("verification_anchors");
                setSelectedId(null);
                clearStepTest();
              }}
              className="rounded-xl bg-amber-600 px-5 py-2.5 text-xs font-black text-white hover:bg-amber-700"
            >
              Next: Verification Anchors
            </button>
          </div>
        )}
        {step === "verification_anchors" && (
          <div className="mt-4 flex justify-end border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={onRunTestMode}
              className="rounded-xl bg-slate-900 px-5 py-2.5 text-xs font-black text-white hover:bg-slate-800"
            >
              Test Mode
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
