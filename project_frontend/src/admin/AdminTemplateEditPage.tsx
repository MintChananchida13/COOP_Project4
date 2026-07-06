"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import AdjustZone from "../user/components/AdjustZone";
import WorkspaceTemplateEditor from "./workspace/WorkspaceTemplateEditor";
import { samplePage, templateStatuses } from "./adminMockData";
import { useAdminState } from "./AdminState";
import type { TemplateStatus } from "../types/ocr";

type EditorStep = "adjust" | "workspace";

type PageConfig = {
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
};

const createDefaultPageConfig = (): PageConfig => ({
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
  const {
    templates,
    pages,
    fields,
    ignoreRegions,
    updateTemplate,
    addPage,
    removePage,
    addField,
    updateField,
    deleteField,
    addIgnoreRegion,
    updateIgnoreRegion,
    deleteIgnoreRegion,
    generateEmbedding,
    markTesting,
  } = useAdminState();
  const [editorStep, setEditorStep] = useState<EditorStep>("adjust");
  const [currentPage, setCurrentPage] = useState(0);
  const [pagesConfig, setPagesConfig] = useState<PageConfig[]>([]);
  const [adjustedImages, setAdjustedImages] = useState<string[]>([]);

  const selectedTemplate = templates.find((template) => template.id === templateId);
  const selectedTemplatePages = pages.filter((page) => page.templateId === templateId);
  const selectedTemplateFields = fields.filter((field) => field.templateId === templateId);
  const selectedIgnoreRegions = ignoreRegions.filter((region) => region.templateId === templateId);

  const imageList = useMemo(
    () => selectedTemplatePages.map((page) => page.normalizedImageUrl || page.sampleImageUrl || samplePage),
    [selectedTemplatePages]
  );

  const workspacePages = selectedTemplatePages.map((page, index) => ({
    id: page.id,
    src: adjustedImages[index] || imageList[index] || samplePage,
    label: page.pageName || `Page ${page.pageNumber}`,
  }));

  const safeCurrentPage = Math.min(currentPage, Math.max(selectedTemplatePages.length - 1, 0));
  const currentTemplatePage = selectedTemplatePages[safeCurrentPage];

  const handleAddPage = () => {
    addPage(templateId);
    setEditorStep("adjust");
  };

  const handleRemovePage = (pageId: string) => {
    removePage(templateId, pageId);
    setCurrentPage(0);
    setEditorStep("adjust");
  };

  const handleConfirmAdjustedImages = (finalImages: string[]) => {
    setAdjustedImages(finalImages);
    setCurrentPage(0);
    setEditorStep("workspace");
  };

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
              Step 1: Adjust document image → Step 2: Define ROI fields in workspace.
            </p>
          </div>

          <Link href={`/admin/templates/${templateId}/test`} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700">
            Test Mode
          </Link>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-1">
            <span className="text-[10px] font-black uppercase text-slate-400">Template name</span>
            <input value={selectedTemplate.name} onChange={(event) => updateTemplate(templateId, { name: event.target.value })} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold" />
          </label>

          <label className="space-y-1">
            <span className="text-[10px] font-black uppercase text-slate-400">Status</span>
            <select value={selectedTemplate.status} onChange={(event) => updateTemplate(templateId, { status: event.target.value as TemplateStatus })} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold">
              {templateStatuses.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-[10px] font-black uppercase text-slate-400">Document type</span>
            <input value={selectedTemplate.documentType || ""} onChange={(event) => updateTemplate(templateId, { documentType: event.target.value })} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold" />
          </label>

          <label className="space-y-1">
            <span className="text-[10px] font-black uppercase text-slate-400">Category</span>
            <input value={selectedTemplate.category || ""} onChange={(event) => updateTemplate(templateId, { category: event.target.value })} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold" />
          </label>

          <label className="space-y-1">
            <span className="text-[10px] font-black uppercase text-slate-400">Similarity threshold</span>
            <input type="number" step="0.01" min="0" max="1" value={selectedTemplate.similarityThreshold} onChange={(event) => updateTemplate(templateId, { similarityThreshold: Number(event.target.value) })} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold" />
          </label>

          <label className="space-y-1">
            <span className="text-[10px] font-black uppercase text-slate-400">Final confidence threshold</span>
            <input type="number" step="0.01" min="0" max="1" value={selectedTemplate.finalConfidenceThreshold} onChange={(event) => updateTemplate(templateId, { finalConfidenceThreshold: Number(event.target.value) })} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold" />
          </label>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-black text-slate-800 uppercase tracking-wide">Template Pages</h2>
            <p className="mt-1 text-xs font-semibold text-slate-400">
              กดปรับภาพก่อน แล้วค่อยไปกำหนด ROI ใน Workspace
            </p>
          </div>

          <button type="button" onClick={handleAddPage} className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-black text-white">
            Add Page
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {selectedTemplatePages.map((page, index) => (
            <div key={page.id} className={`rounded-xl border px-3 py-2 text-xs font-bold ${safeCurrentPage === index ? "border-indigo-400 bg-indigo-50" : "border-slate-200 bg-slate-50"}`}>
              <button type="button" onClick={() => setCurrentPage(index)}>Page {page.pageNumber}</button>
              {selectedTemplatePages.length > 1 && (
                <button type="button" onClick={() => handleRemovePage(page.id)} className="ml-3 text-red-600">Remove</button>
              )}
            </div>
          ))}
        </div>
      </div>

      {selectedTemplatePages.length > 0 && currentTemplatePage && (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setEditorStep("adjust")}
                className={`rounded-xl px-4 py-3 text-xs font-black ${editorStep === "adjust" ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-600"}`}
              >
                1. Adjust Image
              </button>

              <button
                type="button"
                onClick={() => setEditorStep("workspace")}
                className={`rounded-xl px-4 py-3 text-xs font-black ${editorStep === "workspace" ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-600"}`}
              >
                2. Workspace ROI
              </button>
            </div>
          </div>

          {editorStep === "adjust" ? (
            <AdjustZone
              imagesList={imageList}
              currentIndex={safeCurrentPage}
              onIndexChange={setCurrentPage}
              pagesConfig={pagesConfig}
              setPagesConfig={setPagesConfig}
              onBatchConfirm={handleConfirmAdjustedImages}
            />
          ) : (
            <WorkspaceTemplateEditor
              pages={workspacePages}
              currentPage={safeCurrentPage}
              onPageChange={setCurrentPage}
              fields={selectedTemplateFields}
              ignoreRegions={selectedIgnoreRegions}
              onBackToAdjust={() => setEditorStep("adjust")}
              onAddField={(roi) => addField(templateId, currentTemplatePage.id, roi)}
              onUpdateField={updateField}
              onDeleteField={deleteField}
              onAddIgnoreRegion={(roi) => addIgnoreRegion(templateId, currentTemplatePage.id, roi)}
              onUpdateIgnoreRegion={updateIgnoreRegion}
              onDeleteIgnoreRegion={deleteIgnoreRegion}
              onGenerateEmbedding={() => generateEmbedding(templateId, currentTemplatePage.id)}
              onRunTestMode={() => markTesting(templateId)}
            />
          )}
        </div>
      )}
    </section>
  );
}
