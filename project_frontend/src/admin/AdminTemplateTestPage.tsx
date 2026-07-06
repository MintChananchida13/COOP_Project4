"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import RoiLayer from "../shared/workspace/RoiLayer";
import { WorkspaceRoi } from "../shared/workspace/RoiBox";
import WorkspaceCanvas from "../shared/workspace/WorkspaceCanvas";
import { DEFAULT_WORKSPACE_IMAGE_METRICS, ratioToImageBox, WorkspaceImageMetrics } from "../shared/workspace/roiGeometry";
import { IgnoreRegion, Template, TemplateField, TemplatePage } from "../types/ocr";
import { ADMIN_API_BASE_URL, fetchTemplateBundle } from "./adminApi";
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

const stableNumericId = (value: string) =>
  Math.abs(value.split("").reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7));

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

export default function AdminTemplateTestPage({ templateId }: { templateId: string }) {
  const { templates, pages: statePages, fields: stateFields, ignoreRegions: stateIgnoreRegions, markTesting } = useAdminState();
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
        setIgnoreRegions(bundle.ignoreRegions);
        setLoadStatus("loaded");
      } catch (error) {
        console.warn("Using template test mock fallback because backend template data is unavailable.", error);
        if (cancelled) return;
        setLoadStatus(fallbackTemplate ? "fallback" : "error");
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [fallbackTemplate, templateId]);

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
            <p className="mt-1 text-xs font-semibold text-slate-500">{template.name}</p>
            {loadStatus === "fallback" && <p className="mt-2 text-xs font-bold text-amber-600">Showing local fallback because backend template data is unavailable.</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`/admin/templates/${templateId}/edit`} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700">
              Back to Edit Template
            </Link>
            <button type="button" onClick={() => markTesting(templateId)} className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-black text-emerald-700">
              Generate Embedding Placeholder
            </button>
            <button type="button" disabled className="rounded-xl bg-slate-300 px-4 py-2 text-xs font-black text-slate-500">
              Approve Disabled
            </button>
          </div>
        </div>
      </div>

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
