"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import WorkspaceTemplateEditor from "./workspace/WorkspaceTemplateEditorV2";
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
import type { IgnoreRegion, RoiRatio, Template, TemplateField, TemplatePage, TemplateStatus } from "../types/ocr";

type LoadStatus = "loading" | "loaded" | "fallback" | "error";

const editableTemplateStatuses: TemplateStatus[] = ["draft","validated","active", "nonactive"];

const defaultRoi = (pageNumber: number): RoiRatio => ({
  pageNumber,
  xRatio: 0.1,
  yRatio: 0.2,
  widthRatio: 0.32,
  heightRatio: 0.06,
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

  const safeCurrentPage = Math.min(currentPage, Math.max(selectedTemplatePages.length - 1, 0));
  const currentTemplatePage = selectedTemplatePages[safeCurrentPage];

  const setSaved = (message: string) => setSaveStatus(message);
  const setLocalOnly = (message: string) => setSaveStatus(`${message} Backend unavailable; kept local edit.`);
  const canPersistToBackend = loadStatus === "loaded";

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
      extractionMethod: defaults?.extractionMethod || "ocr_text",
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

          <Link href={`/admin/templates/${templateId}/test`} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700">
            Test Mode
          </Link>
        </div>

        {loadStatus === "fallback" && (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
            Backend unavailable. Showing local fallback data.
          </p>
        )}
        {saveStatus && <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">{saveStatus}</p>}

        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-1">
            <span className="text-[10px] font-black uppercase text-slate-400">Template name</span>
            <input
              value={selectedTemplate.name}
              onChange={(event) => setSelectedTemplate({ ...selectedTemplate, name: event.target.value })}
              onBlur={() => persistTemplatePatch({ name: selectedTemplate.name })}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold"
            />
          </label>

          <label className="space-y-1">
            <span className="text-[10px] font-black uppercase text-slate-400">Status</span>
            <select
              value={selectedTemplate.status}
              onChange={(event) => persistTemplatePatch({ status: event.target.value as TemplateStatus })}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold"
            >
              {editableTemplateStatuses.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-[10px] font-black uppercase text-slate-400">Document type</span>
            <input
              value={selectedTemplate.documentType || ""}
              onChange={(event) => setSelectedTemplate({ ...selectedTemplate, documentType: event.target.value })}
              onBlur={() => persistTemplatePatch({ documentType: selectedTemplate.documentType })}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold"
            />
          </label>

          <label className="space-y-1">
            <span className="text-[10px] font-black uppercase text-slate-400">Category</span>
            <input
              value={selectedTemplate.category || ""}
              onChange={(event) => setSelectedTemplate({ ...selectedTemplate, category: event.target.value })}
              onBlur={() => persistTemplatePatch({ category: selectedTemplate.category })}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold"
            />
          </label>

          <label className="space-y-1">
            <span className="text-[10px] font-black uppercase text-slate-400">Similarity threshold</span>
            <input
              type="number"
              step="0.01"
              min="0"
              max="1"
              value={selectedTemplate.similarityThreshold}
              onChange={(event) => setSelectedTemplate({ ...selectedTemplate, similarityThreshold: Number(event.target.value) })}
              onBlur={() => persistTemplatePatch({ similarityThreshold: selectedTemplate.similarityThreshold })}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold"
            />
          </label>

          <label className="space-y-1">
            <span className="text-[10px] font-black uppercase text-slate-400">Final confidence threshold</span>
            <input
              type="number"
              step="0.01"
              min="0"
              max="1"
              value={selectedTemplate.finalConfidenceThreshold}
              onChange={(event) => setSelectedTemplate({ ...selectedTemplate, finalConfidenceThreshold: Number(event.target.value) })}
              onBlur={() => persistTemplatePatch({ finalConfidenceThreshold: selectedTemplate.finalConfidenceThreshold })}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold"
            />
          </label>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-black text-slate-800 uppercase tracking-wide">Template Pages</h2>
            <p className="mt-1 text-xs font-semibold text-slate-400">
              Review submitted pages and define ROI in Workspace.
            </p>
          </div>

        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {selectedTemplatePages.map((page, index) => (
            <div key={page.id} className={`rounded-xl border px-3 py-2 text-xs font-bold ${safeCurrentPage === index ? "border-indigo-400 bg-indigo-50" : "border-slate-200 bg-slate-50"}`}>
              <button type="button" onClick={() => setCurrentPage(index)}>Page {page.pageNumber}</button>
              <input
                value={page.pageName || ""}
                onChange={(event) => setSelectedTemplatePages((prev) => prev.map((item) => item.id === page.id ? { ...item, pageName: event.target.value } : item))}
                onBlur={(event) => handleUpdatePage(page.id, { pageName: event.target.value })}
                className="ml-2 w-28 rounded border border-slate-200 bg-white px-2 py-1 text-[10px]"
                placeholder="Page name"
              />
              {selectedTemplatePages.length > 1 && (
                <button type="button" onClick={() => handleRemovePage(page.id)} className="ml-3 text-red-600">Remove</button>
              )}
            </div>
          ))}
        </div>
      </div>

      {selectedTemplatePages.length > 0 && currentTemplatePage && (
        <div className="space-y-4">
          <WorkspaceTemplateEditor
            templateId={templateId}
            pages={workspacePages}
            currentPage={safeCurrentPage}
            onPageChange={setCurrentPage}
            fields={selectedTemplateFields}
            ignoreRegions={selectedIgnoreRegions}
            onAddField={handleAddField}
            onUpdateField={handleUpdateField}
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
        </div>
      )}
    </section>
  );
}
