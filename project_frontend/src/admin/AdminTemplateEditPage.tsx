"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import WorkspaceTemplateEditor from "./workspace/WorkspaceTemplateEditorV2";
import AdjustZone from "../user/components/AdjustZone";
import { samplePage } from "./adminMockData";
import { useAdminState } from "./AdminState";
import {
  createIgnoreRegionApi,
  createTemplateFieldApi,
  createTemplatePageApi,
  deleteIgnoreRegionApi,
  deleteTemplateFieldApi,
  deleteTemplatePageApi,
  fetchTemplateBundle,
  updateIgnoreRegionApi,
  updateTemplateApi,
  updateTemplateFieldApi,
  updateTemplatePageApi,
} from "./adminApi";
import type { IgnoreRegion, RoiRatio, Template, TemplateField, TemplatePage } from "../types/ocr";

type LoadStatus = "loading" | "loaded" | "fallback" | "error";
type AdminEditorStage = "adjust" | "roi";

interface AdminAdjustPageConfig {
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

interface AutoDetectedTemplateField {
  roi: RoiRatio;
  defaults: Partial<TemplateField>;
}

const defaultRoi = (pageNumber: number): RoiRatio => ({
  pageNumber,
  xRatio: 0.1,
  yRatio: 0.2,
  widthRatio: 0.32,
  heightRatio: 0.06,
});

const defaultAdjustPageConfig = (): AdminAdjustPageConfig => ({
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
});

export default function AdminTemplateEditPage({ templateId }: { templateId: string }) {
  const router = useRouter();
  const {
    templates,
    pages,
    fields,
    ignoreRegions,
    generateEmbedding,
    markTesting,
  } = useAdminState();

  const fallbackTemplate = templates.find((template) => template.id === templateId) || null;
  const fallbackPages = pages.filter((page) => page.templateId === templateId);
  const fallbackFields = fields.filter((field) => field.templateId === templateId);
  const fallbackIgnoreRegions = ignoreRegions.filter((region) => region.templateId === templateId);

  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(fallbackTemplate);
  const [selectedTemplatePages, setSelectedTemplatePages] = useState<TemplatePage[]>(fallbackPages);
  const [selectedTemplateFields, setSelectedTemplateFields] = useState<TemplateField[]>(fallbackFields);
  const [selectedIgnoreRegions, setSelectedIgnoreRegions] = useState<IgnoreRegion[]>(fallbackIgnoreRegions);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [saveStatus, setSaveStatus] = useState("");
  const [currentPage, setCurrentPage] = useState(0);
  const [editorStage, setEditorStage] = useState<AdminEditorStage>("adjust");
  const [adjustPageConfigs, setAdjustPageConfigs] = useState<AdminAdjustPageConfig[]>([]);
  const localFieldSequenceRef = useRef(0);

  const applyBundle = (bundle: { template: Template; pages: TemplatePage[]; fields: TemplateField[]; ignoreRegions: IgnoreRegion[] }) => {
    setSelectedTemplate(bundle.template);
    setSelectedTemplatePages(bundle.pages);
    setSelectedTemplateFields(bundle.fields);
    setSelectedIgnoreRegions(bundle.ignoreRegions);
  };

  useEffect(() => {
    let cancelled = false;

    const loadTemplate = async () => {
      setLoadStatus("loading");
      try {
        const bundle = await fetchTemplateBundle(templateId);
        if (cancelled) return;
        applyBundle(bundle);
        setLoadStatus("loaded");
      } catch (error) {
        console.warn("Using template editor fallback because backend template data is unavailable.", error);
        if (cancelled) return;
        setSelectedTemplate(fallbackTemplate);
        setSelectedTemplatePages(fallbackPages);
        setSelectedTemplateFields(fallbackFields);
        setSelectedIgnoreRegions(fallbackIgnoreRegions);
        setLoadStatus(fallbackTemplate ? "fallback" : "error");
      }
    };

    loadTemplate();
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  const imageList = useMemo(
    () => selectedTemplatePages.map((page) => page.normalizedImageUrl || page.sampleImageUrl || samplePage),
    [selectedTemplatePages]
  );

  const workspacePages = selectedTemplatePages.map((page, index) => ({
    id: page.id,
    src: imageList[index] || samplePage,
    label: page.pageName || `Page ${page.pageNumber}`,
  }));

  useEffect(() => {
    setAdjustPageConfigs((current) => {
      if (current.length === selectedTemplatePages.length) return current;
      return selectedTemplatePages.map((_, index) => current[index] || defaultAdjustPageConfig());
    });
  }, [selectedTemplatePages.length]);

  const safeCurrentPage = Math.min(currentPage, Math.max(selectedTemplatePages.length - 1, 0));
  const currentTemplatePage = selectedTemplatePages[safeCurrentPage];
  const extractionFieldCount = selectedTemplateFields.filter((field) => !field.useForVerification).length;
  const verificationAnchorCount = selectedTemplateFields.filter((field) => field.useForVerification).length;

  const setSaved = (message: string) => setSaveStatus(message);
  const setLocalOnly = (message: string) => setSaveStatus(`${message} Backend unavailable; kept local edit.`);
  const canPersistToBackend = loadStatus === "loaded";

  const handleConfirmAdjustedImages = async (finalImages: string[]) => {
    if (finalImages.length === 0) return;

    const previousPages = selectedTemplatePages;
    const nextPages = selectedTemplatePages.map((page, index) => ({
      ...page,
      normalizedImageUrl: finalImages[index] || page.normalizedImageUrl || page.sampleImageUrl || samplePage,
    }));
    setSelectedTemplatePages(nextPages);
    setCurrentPage(0);
    setEditorStage("roi");

    if (!canPersistToBackend) {
      setLocalOnly("Adjusted images saved locally.");
      return;
    }

    try {
      let latestBundle: Awaited<ReturnType<typeof updateTemplatePageApi>> | null = null;
      for (const page of nextPages) {
        if (!page.id.startsWith("local_page_")) {
          latestBundle = await updateTemplatePageApi(templateId, page.id, {
            normalizedImageUrl: page.normalizedImageUrl,
          });
        }
      }
      if (latestBundle) applyBundle(latestBundle);
      setSaved("Adjusted images saved. Workspace ROI is ready.");
    } catch (error) {
      console.warn("Adjusted image save failed.", error);
      setSelectedTemplatePages(nextPages.length > 0 ? nextPages : previousPages);
      setLocalOnly("Adjusted images saved locally.");
    }
  };

  const persistTemplatePatch = async (patch: Partial<Template>) => {
    if (!selectedTemplate) return;
    setSelectedTemplate({ ...selectedTemplate, ...patch });
    if (!canPersistToBackend) {
      setLocalOnly("Template saved locally.");
      return;
    }
    try {
      const bundle = await updateTemplateApi(templateId, patch);
      applyBundle(bundle);
      setSaved("Template saved.");
    } catch (error) {
      console.warn("Template save failed.", error);
      setLocalOnly("Template saved locally.");
    }
  };

  const handleAddPage = () => {
    const nextPageNumber = selectedTemplatePages.length + 1;
    const optimisticPage: TemplatePage = {
      id: `local_page_${Date.now()}`,
      templateId,
      pageNumber: nextPageNumber,
      pageName: `Page ${nextPageNumber}`,
      sampleImageUrl: samplePage,
      normalizedImageUrl: samplePage,
      similarityThreshold: selectedTemplate?.similarityThreshold ?? 0.75,
      finalConfidenceThreshold: selectedTemplate?.finalConfidenceThreshold ?? 0.8,
    };
    setSelectedTemplatePages((prev) => [...prev, optimisticPage]);

    if (!canPersistToBackend) {
      setLocalOnly("Page added locally.");
      return;
    }

    createTemplatePageApi(templateId, nextPageNumber, samplePage)
      .then((bundle) => {
        applyBundle(bundle);
        setSaved("Page saved.");
      })
      .catch((error) => {
        console.warn("Page create failed.", error);
        setLocalOnly("Page added locally.");
      });
  };

  const handleUpdatePage = (pageId: string, patch: Partial<TemplatePage>) => {
    setSelectedTemplatePages((prev) => prev.map((page) => (page.id === pageId ? { ...page, ...patch } : page)));
    if (!canPersistToBackend || pageId.startsWith("local_page_")) {
      setLocalOnly("Page saved locally.");
      return;
    }

    updateTemplatePageApi(templateId, pageId, patch)
      .then((bundle) => {
        applyBundle(bundle);
        setSaved("Page saved.");
      })
      .catch((error) => {
        console.warn("Page update failed.", error);
        setLocalOnly("Page saved locally.");
      });
  };

  const handleRemovePage = (pageId: string) => {
    const previousPages = selectedTemplatePages;
    const previousFields = selectedTemplateFields;
    const previousIgnoreRegions = selectedIgnoreRegions;
    setSelectedTemplatePages((prev) => prev.filter((page) => page.id !== pageId));
    setSelectedTemplateFields((prev) => prev.filter((field) => field.templatePageId !== pageId));
    setSelectedIgnoreRegions((prev) => prev.filter((region) => region.templatePageId !== pageId));
    setCurrentPage(0);

    if (!canPersistToBackend || pageId.startsWith("local_page_")) {
      setLocalOnly("Page removed locally.");
      return;
    }

    deleteTemplatePageApi(templateId, pageId)
      .then((bundle) => {
        applyBundle(bundle);
        setSaved("Page removed.");
      })
      .catch((error) => {
        console.warn("Page delete failed.", error);
        if (!pageId.startsWith("local_page_")) {
          setSelectedTemplatePages(previousPages);
          setSelectedTemplateFields(previousFields);
          setSelectedIgnoreRegions(previousIgnoreRegions);
        }
        setLocalOnly("Page removal could not be persisted.");
      });
  };

  const handleAddField = (roi?: RoiRatio, defaults?: Partial<TemplateField>) => {
    if (!currentTemplatePage) return;
    const nextIndex = selectedTemplateFields.length + 1;
    const nextRoi = roi || defaultRoi(currentTemplatePage.pageNumber);
    localFieldSequenceRef.current += 1;
    const optimisticField: TemplateField = {
      id: `local_field_${Date.now()}_${localFieldSequenceRef.current}`,
      templateId,
      templatePageId: currentTemplatePage.id,
      pageNumber: currentTemplatePage.pageNumber,
      fieldName: defaults?.fieldName || `field_${nextIndex}`,
      displayLabel: defaults?.displayLabel || defaults?.fieldName || `Field ${nextIndex}`,
      roi: nextRoi,
      dataType: defaults?.dataType || "text",
      userSelectable: defaults?.userSelectable ?? true,
      defaultSelected: defaults?.defaultSelected ?? true,
      useForVerification: defaults?.useForVerification ?? false,
      expectedText: defaults?.expectedText || "",
      matchType: defaults?.matchType || "",
      requiredForVerification: defaults?.requiredForVerification ?? false,
      extractionMethod:
        defaults?.extractionMethod ||
        (defaults?.dataType === "image" ? "extract_image" : defaults?.dataType === "table" ? "table_recognition_v2" : "paddle_thai_ocr"),
      roiPadding: defaults?.roiPadding ?? 0,
      verificationWeight: defaults?.verificationWeight ?? 1,
      sortOrder: nextIndex,
    };
    setSelectedTemplateFields((prev) => [...prev, optimisticField]);

    if (!canPersistToBackend) {
      setLocalOnly("Field added locally.");
      return;
    }

    createTemplateFieldApi(templateId, optimisticField)
      .then((bundle) => {
        applyBundle(bundle);
        setSaved("Field saved.");
      })
      .catch((error) => {
        console.warn("Field create failed.", error);
        setLocalOnly("Field added locally.");
      });
  };

  const handleUpdateField = (fieldId: string, patch: Partial<TemplateField>) => {
    setSelectedTemplateFields((prev) => prev.map((field) => (field.id === fieldId ? { ...field, ...patch } : field)));
    if (!canPersistToBackend || fieldId.startsWith("local_field_")) {
      setLocalOnly("Field saved locally.");
      return;
    }

    updateTemplateFieldApi(templateId, fieldId, patch)
      .then((bundle) => {
        applyBundle(bundle);
        setSaved("Field saved.");
      })
      .catch((error) => {
        console.warn("Field update failed.", error);
        setLocalOnly("Field saved locally.");
      });
  };

  const handleReorderFields = (orderedFieldIds: string[]) => {
    const orderMap = new Map(orderedFieldIds.map((fieldId, index) => [fieldId, index + 1]));
    const previousFields = selectedTemplateFields;
    const changedFields = previousFields
      .filter((field) => orderMap.has(field.id) && field.sortOrder !== orderMap.get(field.id))
      .map((field) => ({ ...field, sortOrder: orderMap.get(field.id) || field.sortOrder || 0 }));

    if (changedFields.length === 0) return;

    setSelectedTemplateFields((prev) =>
      prev.map((field) => {
        const nextSortOrder = orderMap.get(field.id);
        return nextSortOrder ? { ...field, sortOrder: nextSortOrder } : field;
      })
    );

    const fieldsToPersist = changedFields.filter((field) => !field.id.startsWith("local_field_"));
    if (!canPersistToBackend || fieldsToPersist.length === 0) {
      setLocalOnly("Field order saved locally.");
      return;
    }

    Promise.all(fieldsToPersist.map((field) => updateTemplateFieldApi(templateId, field.id, { sortOrder: field.sortOrder })))
      .then((bundles) => {
        const latestBundle = bundles[bundles.length - 1];
        if (latestBundle) applyBundle(latestBundle);
        setSaved("Field order saved.");
      })
      .catch((error) => {
        console.warn("Field reorder failed.", error);
        setSelectedTemplateFields(previousFields);
        setLocalOnly("Field order could not be persisted.");
      });
  };

  const handleDeleteField = (fieldId: string) => {
    const previousFields = selectedTemplateFields;
    setSelectedTemplateFields((prev) => prev.filter((field) => field.id !== fieldId));
    if (!canPersistToBackend || fieldId.startsWith("local_field_")) {
      setLocalOnly("Field deleted locally.");
      return;
    }

    deleteTemplateFieldApi(templateId, fieldId)
      .then((bundle) => {
        applyBundle(bundle);
        setSaved("Field deleted.");
      })
      .catch((error) => {
        console.warn("Field delete failed.", error);
        setSelectedTemplateFields(previousFields);
        setLocalOnly("Field delete could not be persisted.");
      });
  };

  const handleReplacePageExtractionFields = (pageNumber: number, detectedFields: AutoDetectedTemplateField[]) => {
    const targetPage = selectedTemplatePages.find((page) => page.pageNumber === pageNumber);
    if (!targetPage) return;

    const previousFields = selectedTemplateFields;
    const fieldsToDelete = previousFields.filter((field) => field.pageNumber === pageNumber && !field.useForVerification);
    const remainingFields = previousFields.filter((field) => !(field.pageNumber === pageNumber && !field.useForVerification));

    const optimisticFields = detectedFields.map(({ roi, defaults }, index) => {
      localFieldSequenceRef.current += 1;
      const fieldNumber = index + 1;
      const fieldName = defaults.fieldName || `field_${fieldNumber}`;
      return {
        id: `local_field_${Date.now()}_${localFieldSequenceRef.current}`,
        templateId,
        templatePageId: targetPage.id,
        pageNumber,
        fieldName,
        displayLabel: defaults.displayLabel || fieldName,
        roi,
        dataType: defaults.dataType || "text",
        userSelectable: defaults.userSelectable ?? true,
        defaultSelected: defaults.defaultSelected ?? true,
        useForVerification: false,
        expectedText: "",
        matchType: "",
        requiredForVerification: false,
        extractionMethod:
          defaults.extractionMethod ||
          (defaults.dataType === "image" ? "extract_image" : defaults.dataType === "table" ? "table_recognition_v2" : "paddle_thai_ocr"),
        roiPadding: defaults.roiPadding ?? 0,
        verificationWeight: defaults.verificationWeight ?? 1,
        sortOrder: fieldNumber,
      } satisfies TemplateField;
    });

    setSelectedTemplateFields([...remainingFields, ...optimisticFields]);

    if (!canPersistToBackend) {
      setLocalOnly("Auto ROI fields replaced locally.");
      return;
    }

    (async () => {
      try {
        for (const field of fieldsToDelete) {
          if (!field.id.startsWith("local_field_")) {
            await deleteTemplateFieldApi(templateId, field.id);
          }
        }

        let latestBundle: Awaited<ReturnType<typeof createTemplateFieldApi>> | null = null;
        for (const field of optimisticFields) {
          latestBundle = await createTemplateFieldApi(templateId, field);
        }

        if (latestBundle) {
          applyBundle(latestBundle);
        } else {
          const bundle = await fetchTemplateBundle(templateId);
          applyBundle(bundle);
        }
        setSaved(`Auto ROI replaced ${fieldsToDelete.length} old fields with ${optimisticFields.length} fields.`);
      } catch (error) {
        console.warn("Auto ROI replace failed.", error);
        setSelectedTemplateFields(previousFields);
        setLocalOnly("Auto ROI replace could not be persisted.");
      }
    })();
  };

  const handleAddIgnoreRegion = (roi?: RoiRatio) => {
    if (!currentTemplatePage) return;
    const nextIndex = selectedIgnoreRegions.length + 1;
    const nextRoi = roi || {
      pageNumber: currentTemplatePage.pageNumber,
      xRatio: 0.5,
      yRatio: 0.25,
      widthRatio: 0.22,
      heightRatio: 0.08,
    };
    const optimisticRegion: IgnoreRegion = {
      id: `local_ignore_${Date.now()}`,
      templateId,
      templatePageId: currentTemplatePage.id,
      pageNumber: currentTemplatePage.pageNumber,
      fieldName: `ignore_region_${nextIndex}`,
      roi: nextRoi,
    };
    setSelectedIgnoreRegions((prev) => [...prev, optimisticRegion]);

    if (!canPersistToBackend) {
      setLocalOnly("Ignore region added locally.");
      return;
    }

    createIgnoreRegionApi(templateId, optimisticRegion)
      .then((bundle) => {
        applyBundle(bundle);
        setSaved("Ignore region saved.");
      })
      .catch((error) => {
        console.warn("Ignore region create failed.", error);
        setLocalOnly("Ignore region added locally.");
      });
  };

  const handleUpdateIgnoreRegion = (regionId: string, patch: Partial<IgnoreRegion>) => {
    setSelectedIgnoreRegions((prev) => prev.map((region) => (region.id === regionId ? { ...region, ...patch } : region)));
    if (!canPersistToBackend || regionId.startsWith("local_ignore_")) {
      setLocalOnly("Ignore region saved locally.");
      return;
    }

    updateIgnoreRegionApi(templateId, regionId, patch)
      .then((bundle) => {
        applyBundle(bundle);
        setSaved("Ignore region saved.");
      })
      .catch((error) => {
        console.warn("Ignore region update failed.", error);
        setLocalOnly("Ignore region saved locally.");
      });
  };

  const handleDeleteIgnoreRegion = (regionId: string) => {
    const previousRegions = selectedIgnoreRegions;
    setSelectedIgnoreRegions((prev) => prev.filter((region) => region.id !== regionId));
    if (!canPersistToBackend || regionId.startsWith("local_ignore_")) {
      setLocalOnly("Ignore region deleted locally.");
      return;
    }

    deleteIgnoreRegionApi(templateId, regionId)
      .then((bundle) => {
        applyBundle(bundle);
        setSaved("Ignore region deleted.");
      })
      .catch((error) => {
        console.warn("Ignore region delete failed.", error);
        setSelectedIgnoreRegions(previousRegions);
        setLocalOnly("Ignore region delete could not be persisted.");
      });
  };

  if (loadStatus === "loading") {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500 shadow-sm">
        Loading template editor...
      </section>
    );
  }

  if (!selectedTemplate) {
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
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-black text-slate-800 uppercase tracking-wide">Template Info</h2>
            <p className="mt-1 text-xs font-semibold text-slate-400">
              Define page-aware ROI fields from the submitted template images.
            </p>
          </div>
        </div>

        {loadStatus === "fallback" && (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
            Backend unavailable. Showing local fallback data.
          </p>
        )}
        {saveStatus && <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">{saveStatus}</p>}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <label className="space-y-1">
            <span className="text-[10px] font-black uppercase text-slate-400">Template name</span>
            <input
              value={selectedTemplate.name}
              onChange={(event) => setSelectedTemplate({ ...selectedTemplate, name: event.target.value })}
              onBlur={() => persistTemplatePatch({ name: selectedTemplate.name })}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <span className="rounded-full bg-slate-100 px-3 py-2 text-[11px] font-black text-slate-600">
              Status: {selectedTemplate.status}
            </span>
            <span className="rounded-full bg-sky-50 px-3 py-2 text-[11px] font-black text-sky-700">
              Pages: {selectedTemplatePages.length}
            </span>
            <span className="rounded-full bg-indigo-50 px-3 py-2 text-[11px] font-black text-indigo-700">
              Fields: {extractionFieldCount}
            </span>
            <span className="rounded-full bg-amber-50 px-3 py-2 text-[11px] font-black text-amber-700">
              Anchors: {verificationAnchorCount}
            </span>
          </div>
        </div>
      </div>

      {selectedTemplatePages.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap gap-2">
              {[
                { id: "adjust", label: "2.0 ปรับภาพ", description: "ตรวจภาพและครอปเอกสาร" },
                { id: "roi", label: "2.1 Workspace ROI", description: "ลากกรอบและกำหนดข้อมูล" },
              ].map((item) => {
                const isActive = editorStage === item.id;
                const isDone = item.id === "adjust" && editorStage === "roi";
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setEditorStage(item.id as AdminEditorStage)}
                    className={`min-h-[56px] rounded-xl border px-4 py-2 text-left transition-colors ${
                      isActive
                        ? "border-indigo-300 bg-indigo-50 text-indigo-800"
                        : isDone
                          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                          : "border-slate-200 bg-slate-50 text-slate-600"
                    }`}
                  >
                    <span className="block text-xs font-black">{item.label}</span>
                    <span className="block text-[11px] font-semibold opacity-75">{item.description}</span>
                  </button>
                );
              })}
            </div>

            {editorStage === "roi" && (
              <button
                type="button"
                onClick={() => setEditorStage("adjust")}
                className="h-10 rounded-xl border border-slate-200 bg-white px-4 text-xs font-black text-slate-700 hover:bg-slate-50"
              >
                กลับไปปรับภาพ
              </button>
            )}
          </div>
        </div>
      )}

      {selectedTemplatePages.length > 0 && currentTemplatePage && (
        <div className="space-y-4">
          {editorStage === "adjust" ? (
            <AdjustZone
              imagesList={imageList}
              currentIndex={safeCurrentPage}
              onIndexChange={setCurrentPage}
              pagesConfig={adjustPageConfigs}
              setPagesConfig={setAdjustPageConfigs}
              onBatchConfirm={(finalImages) => {
                void handleConfirmAdjustedImages(finalImages);
              }}
            />
          ) : (
            <WorkspaceTemplateEditor
              templateId={templateId}
              pages={workspacePages}
              currentPage={safeCurrentPage}
              onPageChange={setCurrentPage}
              fields={selectedTemplateFields}
              ignoreRegions={selectedIgnoreRegions}
              onAddField={handleAddField}
              onUpdateField={handleUpdateField}
              onReorderFields={handleReorderFields}
              onReplacePageExtractionFields={handleReplacePageExtractionFields}
              onDeleteField={handleDeleteField}
              onAddIgnoreRegion={handleAddIgnoreRegion}
              onUpdateIgnoreRegion={handleUpdateIgnoreRegion}
              onDeleteIgnoreRegion={handleDeleteIgnoreRegion}
              onGenerateEmbedding={() => generateEmbedding(templateId, currentTemplatePage.id)}
              onRunTestMode={() => {
                markTesting(templateId);
                router.push(`/admin/templates/${templateId}/test`);
              }}
            />
          )}
        </div>
      )}
    </section>
  );
}
