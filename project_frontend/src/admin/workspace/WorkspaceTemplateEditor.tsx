"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2, Move, ScanSearch } from "lucide-react";
import { WorkspacePage } from "../../shared/workspace/BaseWorkspace";
import WorkspaceCustomEditor from "../../shared/workspace/WorkspaceCustomEditor";
import TemplateFieldBasicForm from "./TemplateFieldBasicForm";
import TemplateFieldOCRSettings from "./TemplateFieldOCRSettings";
import { DEFAULT_WORKSPACE_IMAGE_METRICS, ratioToImageBox, WorkspaceImageMetrics } from "../../shared/workspace/roiGeometry";
import { IgnoreRegion, ROI, RoiRatio, TemplateField } from "../../types/ocr";
import { ADMIN_API_BASE_URL } from "../adminApi";

interface WorkspaceTemplateEditorProps {
  pages: WorkspacePage[];
  currentPage: number;
  onPageChange: (pageIndex: number) => void;
  fields: TemplateField[];
  ignoreRegions: IgnoreRegion[];
  onBackToAdjust: () => void;
  onAddField: (roi?: RoiRatio, defaults?: Partial<TemplateField>) => void;
  onUpdateField: (fieldId: string, patch: Partial<TemplateField>) => void;
  onDeleteField: (fieldId: string) => void;
  onAddIgnoreRegion: (roi?: RoiRatio) => void;
  onUpdateIgnoreRegion: (regionId: string, patch: Partial<IgnoreRegion>) => void;
  onDeleteIgnoreRegion: (regionId: string) => void;
  onGenerateEmbedding: () => void;
  onRunTestMode: () => void;
}

type EditorMode = "template_fields" | "ignore_regions";
type FieldEditorStep = "define_fields" | "ocr_configuration";
type AdminRoi = ROI & {
  pageIndex?: number;
  sourceId?: string;
  workspaceKind?: EditorMode;
};

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 outline-none focus:border-indigo-500";

const clampRatio = (value: number) => Math.min(1, Math.max(0, value));

const MIN_AUTO_ROI_RATIO = 0.004;

interface OcrDetectedLine {
  fieldName?: string;
  text?: string;
  confidence?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  bbox?: [number, number][];
}

const stableNumericId = (value: string) =>
  Math.abs(value.split("").reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7));

const fieldDataTypeToRoiType = (dataType?: TemplateField["dataType"]): ROI["type"] => {
  if (dataType === "table") return "table";
  if (dataType === "image") return "image";
  return "text";
};

const roiTypeToFieldDataType = (type?: ROI["type"]): TemplateField["dataType"] => {
  if (type === "table") return "table";
  if (type === "image") return "image";
  return "text";
};

const boxToRatio = (roi: ROI, pageNumber: number, metrics: WorkspaceImageMetrics): RoiRatio => ({
  pageNumber,
  xRatio: clampRatio((roi.x - metrics.imageOffsetX) / Math.max(metrics.imageWidth, 1)),
  yRatio: clampRatio((roi.y - metrics.imageOffsetY) / Math.max(metrics.imageHeight, 1)),
  widthRatio: clampRatio(roi.width / Math.max(metrics.imageWidth, 1)),
  heightRatio: clampRatio(roi.height / Math.max(metrics.imageHeight, 1)),
});

const loadImageElement = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });

const ocrLineToRoi = (line: OcrDetectedLine, pageNumber: number, naturalWidth: number, naturalHeight: number): RoiRatio | null => {
  let x = Number(line.x);
  let y = Number(line.y);
  let width = Number(line.width);
  let height = Number(line.height);

  if ((!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) && line.bbox?.length) {
    const xs = line.bbox.map((point) => Number(point[0])).filter(Number.isFinite);
    const ys = line.bbox.map((point) => Number(point[1])).filter(Number.isFinite);
    if (xs.length && ys.length) {
      x = Math.min(...xs);
      y = Math.min(...ys);
      width = Math.max(...xs) - x;
      height = Math.max(...ys) - y;
    }
  }

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return null;

  const xRatio = clampRatio(x / Math.max(naturalWidth, 1));
  const yRatio = clampRatio(y / Math.max(naturalHeight, 1));
  const widthRatio = clampRatio(width / Math.max(naturalWidth, 1));
  const heightRatio = clampRatio(height / Math.max(naturalHeight, 1));

  if (widthRatio < MIN_AUTO_ROI_RATIO || heightRatio < MIN_AUTO_ROI_RATIO) return null;

  return { pageNumber, xRatio, yRatio, widthRatio, heightRatio };
};

const fieldToRoi = (field: TemplateField, metrics: WorkspaceImageMetrics): AdminRoi => {
  const box = ratioToImageBox(field.roi, metrics);
  return {
    id: stableNumericId(`field:${field.id}`),
    sourceId: field.id,
    workspaceKind: "template_fields",
    fieldName: field.displayLabel || field.fieldName,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    pageIndex: field.pageNumber - 1,
    type: fieldDataTypeToRoiType(field.dataType),
  };
};

const ignoreRegionToRoi = (region: IgnoreRegion, metrics: WorkspaceImageMetrics): AdminRoi => {
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

export default function WorkspaceTemplateEditor({
  pages,
  currentPage,
  onPageChange,
  fields,
  ignoreRegions,
  onBackToAdjust,
  onAddField,
  onUpdateField,
  onDeleteField,
  onAddIgnoreRegion,
  onUpdateIgnoreRegion,
  onDeleteIgnoreRegion,
  onGenerateEmbedding,
  onRunTestMode,
}: WorkspaceTemplateEditorProps) {
  const [mode, setMode] = useState<EditorMode>("template_fields");
  const [fieldEditorStep, setFieldEditorStep] = useState<FieldEditorStep>("define_fields");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedTemplateFieldId, setSelectedTemplateFieldId] = useState<string | null>(null);
  const [imageMetrics, setImageMetrics] = useState<WorkspaceImageMetrics>(DEFAULT_WORKSPACE_IMAGE_METRICS);
  const [autoDetectStatus, setAutoDetectStatus] = useState("");
  const [isAutoDetecting, setIsAutoDetecting] = useState(false);
  const pendingCreatedRoiRef = useRef<{ mode: EditorMode; roi: RoiRatio } | null>(null);
  const currentPageNumber = currentPage + 1;
  const selectedPage = pages[currentPage];

  const adminRois = useMemo(
    () => [
      ...fields.map((field) => fieldToRoi(field, imageMetrics)),
      ...ignoreRegions.map((region) => ignoreRegionToRoi(region, imageMetrics)),
    ],
    [fields, ignoreRegions, imageMetrics]
  );

  const templateFieldRois = useMemo(
    () => adminRois.filter((roi) => roi.workspaceKind === "template_fields"),
    [adminRois]
  );

  const selectedRoi = adminRois.find((roi) => roi.id === selectedId);
  const selectedField =
    (selectedTemplateFieldId ? fields.find((field) => field.id === selectedTemplateFieldId) : null) ||
    (selectedRoi?.workspaceKind === "template_fields" ? fields.find((field) => field.id === selectedRoi.sourceId) : null);
  const selectedIgnoreRegion =
    selectedRoi?.workspaceKind === "ignore_regions" ? ignoreRegions.find((region) => region.id === selectedRoi.sourceId) : null;
  const selectedOcrField = selectedField || fields.find((field) => field.pageNumber === currentPageNumber) || fields[0] || null;
  const selectedOcrFieldId = selectedOcrField?.id ?? null;
  const currentPageFields = fields.filter((field) => field.pageNumber === currentPageNumber);

  useEffect(() => {
    const pendingCreatedRoi = pendingCreatedRoiRef.current;
    if (pendingCreatedRoi) {
      const source = pendingCreatedRoi.mode === "template_fields" ? fields : ignoreRegions;
      const createdItem = source.find(
        (item) =>
          item.pageNumber === pendingCreatedRoi.roi.pageNumber &&
          Math.abs(item.roi.xRatio - pendingCreatedRoi.roi.xRatio) < 0.001 &&
          Math.abs(item.roi.yRatio - pendingCreatedRoi.roi.yRatio) < 0.001 &&
          Math.abs(item.roi.widthRatio - pendingCreatedRoi.roi.widthRatio) < 0.001 &&
          Math.abs(item.roi.heightRatio - pendingCreatedRoi.roi.heightRatio) < 0.001
      );

      if (createdItem) {
        pendingCreatedRoiRef.current = null;
        if (pendingCreatedRoi.mode === "template_fields") {
          setSelectedTemplateFieldId(createdItem.id);
          setSelectedId(stableNumericId(`field:${createdItem.id}`));
        } else {
          setSelectedTemplateFieldId(null);
          setSelectedId(stableNumericId(`ignore:${createdItem.id}`));
        }
        return;
      }
    }

    if (selectedId === null) return;
    const selectedStillExists = adminRois.some((roi) => roi.id === selectedId);
    if (!selectedStillExists) {
      setSelectedId(null);
      setSelectedTemplateFieldId(null);
    }
  }, [adminRois, fields, ignoreRegions, selectedId]);

  const selectTemplateField = useCallback(
    (field: TemplateField) => {
      setSelectedTemplateFieldId(field.id);
      setSelectedId(stableNumericId(`field:${field.id}`));
      if (field.pageNumber - 1 !== currentPage) {
        onPageChange(field.pageNumber - 1);
      }
    },
    [currentPage, onPageChange]
  );

  const selectTemplateFieldByRoiId = useCallback(
    (value: number | null | ((previous: number | null) => number | null)) => {
      setSelectedId((previousSelectedId) => {
        const roiId = typeof value === "function" ? value(previousSelectedId) : value;
        if (roiId === null) {
          setSelectedTemplateFieldId(null);
          return null;
        }

        const roi = templateFieldRois.find((item) => item.id === roiId);
        if (!roi?.sourceId) {
          setSelectedTemplateFieldId(null);
          return roiId;
        }

        const field = fields.find((item) => item.id === roi.sourceId);
        if (field) {
          setSelectedTemplateFieldId(field.id);
          if (field.pageNumber - 1 !== currentPage) {
            onPageChange(field.pageNumber - 1);
          }
        }
        return roiId;
      });
    },
    [currentPage, fields, onPageChange, templateFieldRois]
  );

  const selectAdminRoi = useCallback(
    (value: number | null | ((previous: number | null) => number | null)) => {
      setSelectedId((previousSelectedId) => {
        const nextSelectedId = typeof value === "function" ? value(previousSelectedId) : value;
        const roi = adminRois.find((item) => item.id === nextSelectedId);
        if (roi?.workspaceKind === "template_fields" && roi.sourceId) {
          const field = fields.find((item) => item.id === roi.sourceId);
          if (field) {
            setSelectedTemplateFieldId(field.id);
            if (field.pageNumber - 1 !== currentPage) {
              onPageChange(field.pageNumber - 1);
            }
            return nextSelectedId;
          }
        }
        setSelectedTemplateFieldId(null);
        return nextSelectedId;
      });
    },
    [adminRois, currentPage, fields, onPageChange]
  );

  const goToOcrConfiguration = () => {
    if (fields.length === 0) return;
    if (!selectedField) {
      selectTemplateField(fields[0]);
    }
    setMode("template_fields");
    setFieldEditorStep("ocr_configuration");
  };

  const handleAutoDetectOcrFields = async () => {
    if (!selectedPage?.src || isAutoDetecting) return;

    setMode("template_fields");
    setAutoDetectStatus("");
    setIsAutoDetecting(true);

    try {
      const image = await loadImageElement(selectedPage.src);
      const response = await fetch(`${ADMIN_API_BASE_URL}/api/ai/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: selectedPage.src,
          rois: [],
        }),
      });
      const result = await response.json();

      if (!response.ok || !result?.success) {
        throw new Error(result?.detail || result?.error || "OCR auto ROI failed.");
      }

      const detectedLines = (result.extracted_data || []) as OcrDetectedLine[];
      const existingFieldCount = fields.length;
      const created = detectedLines.reduce((count, line) => {
        const roi = ocrLineToRoi(line, currentPageNumber, image.naturalWidth, image.naturalHeight);
        if (!roi) return count;

        const fieldNumber = existingFieldCount + count + 1;
        const fieldName = `field_${fieldNumber}`;

        pendingCreatedRoiRef.current = { mode: "template_fields", roi };
        onAddField(roi, {
          fieldName,
          displayLabel: `Field ${fieldNumber}`,
          dataType: "text",
          extractionMethod: "ocr_text",
        });
        return count + 1;
      }, 0);

      setAutoDetectStatus(
        created > 0
          ? `Created ${created} OCR ROI field${created === 1 ? "" : "s"} on page ${currentPageNumber}.`
          : "OCR did not find usable text regions on this page."
      );
    } catch (error) {
      console.error("Auto ROI detection failed.", error);
      setAutoDetectStatus(error instanceof Error ? error.message : "Auto ROI detection failed.");
    } finally {
      setIsAutoDetecting(false);
    }
  };

  const persistRoiChanges = (nextRois: AdminRoi[] | ((prev: AdminRoi[]) => AdminRoi[])) => {
    const resolved = typeof nextRois === "function" ? nextRois(adminRois) : nextRois;
    const previousById = new Map(adminRois.map((roi) => [roi.id, roi]));
    const nextById = new Map(resolved.map((roi) => [roi.id, roi]));

    resolved.forEach((roi) => {
      const previous = previousById.get(roi.id);
      if (!previous) {
        const ratio = boxToRatio(roi, currentPageNumber, imageMetrics);
        pendingCreatedRoiRef.current = { mode, roi: ratio };
        if (mode === "template_fields") {
          onAddField(ratio);
        } else {
          onAddIgnoreRegion(ratio);
        }
        return;
      }

      if (
        previous.x !== roi.x ||
        previous.y !== roi.y ||
        previous.width !== roi.width ||
        previous.height !== roi.height
      ) {
        const ratio = boxToRatio(roi, (roi.pageIndex ?? currentPage) + 1, imageMetrics);
        if (previous.workspaceKind === "template_fields" && previous.sourceId) {
          onUpdateField(previous.sourceId, { roi: ratio });
        }
        if (previous.workspaceKind === "ignore_regions" && previous.sourceId) {
          onUpdateIgnoreRegion(previous.sourceId, { roi: ratio });
        }
      }

      if (previous.fieldName !== roi.fieldName && previous.sourceId) {
        if (previous.workspaceKind === "template_fields") {
          onUpdateField(previous.sourceId, { fieldName: roi.fieldName, displayLabel: roi.fieldName });
        } else {
          onUpdateIgnoreRegion(previous.sourceId, { fieldName: roi.fieldName.replace(/^Ignore:\s*/, "") });
        }
      }

      if (previous.type !== roi.type && previous.workspaceKind === "template_fields" && previous.sourceId) {
        onUpdateField(previous.sourceId, { dataType: roiTypeToFieldDataType(roi.type) });
      }
    });

    adminRois.forEach((roi) => {
      if (!nextById.has(roi.id) && (roi.pageIndex ?? 0) === currentPage && roi.sourceId) {
        if (roi.workspaceKind === "template_fields") {
          onDeleteField(roi.sourceId);
        } else {
          onDeleteIgnoreRegion(roi.sourceId);
        }
      }
    });
  };

  if (fieldEditorStep === "ocr_configuration") {
    return (
      <div className="mx-auto max-w-7xl space-y-5 pb-20">
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-sm font-black uppercase tracking-wide text-slate-800">2.2 Configure OCR</h2>
              <p className="mt-1 text-xs font-semibold text-slate-500">
                Configure extraction and verification behavior for the template fields created in Step 2.1.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setFieldEditorStep("define_fields")}
              className="w-fit rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700 hover:bg-slate-50"
            >
              Back to Define Fields
            </button>
          </div>
        </section>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_240px_360px]">
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3">
              <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Document Preview</h3>
              <p className="mt-1 text-[11px] font-semibold text-slate-500">
                Read-only ROI preview using the same pan and zoom viewport as Custom OCR.
              </p>
            </div>
            <WorkspaceCustomEditor
              previewUrl={selectedPage?.src || ""}
              image={selectedPage?.src || null}
              brightness={100}
              contrast={100}
              rotation={0}
              rois={templateFieldRois}
              setRois={() => {}}
              selectedId={selectedId}
              setSelectedId={selectTemplateFieldByRoiId}
              onBackToAdjust={onBackToAdjust}
              deleteROI={() => {}}
              isLoading={false}
              onRunOCR={() => {}}
              onRunFullPageOCR={async () => {}}
              currentIndex={currentPage}
              imagesList={pages.map((page) => page.src)}
              onIndexChange={onPageChange}
              hideOcrActions
              readOnly
              hideStepProgress
              hideRightPanel
              workspaceHeightClassName="h-[560px]"
              rootClassName="space-y-3"
              onImageMetricsChange={setImageMetrics}
              getRoiClassName={(roi, selected) => {
                const dimmed = selectedId !== null && !selected;
                return `rnd-box-item border transition-shadow pointer-events-auto ${
                  selected
                    ? "border-sky-500 bg-sky-400/25 shadow-md z-40 ring-4 ring-sky-300/45"
                    : dimmed
                      ? "border-slate-300 bg-slate-200/10 opacity-25 z-10"
                      : "border-indigo-400/80 bg-indigo-50/5 hover:border-indigo-500 hover:bg-indigo-50/10 z-20"
                }`;
              }}
              getRoiLabelClassName={(roi, selected) => {
                const dimmed = selectedId !== null && !selected;
                return `absolute -top-5 left-0 px-1.5 py-0.5 text-[9px] font-sans rounded shadow border flex items-center gap-1.5 pointer-events-auto cursor-pointer ${
                  selected
                    ? "bg-sky-600 border-sky-600 text-white font-extrabold"
                    : dimmed
                      ? "bg-white border-slate-200 text-slate-400"
                      : "bg-white border-indigo-200 text-indigo-700 font-bold"
                }`;
              }}
            />
          </section>

          <aside className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Page {currentPage + 1} Fields</h3>
            <div className="mt-2 space-y-1.5">
              {fields.length === 0 ? (
                <p className="rounded-lg bg-slate-50 p-2.5 text-xs font-semibold text-slate-500">
                  Create at least one field first.
                </p>
              ) : currentPageFields.length === 0 ? (
                <p className="rounded-lg bg-slate-50 p-2.5 text-xs font-semibold text-slate-500">
                  No template fields on this page.
                </p>
              ) : (
                currentPageFields.map((field) => (
                  <button
                    key={field.id}
                    type="button"
                    onClick={() => selectTemplateField(field)}
                    className={`w-full rounded-lg border px-2.5 py-2 text-left text-xs transition-colors ${
                      selectedOcrFieldId === field.id
                        ? "border-sky-300 bg-sky-50 text-sky-900 shadow-sm"
                        : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-white"
                    }`}
                  >
                    <div className="truncate font-black">{field.displayLabel || field.fieldName}</div>
                    <div className="mt-0.5 truncate text-[10px] font-bold text-slate-500">{field.fieldName}</div>
                    <div className="mt-1 text-[9px] font-black uppercase tracking-wide text-slate-400">
                      {field.dataType || "text"}
                    </div>
                  </button>
                ))
              )}
            </div>
          </aside>

          <main className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            {selectedOcrField ? (
              <div className="space-y-4">
                <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">ข้อมูลที่เลือก</h3>
                  <div className="mt-2 grid gap-2 text-xs font-semibold text-slate-600 sm:grid-cols-2">
                    <div>
                      <span className="block text-[9px] font-black uppercase text-slate-400">ชื่อ Field</span>
                      {selectedOcrField.fieldName}
                    </div>
                    <div>
                      <span className="block text-[9px] font-black uppercase text-slate-400">ชื่อที่แสดง</span>
                      {selectedOcrField.displayLabel}
                    </div>
                    <div>
                      <span className="block text-[9px] font-black uppercase text-slate-400">ประเภทข้อมูล</span>
                      {selectedOcrField.dataType || "text"}
                    </div>
                    <div>
                      <span className="block text-[9px] font-black uppercase text-slate-400">หน้า</span>
                      หน้า {selectedOcrField.pageNumber}
                    </div>
                  </div>
                  {selectedOcrField.pageNumber !== currentPage + 1 && (
                    <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-700">
                      Selected field belongs to Page {selectedOcrField.pageNumber}.
                    </p>
                  )}
                </section>

                <TemplateFieldOCRSettings field={selectedOcrField} onUpdate={onUpdateField} />

                <div className="flex flex-col gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={() => setFieldEditorStep("define_fields")}
                    className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700 hover:bg-slate-50"
                  >
                    Back to Define Fields
                  </button>
                  <button
                    type="button"
                    onClick={onRunTestMode}
                    className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white"
                  >
                    Test Mode
                  </button>
                </div>
              </div>
            ) : (
              <p className="rounded-xl bg-slate-50 p-4 text-sm font-semibold text-slate-500">
                Create at least one field first.
              </p>
            )}
          </main>
        </div>
      </div>
    );
  }

  return (
    <WorkspaceCustomEditor
      previewUrl={selectedPage?.src || ""}
      image={selectedPage?.src || null}
      brightness={100}
      contrast={100}
      rotation={0}
      rois={adminRois}
      setRois={persistRoiChanges}
      selectedId={selectedId}
      setSelectedId={selectAdminRoi}
      onBackToAdjust={onBackToAdjust}
      deleteROI={(id) => {
        const roi = adminRois.find((item) => item.id === id);
        if (!roi?.sourceId) return;
        if (roi.workspaceKind === "template_fields") onDeleteField(roi.sourceId);
        if (roi.workspaceKind === "ignore_regions") onDeleteIgnoreRegion(roi.sourceId);
      }}
      isLoading={false}
      onRunOCR={() => {}}
      onRunFullPageOCR={async () => {}}
      currentIndex={currentPage}
      imagesList={pages.map((page) => page.src)}
      onIndexChange={onPageChange}
      hideOcrActions
      onImageMetricsChange={setImageMetrics}
      getRoiClassName={(roi, selected, activeTool) => {
        const adminRoi = roi as AdminRoi;
        const isIgnore = adminRoi.workspaceKind === "ignore_regions";
        if (isIgnore) {
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
        const isIgnore = (roi as AdminRoi).workspaceKind === "ignore_regions";
        if (isIgnore) {
          return `absolute -top-5 left-0 px-1.5 py-0.5 text-[9px] font-sans rounded shadow border flex items-center gap-1.5 pointer-events-auto cursor-pointer ${
            selected ? "bg-amber-700 border-amber-700 text-white font-extrabold" : "bg-white border-amber-200 text-amber-700 font-bold"
          }`;
        }
        return `absolute -top-5 left-0 px-1.5 py-0.5 text-[9px] font-sans rounded shadow border flex items-center gap-1.5 pointer-events-auto cursor-pointer ${
          selected ? "bg-sky-600 border-sky-600 text-white font-extrabold" : "bg-white border-indigo-200 text-indigo-700 font-bold"
        }`;
      }}
      rightPanelRenderer={({ currentPageRois: panelRois, setSelectedId: selectRoi, updateROI }) => (
        <>
          <button
            type="button"
            onClick={onBackToAdjust}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100"
          >
            <ArrowLeft size={14} />
            Back to Adjust Image
          </button>

          <section className="space-y-2">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">ROI Mode</h3>
            <div className="grid grid-cols-2 rounded-xl border border-slate-200 bg-slate-50 p-1">
              <button type="button" onClick={() => setMode("template_fields")} className={`rounded-lg px-3 py-2 text-[10px] font-black ${mode === "template_fields" ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500"}`}>
                Template Fields
              </button>
              <button type="button" onClick={() => setMode("ignore_regions")} className={`rounded-lg px-3 py-2 text-[10px] font-black ${mode === "ignore_regions" ? "bg-white text-amber-700 shadow-sm" : "text-slate-500"}`}>
                Ignore Regions
              </button>
            </div>
          </section>

          <section className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Current Page ROI</h3>
              <span className="text-[10px] font-bold text-slate-400">{panelRois.length}</span>
            </div>
            <button
              type="button"
              onClick={handleAutoDetectOcrFields}
              disabled={isAutoDetecting || !selectedPage?.src}
              className="w-full rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-black text-indigo-700 shadow-sm hover:bg-indigo-50"
            >
              <span className="inline-flex items-center justify-center gap-1.5">
                {isAutoDetecting ? <Loader2 size={13} className="animate-spin" /> : <ScanSearch size={13} />}
                ตีกรอบ ROI อัตโนมัติจาก OCR
              </span>
            </button>
            <p className="text-[10px] font-semibold leading-relaxed text-slate-500">
              สแกนข้อความบนหน้าปัจจุบัน แล้วสร้าง Template Field ตามกรอบที่ OCR อ่านได้ จากนั้นกดเลือก field เพื่อเปลี่ยนชื่อหรือ Type ต่อได้
            </p>
            {autoDetectStatus && (
              <p className={`rounded-lg px-2.5 py-2 text-[10px] font-bold ${autoDetectStatus.startsWith("Created") ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                {autoDetectStatus}
              </p>
            )}
            <div className="max-h-52 space-y-1.5 overflow-y-auto pr-1">
              {panelRois.length === 0 ? (
                <p className="text-xs font-semibold text-slate-400">No ROI on this page.</p>
              ) : (
                panelRois.map((roi) => {
                  const adminRoi = roi as AdminRoi;
                  const isIgnore = adminRoi.workspaceKind === "ignore_regions";
                  const isSelected = selectedId === roi.id;
                  const roiTypeLabel = roi.type === "table" ? "Table" : roi.type === "image" ? "Image" : "Text";
                  return (
                    <button
                      key={`admin-roi-${roi.id}`}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => selectRoi(roi.id)}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2 py-2 text-left text-[11px] font-bold transition-all ${
                        isSelected
                          ? isIgnore
                            ? "border-amber-500 bg-amber-100 text-amber-900 shadow-sm ring-2 ring-amber-200"
                            : "border-sky-500 bg-sky-100 text-sky-900 shadow-sm ring-2 ring-sky-200"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Move size={11} className={`shrink-0 ${isSelected ? (isIgnore ? "text-amber-700" : "text-sky-700") : "text-slate-400"}`} />
                        <span className="truncate">{roi.fieldName}</span>
                      </span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] ${isIgnore ? "bg-amber-200 text-amber-800" : "bg-sky-200 text-sky-800"}`}>
                        {isIgnore ? "Ignore" : roiTypeLabel}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          {mode === "template_fields" && selectedField && fieldEditorStep === "define_fields" && (
            <TemplateFieldBasicForm field={selectedField} onUpdate={onUpdateField} onDelete={onDeleteField} />
          )}

          {mode === "ignore_regions" && selectedIgnoreRegion && (
            <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
              <h3 className="text-xs font-black uppercase tracking-wider text-amber-800">Ignore Region</h3>
              <input
                className={inputClass}
                value={selectedIgnoreRegion.fieldName}
                onChange={(event) => {
                  onUpdateIgnoreRegion(selectedIgnoreRegion.id, { fieldName: event.target.value });
                  if (selectedId !== null) updateROI(selectedId, { fieldName: `Ignore: ${event.target.value}` });
                }}
              />
              <button type="button" onClick={() => onDeleteIgnoreRegion(selectedIgnoreRegion.id)} className="w-full rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-black text-red-700">
                Delete Ignore Region
              </button>
            </section>
          )}

          {mode === "template_fields" && !selectedField && (
            <p className="rounded-xl bg-slate-50 p-3 text-xs font-semibold text-slate-500">
              Select a template field ROI or draw on the page to create one.
            </p>
          )}

          {mode === "template_fields" && fields.length === 0 && (
            <p className="rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-700">
              Create at least one field first.
            </p>
          )}

          {mode === "ignore_regions" && !selectedIgnoreRegion && (
            <p className="rounded-xl bg-slate-50 p-3 text-xs font-semibold text-slate-500">
              Select an ignore region or draw on the page to create one.
            </p>
          )}

          <section className="space-y-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={goToOcrConfiguration}
              disabled={fields.length === 0}
              className="w-full rounded-xl bg-indigo-600 px-3 py-2 text-xs font-black text-white disabled:bg-slate-300 disabled:text-slate-500"
            >
              Next: Configure OCR
            </button>
          </section>
        </>
      )}
    />
  );
}
