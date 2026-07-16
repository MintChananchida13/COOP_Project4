"use client";

import { ChangeEvent, useEffect, useState } from "react";
import { ADMIN_API_BASE_URL, DetectionCandidate, DetectionDevResult, detectTemplateDev } from "./adminApi";

const formatScore = (score?: number | null) => (typeof score === "number" && score !== null ? score.toFixed(4) : "N/A");
const readText = (value: unknown) => (typeof value === "string" && value.trim() ? value : "N/A");
const readValue = (value: unknown) => (typeof value === "number" || typeof value === "boolean" ? String(value) : readText(value));
const readScore = (value: unknown) => (typeof value === "number" ? formatScore(value) : "N/A");
const isImageVerificationField = (field: Record<string, unknown>) =>
  field.anchor_type === "image" ||
  field.verification_method === "image_feature" ||
  field.match_type === "image_feature";
const readPreviewValue = (field: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = field[key];
    if (typeof value === "string" && value.trim()) return previewSrc(value);
  }
  return "";
};
const renderVerificationExpected = (field: Record<string, unknown>) => {
  if (!isImageVerificationField(field)) return readText(field.expected_text);
  const src = readPreviewValue(field, ["reference_crop_preview_data_url", "reference_crop_preview_url"]);
  if (!src) return <span className="text-slate-400">Reference image unavailable</span>;
  return (
    <div className="w-32 rounded-lg border border-orange-100 bg-orange-50 p-1.5">
      <img src={src} alt="Expected anchor reference" className="h-20 w-full rounded bg-white object-contain" />
      <div className="mt-1 text-[9px] font-black uppercase text-orange-700">Reference</div>
    </div>
  );
};
const renderVerificationActual = (field: Record<string, unknown>) => {
  if (!isImageVerificationField(field)) return readText(field.actual_text);
  const src = readPreviewValue(field, ["current_crop_preview_data_url", "current_crop_preview_url"]);
  if (!src) return <span className="text-slate-400">Test image unavailable</span>;
  return (
    <div className="w-32 rounded-lg border border-sky-100 bg-sky-50 p-1.5">
      <img src={src} alt="Actual anchor crop" className="h-20 w-full rounded bg-white object-contain" />
      <div className="mt-1 text-[9px] font-black uppercase text-sky-700">Current</div>
    </div>
  );
};
const DebugMetric = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-lg border border-slate-100 bg-slate-50 px-2.5 py-2">
    <div className="text-[9px] font-black uppercase tracking-wider text-slate-400">{label}</div>
    <div className="mt-1 break-words text-[11px] font-bold text-slate-700">{value}</div>
  </div>
);
const PipelineImageCard = ({
  step,
  title,
  description,
  src,
  status,
}: {
  step: number;
  title: string;
  description: string;
  src?: string;
  status?: string;
}) => (
  <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
    <div className="flex items-start justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
      <div>
        <div className="text-[10px] font-black uppercase tracking-wider text-slate-400">Step {step}</div>
        <div className="mt-0.5 text-xs font-black text-slate-800">{title}</div>
      </div>
      {status && <span className="shrink-0 rounded-full bg-indigo-50 px-2 py-1 text-[9px] font-black uppercase text-indigo-700">{status}</span>}
    </div>
    <div className="p-3">
      {src ? (
        <img src={src} alt={title} className="h-32 w-full rounded-lg bg-slate-50 object-contain" />
      ) : (
        <div className="flex h-32 items-center justify-center rounded-lg bg-slate-50 text-center text-[11px] font-bold text-slate-400">
          Image not available
        </div>
      )}
      <p className="mt-2 min-h-8 text-[11px] font-semibold leading-4 text-slate-500">{description}</p>
    </div>
  </div>
);
const verificationFields = (candidate?: DetectionCandidate | null) => {
  const verification = candidate?.verification || {};
  const fields = verification.verification_details || verification.checked_fields;
  return Array.isArray(fields) ? (fields as Record<string, unknown>[]) : [];
};
const previewSrc = (value?: string | null) => {
  if (!value) return "";
  if (value.startsWith("data:") || value.startsWith("blob:") || value.startsWith("http")) return value;
  if (value.startsWith("/")) return `${ADMIN_API_BASE_URL}${value}`;
  return value;
};
const alignmentOf = (candidate?: DetectionCandidate | null) => (candidate?.alignment || {}) as Record<string, unknown>;
const alignmentDebugOf = (candidate?: DetectionCandidate | null) =>
  (candidate?.alignmentDebug || alignmentOf(candidate).alignment_debug || {}) as Record<string, unknown>;
const alignmentStatus = (candidate?: DetectionCandidate | null) => {
  const nestedStatus = alignmentOf(candidate).alignment_status;
  if (candidate?.alignmentStatus) return candidate.alignmentStatus;
  if (
    nestedStatus === "skipped" ||
    nestedStatus === "aligned" ||
    nestedStatus === "fallback" ||
    nestedStatus === "failed"
  ) {
    return nestedStatus;
  }
  return "failed";
};
const alignmentLabel = (candidate?: DetectionCandidate | null) => {
  if (!candidate) return "N/A";
  const status = alignmentStatus(candidate);
  if (status === "skipped") return "Skipped";
  if (status === "aligned") return "Success";
  if (status === "fallback") return "Fallback";
  if (status === "failed") return "Failed";
  if (candidate.alignmentFallbackUsed) return "Fallback";
  if (candidate.alignmentPassed) return "Aligned";
  return "Failed";
};
const alignmentBadgeClass = (candidate?: DetectionCandidate | null) => {
  const status = alignmentStatus(candidate);
  if (status === "aligned") return "bg-emerald-100 text-emerald-700";
  if (status === "skipped") return "bg-slate-100 text-slate-700";
  if (status === "fallback") return "bg-amber-100 text-amber-700";
  return "bg-red-100 text-red-700";
};
const readBool = (value: unknown) => (value === true ? "true" : value === false ? "false" : "N/A");
const ratioStyle = (roi: Record<string, unknown> | null | undefined) => {
  if (!roi) return null;
  const x = typeof roi.x_ratio === "number" ? roi.x_ratio : 0;
  const y = typeof roi.y_ratio === "number" ? roi.y_ratio : 0;
  const width = typeof roi.width_ratio === "number" ? roi.width_ratio : 0;
  const height = typeof roi.height_ratio === "number" ? roi.height_ratio : 0;
  return {
    left: `${Math.max(0, Math.min(1, x)) * 100}%`,
    top: `${Math.max(0, Math.min(1, y)) * 100}%`,
    width: `${Math.max(0, Math.min(1, width)) * 100}%`,
    height: `${Math.max(0, Math.min(1, height)) * 100}%`,
  };
};

type OverlayLayerKey = "template" | "projected" | "adaptive" | "words" | "anchors";

const overlayLayerOptions: { key: OverlayLayerKey; label: string; className: string }[] = [
  { key: "template", label: "Template ROI", className: "border-red-500 bg-red-500/10" },
  { key: "projected", label: "Projected ROI", className: "border-orange-500 bg-orange-500/10" },
  { key: "adaptive", label: "Adaptive ROI", className: "border-emerald-500 bg-emerald-500/10" },
  { key: "words", label: "OCR Word Boxes", className: "border-sky-500 bg-sky-500/10" },
  { key: "anchors", label: "Verification Anchors", className: "border-purple-500 bg-purple-500/10" },
];

export default function AdminDetectionLabPage() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [result, setResult] = useState<DetectionDevResult | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");
  const [overlayLayers, setOverlayLayers] = useState<Record<OverlayLayerKey, boolean>>({
    template: false,
    projected: true,
    adaptive: true,
    words: false,
    anchors: false,
  });

  useEffect(() => {
    if (!file || file.type === "application/pdf") {
      setPreviewUrl("");
      return;
    }
    const nextUrl = URL.createObjectURL(file);
    setPreviewUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  const pages = result?.pages || [];
  const currentPage = pages[pageIndex] || pages[0] || null;
  const bestCandidate = result?.bestCandidate || null;
  const visibleCandidates = currentPage?.candidates.length ? currentPage.candidates : result?.candidates || [];
  const verificationCandidate = bestCandidate || currentPage?.bestCandidate || visibleCandidates[0] || null;
  const alignmentCandidate = currentPage?.bestCandidate || bestCandidate || visibleCandidates[0] || null;
  const currentAlignment = alignmentOf(alignmentCandidate);
  const currentAlignmentDebug = alignmentDebugOf(alignmentCandidate);
  const currentAlignmentStatus = alignmentStatus(alignmentCandidate);
  const verificationSourceUsed =
    alignmentCandidate?.verificationSourceUsed ||
    (currentAlignmentDebug.verification_source_used === "aligned" || currentAlignmentDebug.verification_source_used === "normalized"
      ? currentAlignmentDebug.verification_source_used
      : null);
  const alignmentReason =
    alignmentCandidate?.alignmentReason ||
    (currentAlignmentDebug.alignment_reason as string | undefined) ||
    (currentAlignmentDebug.reason as string | undefined);
  const alignmentPrecheck =
    currentAlignmentDebug.precheck && typeof currentAlignmentDebug.precheck === "object"
      ? (currentAlignmentDebug.precheck as Record<string, unknown>)
      : null;
  const orbExecuted = currentAlignmentDebug.orb_executed === true;
  const homographyFound = currentAlignmentDebug.homography_found === true || currentAlignment.homography_found === true;
  const alignedImagePreviewUrl = previewSrc(alignmentCandidate?.alignedImagePreviewUrl || (currentAlignment.aligned_image_preview_url as string | null | undefined));
  const originalImagePreviewUrl = previewSrc(currentPage?.imagePreviewDataUrl || previewUrl);
  const normalizedImagePreviewUrl = previewSrc(
    currentPage?.normalizedImagePreviewUrl || (currentPage?.debug?.normalized_image_preview_url as string | undefined) || currentPage?.imagePreviewDataUrl
  );
  const extractionImagePreviewUrl = previewSrc(alignmentCandidate?.extractionImagePreviewUrl);
  const effectivePreviewUrl =
    currentAlignmentStatus === "aligned" && alignedImagePreviewUrl ? alignedImagePreviewUrl : normalizedImagePreviewUrl || currentPage?.imagePreviewDataUrl || "";
  const effectivePreviewLabel = currentAlignmentStatus === "aligned" && alignedImagePreviewUrl ? "Aligned Image" : "Normalized Image";
  const effectivePreviewBadge =
    currentAlignmentStatus === "aligned"
      ? "Aligned image used for verification"
      : currentAlignmentStatus === "skipped"
        ? "Alignment skipped: normalized image used"
        : currentAlignmentStatus === "fallback"
          ? "Alignment fallback: normalized image used"
          : currentAlignmentStatus === "failed"
            ? "Alignment failed: normalized image used"
            : "Pipeline image";
  const currentVerificationFields = verificationFields(verificationCandidate);
  const isPdf = file?.type === "application/pdf";
  const sourceType = typeof result?.debug?.source_type === "string" ? result.debug.source_type : isPdf ? "pdf" : "image";
  const convertedPageCount = typeof result?.debug?.converted_page_count === "number" ? result.debug.converted_page_count : 0;
  const inputPageCount = typeof result?.debug?.input_page_count === "number" ? result.debug.input_page_count : pages.length;
  const pipelineImageSteps = [
    {
      title: sourceType === "pdf" ? "PDF Page Image" : "Uploaded Image",
      description:
        sourceType === "pdf"
          ? "The uploaded PDF page is converted to an image before detection."
          : "The original uploaded image used as the detection input.",
      src: originalImagePreviewUrl,
      status: sourceType === "pdf" ? "converted" : "input",
    },
    {
      title: "Normalized Image",
      description: "The image after the normalization stage. Current normalization may preserve the original image when correction is bypassed.",
      src: normalizedImagePreviewUrl,
      status: "preprocess",
    },
    {
      title: "Template Alignment",
      description:
        currentAlignmentStatus === "aligned"
          ? "ORB alignment produced a warped image and this image was used for verification."
          : currentAlignmentStatus === "skipped"
            ? "Alignment was skipped because geometry already matched the template tolerance."
          : currentAlignmentStatus === "fallback"
              ? alignmentReason === "aligned_verification_worse_than_normalized"
                ? "Alignment produced a warped image, but OCR verification was better on the normalized image. The aligned image was not used."
                : "Alignment was attempted but the normalized image was safer, so fallback was used."
              : "Alignment failed or was unavailable, so the normalized image was used.",
      src: alignedImagePreviewUrl || normalizedImagePreviewUrl,
      status: alignmentLabel(alignmentCandidate),
    },
    {
      title: "Final ROI/OCR Image",
      description: "The final image shown with ROI overlays. Extraction and verification are interpreted against this image.",
      src: extractionImagePreviewUrl || effectivePreviewUrl,
      status: verificationSourceUsed === "aligned" ? "aligned" : "normalized",
    },
  ];
  const projectionCandidate = verificationCandidate || alignmentCandidate;
  const projectedOverlayFields = projectionCandidate?.projectedFields || [];
  const matchedAnchors = Array.isArray(projectionCandidate?.projection?.matched_anchors)
    ? (projectionCandidate?.projection?.matched_anchors as Record<string, unknown>[])
    : [];

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] || null;
    setError("");
    setResult(null);
    setPageIndex(0);
    if (!nextFile) {
      setFile(null);
      return;
    }
    const isSupported =
      nextFile.type === "application/pdf" ||
      nextFile.type === "image/png" ||
      nextFile.type === "image/jpeg" ||
      nextFile.type === "image/webp";
    if (!isSupported) {
      setFile(null);
      setError("Please choose a PNG, JPEG, WebP, or PDF file.");
      return;
    }
    setFile(nextFile);
  };

  const runDetection = async () => {
    if (!file) {
      setError("Please select an image or PDF first.");
      return;
    }
    setIsRunning(true);
    setError("");
    setResult(null);
    setPageIndex(0);
    try {
      setResult(await detectTemplateDev(file));
    } catch (err) {
      console.warn("Detection lab failed.", err);
      setError(err instanceof Error ? err.message : "Detection failed.");
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-black text-slate-900">Detection Lab</h2>
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-black uppercase text-amber-700">DEV</span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">Real Detection Pipeline</span>
            </div>
            <p className="mt-2 text-sm font-semibold text-slate-500">
              Upload an image or multi-page PDF. PDFs are converted into page images before template matching.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Test Document</h3>
          <label className="mt-3 flex cursor-pointer flex-col rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-xs font-bold text-slate-600 hover:bg-white">
            <input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={handleFileChange} className="sr-only" />
            <span className="text-sm font-black text-slate-800">Choose PNG, JPEG, WebP, or multi-page PDF</span>
            <span className="mt-1">{file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : "No file selected"}</span>
            {file && (
              <span className="mt-2 rounded-lg bg-white px-2 py-1 text-[10px] font-black uppercase text-slate-500">
                {isPdf ? "PDF will be converted to images" : "Single image input"}
              </span>
            )}
          </label>

          <button
            type="button"
            onClick={runDetection}
            disabled={!file || isRunning}
            className="ui-stable-action-lg mt-4 w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-black text-white disabled:bg-slate-300 disabled:text-slate-500"
          >
            {isRunning ? "Running Detection..." : "Run Detection"}
          </button>
          {error && <p className="mt-3 rounded-xl bg-red-50 p-3 text-xs font-bold text-red-700">{error}</p>}

          <div className="mt-4">
            {previewUrl ? (
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                <img src={previewUrl} alt="Detection lab upload preview" className="max-h-[380px] w-full object-contain" />
              </div>
            ) : file?.type === "application/pdf" ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs font-semibold text-slate-500">
                PDF selected. Each page will be rendered as an image after detection runs.
              </div>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs font-semibold text-slate-500">No preview yet.</div>
            )}
          </div>
        </section>

        <section className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Detection Result</h3>
            {!result ? (
              <p className="mt-3 rounded-xl bg-slate-50 p-4 text-xs font-semibold text-slate-500">Run detection to see matching candidates.</p>
            ) : (
              <div className="mt-3 space-y-3 text-xs font-semibold text-slate-700">
                <div className="flex flex-wrap gap-2 text-[10px] font-black uppercase">
                  <span className={`rounded-full px-2.5 py-1 ${result.matched ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                    Matched {result.matched ? "YES" : "NO"}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">Threshold {result.threshold}</span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">Pages {inputPageCount || result.pages.length || 1}</span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">{sourceType === "pdf" ? "PDF converted to images" : "Image input"}</span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">{result.version}</span>
                </div>
                {sourceType === "pdf" && (
                  <p className="rounded-xl bg-sky-50 p-3 font-bold text-sky-700">
                    Converted {convertedPageCount || pages.length} PDF page{(convertedPageCount || pages.length) === 1 ? "" : "s"} into PNG previews for detection.
                  </p>
                )}

                {bestCandidate ? (
                  <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-3 text-indigo-900">
                    <div className="text-[10px] font-black uppercase tracking-wider text-indigo-700">Best Candidate</div>
                    <div className="mt-2 grid gap-1 sm:grid-cols-2">
                      <p>Template: {bestCandidate.templateName || "N/A"}</p>
                      <p>Template ID: {bestCandidate.templateId || "N/A"}</p>
                      <p>Final Score: {formatScore(bestCandidate.finalScore ?? bestCandidate.score)}</p>
                      <p>Retrieval Score: {formatScore(bestCandidate.retrievalScore)}</p>
                      <p>Verification Score: {formatScore(bestCandidate.verificationScore)}</p>
                      <p>Text Anchor Score: {formatScore(bestCandidate.textAnchorScore)}</p>
                      <p>Image Anchor Score: {formatScore(bestCandidate.imageAnchorScore)}</p>
                      <p>Matched Pages: {bestCandidate.matchedPages ?? "N/A"}</p>
                      <p>Decision: {bestCandidate.decisionReason || "N/A"}</p>
                      <p>Status: {bestCandidate.templateStatus || "N/A"}</p>
                      <p>Vector ID: {bestCandidate.vectorId || "N/A"}</p>
                      <p>Pages: {bestCandidate.pageCount ?? "N/A"}</p>
                      <p>Fields: {bestCandidate.fieldCount ?? "N/A"}</p>
                      <p>Model: {bestCandidate.modelName || "N/A"}</p>
                      <p>Vector Store: {bestCandidate.vectorStoreEngine || "N/A"}</p>
                      <p>Threshold: {formatScore(bestCandidate.finalConfidenceThreshold)}</p>
                      <p>Alignment Status: {alignmentLabel(bestCandidate)}</p>
                      <p>Alignment Score: {formatScore(bestCandidate.alignmentScore)}</p>
                    </div>
                  </div>
                ) : result.message ? (
                  <p className="rounded-xl bg-amber-50 p-3 font-bold text-amber-700">{result.message}</p>
                ) : (
                  <p className="rounded-xl bg-amber-50 p-3 font-bold text-amber-700">No template matched the threshold.</p>
                )}

                {!result.matched && result.candidates.length > 0 && (
                  <p className="rounded-xl bg-amber-50 p-3 font-bold text-amber-700">No template matched the threshold.</p>
                )}
                {result.candidates.length === 0 && (
                  <p className="rounded-xl bg-amber-50 p-3 font-bold text-amber-700">
                    No embedded active templates found. Please validate and run embedding for at least one template first.
                  </p>
                )}
              </div>
            )}
          </div>

          {pages.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Page Results</h3>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    {sourceType === "pdf" ? "PDF pages converted to images" : "Uploaded image"} · Page {currentPage?.pageIndex || 1} of {pages.length}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {pages.map((page, index) => (
                    <button
                      key={`detection-lab-page-${page.pageIndex}`}
                      type="button"
                      onClick={() => setPageIndex(index)}
                      className={`rounded-lg px-3 py-1.5 text-[10px] font-black ${
                        pageIndex === index ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-600"
                      }`}
                    >
                      Page {page.pageIndex}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px]">
                <div>
                  <section className="mb-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                      <div>
                        <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Image Processing Sequence</h3>
                        <p className="mt-1 text-xs font-semibold text-slate-500">
                          Images are shown in the order used by the detection pipeline, ending with the final ROI/OCR view.
                        </p>
                      </div>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">
                        Page {currentPage?.pageIndex || 1}
                      </span>
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      {pipelineImageSteps.map((item, index) => (
                        <PipelineImageCard
                          key={`pipeline-image-${index}`}
                          step={index + 1}
                          title={item.title}
                          description={item.description}
                          src={item.src}
                          status={item.status}
                        />
                      ))}
                    </div>
                  </section>

                  {effectivePreviewUrl && (
                    <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                      <div className="flex flex-col gap-3 border-b border-slate-200 bg-white p-3 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                          <div className="text-[10px] font-black uppercase tracking-wider text-slate-500">{effectivePreviewLabel}</div>
                          <div className="mt-1 text-xs font-semibold text-slate-600">{effectivePreviewBadge}</div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {overlayLayerOptions.map((layer) => (
                            <button
                              key={layer.key}
                              type="button"
                              onClick={() => setOverlayLayers((current) => ({ ...current, [layer.key]: !current[layer.key] }))}
                              className={`rounded-lg border px-2.5 py-1.5 text-[10px] font-black uppercase ${
                                overlayLayers[layer.key] ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-slate-50 text-slate-500"
                              }`}
                            >
                              {layer.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="relative mx-auto max-h-[460px] w-full">
                        <img src={effectivePreviewUrl} alt={`${effectivePreviewLabel} page ${currentPage?.pageIndex || 1}`} className="max-h-[460px] w-full object-contain" />
                        <div className="pointer-events-none absolute inset-0">
                          {overlayLayers.template &&
                            projectedOverlayFields.map((field, index) => {
                              const style = ratioStyle(field.templateRoi);
                              return style ? <div key={`template-${field.fieldId}-${index}`} className="absolute border-2 border-red-500 bg-red-500/10" style={style} /> : null;
                            })}
                          {overlayLayers.projected &&
                            projectedOverlayFields.map((field, index) => {
                              const style = ratioStyle(field.projectedRoi as Record<string, unknown>);
                              return style ? <div key={`projected-${field.fieldId}-${index}`} className="absolute border-2 border-orange-500 bg-orange-500/10" style={style} /> : null;
                            })}
                          {overlayLayers.adaptive &&
                            projectedOverlayFields.map((field, index) => {
                              const style = ratioStyle(field.adaptiveRoi as Record<string, unknown>);
                              return style ? <div key={`adaptive-${field.fieldId}-${index}`} className="absolute border-2 border-emerald-500 bg-emerald-500/10" style={style} /> : null;
                            })}
                          {overlayLayers.words &&
                            projectedOverlayFields.flatMap((field, fieldIndex) =>
                              (field.adaptiveWordBoxes || []).map((box, wordIndex) => {
                                const style = ratioStyle((box.bbox as Record<string, unknown> | undefined) || null);
                                return style ? <div key={`word-${fieldIndex}-${wordIndex}`} className="absolute border border-sky-500 bg-sky-500/10" style={style} /> : null;
                              })
                            )}
                          {overlayLayers.anchors &&
                            matchedAnchors.map((anchor, index) => {
                              const style = ratioStyle(anchor.expected_bbox as Record<string, unknown> | undefined);
                              return style ? <div key={`anchor-${index}`} className="absolute border-2 border-purple-500 bg-purple-500/10" style={style} /> : null;
                            })}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 border-t border-slate-200 bg-white p-3 text-[10px] font-black uppercase text-slate-500">
                        {overlayLayerOptions.map((layer) => (
                          <span key={`legend-${layer.key}`} className="inline-flex items-center gap-1.5">
                            <span className={`h-3 w-3 rounded border ${layer.className}`} />
                            {layer.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {currentPage && (
                    <div className="mt-3 rounded-xl border border-slate-200 p-3 text-xs font-semibold text-slate-700">
                      Page {currentPage.pageIndex}: {currentPage.matched ? "Matched" : "No match"}
                      {currentPage.bestCandidate ? `, final score ${formatScore(currentPage.bestCandidate.finalScore ?? currentPage.bestCandidate.score)}` : ""}
                    </div>
                  )}
                  <details className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
                    <summary className="cursor-pointer text-[10px] font-black uppercase tracking-wider text-slate-600">
                      Alignment Debug
                    </summary>
                    {!alignmentCandidate ? (
                      <p className="mt-3 text-xs font-semibold text-slate-500">No candidate selected for alignment debug.</p>
                    ) : (
                      <div className="mt-3 grid gap-2 text-xs font-semibold text-slate-700 sm:grid-cols-2">
                        <p>Candidate: {alignmentCandidate.templateName || "N/A"}</p>
                        <p>
                          Alignment Status:{" "}
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase ${alignmentBadgeClass(alignmentCandidate)}`}>
                            {alignmentLabel(alignmentCandidate)}
                          </span>
                        </p>
                        <p>Verification Source Used: {readText(verificationSourceUsed)}</p>
                        <p>
                          Normalized Verification:{" "}
                          {readScore(
                            currentAlignmentDebug.normalized_verification_score ??
                              currentAlignmentDebug.before_alignment_verification ??
                              alignmentCandidate.normalizedVerificationScore ??
                            alignmentCandidate.beforeAlignmentVerification
                          )}
                        </p>
                        <p>Reason: {readText(alignmentReason)}</p>
                        {currentAlignmentStatus === "skipped" && (
                          <div className="rounded-lg bg-slate-50 p-3 font-bold text-slate-700 sm:col-span-2">
                            <p>Alignment Status: Skipped</p>
                            <p className="mt-2 font-semibold">
                              The uploaded document already matches the template geometry within the acceptable tolerance.
                              OCR verification was performed using the normalized image. No geometric correction was required.
                            </p>
                          </div>
                        )}
                        {orbExecuted && (
                          <>
                            <p>Method: {readText(currentAlignmentDebug.method)}</p>
                            <p>ORB Executed: true</p>
                            <p>Raw Matches: {readValue(currentAlignmentDebug.raw_matches)}</p>
                            <p>Good Matches: {readValue(currentAlignmentDebug.good_matches)}</p>
                            <p>Query Keypoints: {readValue(currentAlignmentDebug.query_keypoints)}</p>
                            <p>Template Keypoints: {readValue(currentAlignmentDebug.template_keypoints)}</p>
                            <p>Inliers: {readValue(currentAlignmentDebug.inliers)}</p>
                            <p>Outliers: {readValue(currentAlignmentDebug.outliers)}</p>
                            <p>Inlier Ratio: {readScore(currentAlignmentDebug.inlier_ratio)}</p>
                            {homographyFound && (
                              <>
                                <p>Homography Found: true</p>
                                <p>Warp Applied: {readBool(currentAlignmentDebug.warp_applied)}</p>
                                <p>Reprojection Error (px): {readScore(currentAlignmentDebug.reprojection_error_px ?? currentAlignmentDebug.reprojection_error)}</p>
                              </>
                            )}
                            {currentAlignmentStatus === "aligned" && (
                              <>
                                <p>Alignment Score: {readScore(currentAlignmentDebug.alignment_score ?? alignmentCandidate.alignmentScore)}</p>
                                <p>
                                  Aligned Verification:{" "}
                                  {readScore(
                                    currentAlignmentDebug.aligned_verification_score ??
                                      currentAlignmentDebug.after_alignment_verification ??
                                      alignmentCandidate.alignedVerificationScore ??
                                      alignmentCandidate.afterAlignmentVerification
                                  )}
                                </p>
                              </>
                            )}
                          </>
                        )}
                        {currentAlignmentStatus === "fallback" && (
                          <p className="rounded-lg bg-amber-50 p-2 font-bold text-amber-700 sm:col-span-2">
                            {alignmentReason === "aligned_verification_worse_than_normalized"
                              ? "Fallback: alignment completed, but normalized OCR verification was better. The warped image was not used."
                              : "Fallback: alignment was attempted, but it could not produce a usable transformed image. OCR verification used the normalized image."}
                          </p>
                        )}
                        {currentAlignmentStatus === "failed" && (
                          <p className="rounded-lg bg-red-50 p-2 font-bold text-red-700 sm:col-span-2">
                            Failed: alignment encountered an unexpected error. OCR verification used the normalized image.
                          </p>
                        )}
                        {currentAlignmentStatus === "failed" && <p className="sm:col-span-2">error: {readText(currentAlignment.error)}</p>}
                        {alignmentPrecheck && (
                          <details className="rounded-lg border border-slate-200 bg-slate-50 p-2 sm:col-span-2">
                            <summary className="cursor-pointer text-[10px] font-black uppercase tracking-wider text-slate-600">
                              Alignment Pre-check
                            </summary>
                            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-slate-900 p-3 text-[10px] font-semibold text-slate-100">
                              {JSON.stringify(alignmentPrecheck, null, 2)}
                            </pre>
                          </details>
                        )}
                        {homographyFound && Array.isArray(currentAlignment.homography) && (
                          <details className="rounded-lg border border-slate-200 bg-slate-50 p-2 sm:col-span-2">
                            <summary className="cursor-pointer text-[10px] font-black uppercase tracking-wider text-slate-600">
                              Homography Matrix
                            </summary>
                            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-slate-900 p-3 text-[10px] font-semibold text-slate-100">
                              {JSON.stringify(currentAlignment.homography, null, 2)}
                            </pre>
                          </details>
                        )}
                      </div>
                    )}
                  </details>
                </div>

                <div className="max-h-[540px] space-y-2 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-2">
                  {pages.map((page, index) => (
                    <button
                      key={`detection-page-thumb-${page.pageIndex}`}
                      type="button"
                      onClick={() => setPageIndex(index)}
                      className={`w-full rounded-lg border p-2 text-left ${
                        pageIndex === index ? "border-indigo-400 bg-white shadow-sm" : "border-slate-200 bg-white/70"
                      }`}
                    >
                      {page.imagePreviewDataUrl && (
                        <img src={page.imagePreviewDataUrl} alt={`Page ${page.pageIndex} thumbnail`} className="h-28 w-full rounded-md object-contain" />
                      )}
                      <div className="mt-2 flex items-center justify-between text-[10px] font-black uppercase">
                        <span className="text-slate-700">Page {page.pageIndex}</span>
                        <span className={page.matched ? "text-emerald-600" : "text-slate-400"}>{page.matched ? "Matched" : "No match"}</span>
                      </div>
                      <p className="mt-1 truncate text-[10px] font-semibold text-slate-500">
                        {page.bestCandidate?.templateName || "No candidate"}
                        {page.bestCandidate ? ` · ${formatScore(page.bestCandidate.score)}` : ""}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            </section>
          )}

          {result && (
            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <details>
                <summary className="cursor-pointer text-xs font-black uppercase tracking-wider text-slate-700">
                  Verification Details
                </summary>
                {!verificationCandidate ? (
                  <p className="mt-3 rounded-xl bg-slate-50 p-3 text-xs font-semibold text-slate-500">No candidate available for verification details.</p>
                ) : currentVerificationFields.length === 0 ? (
                  <p className="mt-3 rounded-xl bg-slate-50 p-3 text-xs font-semibold text-slate-500">
                    {readText(verificationCandidate.verification?.status)}. No verification fields were checked.
                  </p>
                ) : (
                  <div className="mt-3 space-y-2">
                    <div className="rounded-xl bg-slate-50 p-3 text-xs font-semibold text-slate-600">
                      Candidate: {verificationCandidate.templateName || "N/A"} · Decision: {verificationCandidate.decisionPath || verificationCandidate.decisionReason || "N/A"}
                    </div>
                    {verificationCandidate.projection && (
                      <details className="rounded-xl border border-emerald-100 bg-emerald-50 p-3">
                        <summary className="cursor-pointer text-[10px] font-black uppercase tracking-wider text-emerald-800">
                          ROI Projection
                        </summary>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                          <DebugMetric label="Status" value={readText(verificationCandidate.projection.status)} />
                          <DebugMetric label="Method" value={readText(verificationCandidate.projection.method)} />
                          <DebugMetric label="Anchors Matched" value={readText(verificationCandidate.projection.anchors_matched)} />
                          <DebugMetric label="Confidence" value={readScore(verificationCandidate.projection.confidence)} />
                          <DebugMetric label="Inliers" value={readText(verificationCandidate.projection.inliers)} />
                          <DebugMetric label="Reprojection Error" value={readScore(verificationCandidate.projection.reprojection_error)} />
                          <DebugMetric label="Projected Fields" value={readText(verificationCandidate.projectedFields?.length ?? 0)} />
                          <DebugMetric
                            label="Adaptive Refined"
                            value={readText((verificationCandidate.projection.adaptive_refinement as Record<string, unknown> | undefined)?.text_fields_refined)}
                          />
                          <DebugMetric
                            label="Adaptive Fallback"
                            value={readText((verificationCandidate.projection.adaptive_refinement as Record<string, unknown> | undefined)?.text_fields_fallback)}
                          />
                          <DebugMetric
                            label="Avg Adaptive Confidence"
                            value={readScore((verificationCandidate.projection.adaptive_refinement as Record<string, unknown> | undefined)?.average_adaptive_confidence)}
                          />
                          <DebugMetric
                            label="Avg Coverage"
                            value={readScore((verificationCandidate.projection.adaptive_refinement as Record<string, unknown> | undefined)?.average_coverage)}
                          />
                          <DebugMetric
                            label="Avg OCR Confidence"
                            value={readScore((verificationCandidate.projection.adaptive_refinement as Record<string, unknown> | undefined)?.average_ocr_confidence)}
                          />
                          <DebugMetric label="Fallback Reason" value={readText(verificationCandidate.projection.fallback_reason)} />
                        </div>
                        {verificationCandidate.projectedFields && verificationCandidate.projectedFields.length > 0 && (
                          <div className="mt-3 overflow-hidden rounded-xl border border-emerald-100 bg-white">
                            <table className="w-full text-left text-xs">
                              <thead className="bg-emerald-50 text-[10px] font-black uppercase tracking-wider text-emerald-800">
                                <tr>
                                  <th className="px-3 py-2">Field</th>
                                  <th className="px-3 py-2">Projection</th>
                                  <th className="px-3 py-2">Before Clip</th>
                                  <th className="px-3 py-2">After Clip</th>
                                  <th className="px-3 py-2">Validation</th>
                                  <th className="px-3 py-2">Adaptive</th>
                                  <th className="px-3 py-2">Confidence</th>
                                  <th className="px-3 py-2">Coverage</th>
                                  <th className="px-3 py-2">Word Boxes</th>
                                  <th className="px-3 py-2">Reason</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-emerald-50 font-semibold text-slate-700">
                                {verificationCandidate.projectedFields.map((field, index) => (
                                  <tr key={`${field.fieldId || "projected"}-${index}`}>
                                    <td className="px-3 py-2">{field.displayLabel || field.fieldName || "N/A"}</td>
                                    <td className="px-3 py-2">{field.projectionMethod || "N/A"}</td>
                                    <td className="px-3 py-2">
                                      {field.projectedRoiBeforeClip
                                        ? `${formatScore(field.projectedRoiBeforeClip.x_ratio)} / ${formatScore(field.projectedRoiBeforeClip.y_ratio)} / ${formatScore(field.projectedRoiBeforeClip.width_ratio)} / ${formatScore(field.projectedRoiBeforeClip.height_ratio)}`
                                        : "N/A"}
                                    </td>
                                    <td className="px-3 py-2">
                                      {field.projectedRoi
                                        ? `${formatScore(field.projectedRoi.x_ratio)} / ${formatScore(field.projectedRoi.y_ratio)} / ${formatScore(field.projectedRoi.width_ratio)} / ${formatScore(field.projectedRoi.height_ratio)}`
                                        : "N/A"}
                                    </td>
                                    <td className="px-3 py-2">
                                      {field.projectionValidationResult
                                        ? `${field.projectionValidationResult.passed === true ? "passed" : "failed"} ${
                                            Array.isArray(field.projectionValidationResult.errors) && field.projectionValidationResult.errors.length
                                              ? `(${field.projectionValidationResult.errors.join(", ")})`
                                              : Array.isArray(field.projectionValidationResult.warnings) && field.projectionValidationResult.warnings.length
                                                ? `(${field.projectionValidationResult.warnings.join(", ")})`
                                                : ""
                                          }`
                                        : "N/A"}
                                    </td>
                                    <td className="px-3 py-2">{field.adaptiveStatus || "N/A"}</td>
                                    <td className="px-3 py-2">{formatScore(field.adaptiveConfidence)}</td>
                                    <td className="px-3 py-2">{formatScore(field.adaptiveCoverage)}</td>
                                    <td className="px-3 py-2">{field.adaptiveWordBoxes?.length ?? 0}</td>
                                    <td className="px-3 py-2">{field.adaptiveFallbackReason || "N/A"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </details>
                    )}
                    <div className="overflow-hidden rounded-xl border border-slate-200">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-wider text-slate-500">
                          <tr>
                            <th className="px-3 py-2">Field</th>
                            <th className="px-3 py-2">Expected</th>
                            <th className="px-3 py-2">Actual</th>
                            <th className="px-3 py-2">Match</th>
                            <th className="px-3 py-2">Score</th>
                            <th className="px-3 py-2">Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                          {currentVerificationFields.map((field, index) => (
                            <tr key={`${readText(field.field_id)}-${index}`}>
                              <td className="px-3 py-2">{readText(field.field_name)}</td>
                              <td className="px-3 py-2 align-top">{renderVerificationExpected(field)}</td>
                              <td className="px-3 py-2 align-top">{renderVerificationActual(field)}</td>
                              <td className="px-3 py-2">{readText(field.match_type)}</td>
                              <td className="px-3 py-2">{readScore(field.field_score ?? field.score)}</td>
                              <td className="px-3 py-2">{readText(field.failure_reason || field.error)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <details className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <summary className="cursor-pointer text-[10px] font-black uppercase tracking-wider text-slate-600">
                        Show Debug Details
                      </summary>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        {currentVerificationFields.map((field, index) => (
                          <div key={`verification-debug-${readText(field.field_id)}-${index}`} className="rounded-xl border border-slate-200 bg-white p-3 text-xs font-semibold text-slate-600">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <div className="font-black text-slate-900">{readText(field.field_name)}</div>
                                <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                                  {isImageVerificationField(field) ? "Image Anchor" : "Text Anchor"}
                                </div>
                              </div>
                              <span className="rounded-full bg-indigo-100 px-2 py-1 text-[10px] font-black uppercase text-indigo-700">
                                Final input {readScore(field.field_score ?? field.score)}
                              </span>
                            </div>
                            {isImageVerificationField(field) && (
                              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                <div>
                                  <div className="mb-1 text-[9px] font-black uppercase tracking-wider text-orange-700">Expected Reference</div>
                                  {renderVerificationExpected(field)}
                                </div>
                                <div>
                                  <div className="mb-1 text-[9px] font-black uppercase tracking-wider text-sky-700">Actual Crop</div>
                                  {renderVerificationActual(field)}
                                </div>
                              </div>
                            )}
                            <div className="mt-3 grid gap-2 sm:grid-cols-2">
                              <DebugMetric label="Normalized Expected" value={readText(field.normalized_expected)} />
                              <DebugMetric label="Normalized Actual" value={readText(field.normalized_actual)} />
                              <DebugMetric label="Text Similarity" value={readScore(field.text_similarity_score)} />
                              <DebugMetric label="OCR Confidence" value={readScore(field.ocr_confidence)} />
                              <DebugMetric label="DINO Similarity" value={readScore(field.dino_similarity_score)} />
                              <DebugMetric label="Threshold" value={readScore(field.verification_threshold)} />
                              <DebugMetric label="Field Score" value={readScore(field.field_score ?? field.score)} />
                              <DebugMetric label="Reason" value={readText(field.failure_reason || field.error)} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                )}
              </details>
            </section>
          )}

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Candidates</h3>
            <div className="mt-3 overflow-hidden rounded-xl border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Rank</th>
                    <th className="px-3 py-2">Template Name</th>
                    <th className="px-3 py-2">Final</th>
                    <th className="px-3 py-2">Retrieval</th>
                    <th className="px-3 py-2">Verification</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                  {visibleCandidates.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-center text-slate-500">
                        No candidates to display.
                      </td>
                    </tr>
                  ) : (
                    visibleCandidates.map((candidate, index) => (
                      <tr key={`${candidate.vectorId || "candidate"}-${index}`}>
                        <td className="px-3 py-2">{index + 1}</td>
                        <td className="px-3 py-2">{candidate.templateName || "N/A"}</td>
                        <td className="px-3 py-2">{formatScore(candidate.finalScore ?? candidate.score)}</td>
                        <td className="px-3 py-2">{formatScore(candidate.retrievalScore)}</td>
                        <td className="px-3 py-2">
                          {formatScore(candidate.verificationScore)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </section>
      </div>
    </section>
  );
}
