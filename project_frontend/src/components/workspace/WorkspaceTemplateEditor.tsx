"use client";

import BaseWorkspace, { WorkspacePage } from "./BaseWorkspace";
import RoiLayer from "./RoiLayer";
import { WorkspaceRoi } from "./RoiBox";
import WorkspaceCanvas from "./WorkspaceCanvas";
import { IgnoreRegion, TemplateField } from "../../types/ocr";

interface WorkspaceTemplateEditorProps {
  pages: WorkspacePage[];
  currentPage: number;
  onPageChange: (pageIndex: number) => void;
  fields: TemplateField[];
  ignoreRegions: IgnoreRegion[];
  onAddField: () => void;
  onUpdateField: (fieldId: string, patch: Partial<TemplateField>) => void;
  onDeleteField: (fieldId: string) => void;
  onAddIgnoreRegion: () => void;
  onUpdateIgnoreRegion: (regionId: string, patch: Partial<IgnoreRegion>) => void;
  onDeleteIgnoreRegion: (regionId: string) => void;
  onGenerateEmbedding: () => void;
  onRunTestMode: () => void;
}

const CANVAS_WIDTH = 750;
const CANVAS_HEIGHT = 1000;

const ratioToDisplayRoi = (
  item: TemplateField | IgnoreRegion,
  kind: "field" | "ignore_region"
): WorkspaceRoi => ({
  id: Number(item.id.replace(/\D/g, "").slice(-8)) || Math.floor(Math.random() * 100000),
  fieldName: kind === "ignore_region" ? `Ignore: ${item.fieldName}` : item.fieldName,
  x: item.roi.xRatio * CANVAS_WIDTH,
  y: item.roi.yRatio * CANVAS_HEIGHT,
  width: item.roi.widthRatio * CANVAS_WIDTH,
  height: item.roi.heightRatio * CANVAS_HEIGHT,
  pageIndex: item.pageNumber - 1,
  type: "text",
  enabled: true,
});

const ratioInputClass =
  "w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 outline-none focus:border-indigo-500";

export default function WorkspaceTemplateEditor({
  pages,
  currentPage,
  onPageChange,
  fields,
  ignoreRegions,
  onAddField,
  onUpdateField,
  onDeleteField,
  onAddIgnoreRegion,
  onUpdateIgnoreRegion,
  onDeleteIgnoreRegion,
  onGenerateEmbedding,
  onRunTestMode,
}: WorkspaceTemplateEditorProps) {
  const currentPageNumber = currentPage + 1;
  const pageFields = fields.filter((field) => field.pageNumber === currentPageNumber);
  const pageIgnoreRegions = ignoreRegions.filter((region) => region.pageNumber === currentPageNumber);
  const displayRois = [
    ...pageFields.map((field) => ratioToDisplayRoi(field, "field")),
    ...pageIgnoreRegions.map((region) => ratioToDisplayRoi(region, "ignore_region")),
  ];

  const selectedPage = pages[currentPage];
  const qdrantPointId = selectedPage?.id ? `qdrant_${selectedPage.id}` : "not_generated";

  return (
    <BaseWorkspace pages={pages} currentPage={currentPage} onPageChange={onPageChange} title="Template Editor">
      <div className="grid gap-5 xl:grid-cols-[1fr_360px] min-h-[620px]">
        <WorkspaceCanvas imageSrc={selectedPage?.src || ""} className="h-[620px]">
          <RoiLayer rois={displayRois} currentPage={currentPage} readonly showLabels />
        </WorkspaceCanvas>

        <aside className="bg-white border border-slate-200 p-4 rounded-xl shadow-sm h-[620px] overflow-y-auto space-y-4">
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-black text-slate-700 uppercase tracking-wider">Template Fields</h3>
              <button type="button" onClick={onAddField} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[10px] font-black text-white">
                Add Field
              </button>
            </div>
            {pageFields.length === 0 && <p className="text-xs font-semibold text-slate-400">No fields on this page.</p>}
            {pageFields.map((field) => (
              <div key={field.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <input className={ratioInputClass} value={field.fieldName} onChange={(event) => onUpdateField(field.id, { fieldName: event.target.value })} />
                  <input className={ratioInputClass} value={field.displayLabel} onChange={(event) => onUpdateField(field.id, { displayLabel: event.target.value })} />
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {(["xRatio", "yRatio", "widthRatio", "heightRatio"] as const).map((key) => (
                    <label key={key} className="space-y-1">
                      <span className="text-[9px] font-black uppercase text-slate-400">{key.replace("Ratio", "")}</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        max="1"
                        className={ratioInputClass}
                        value={field.roi[key]}
                        onChange={(event) =>
                          onUpdateField(field.id, {
                            roi: { ...field.roi, [key]: Number(event.target.value) },
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <div className="grid grid-cols-1 gap-1.5 text-[11px] font-bold text-slate-600">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={field.userSelectable} onChange={(event) => onUpdateField(field.id, { userSelectable: event.target.checked })} />
                    User selectable
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={field.defaultSelected} onChange={(event) => onUpdateField(field.id, { defaultSelected: event.target.checked })} />
                    Default selected
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={field.useForVerification} onChange={(event) => onUpdateField(field.id, { useForVerification: event.target.checked })} />
                    Use for verification
                  </label>
                  <input
                    className={ratioInputClass}
                    placeholder="Expected text"
                    value={field.expectedText || ""}
                    onChange={(event) => onUpdateField(field.id, { expectedText: event.target.value })}
                  />
                  <input
                    className={ratioInputClass}
                    placeholder="Match type"
                    value={field.matchType || ""}
                    onChange={(event) => onUpdateField(field.id, { matchType: event.target.value })}
                  />
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={field.requiredForVerification}
                      onChange={(event) => onUpdateField(field.id, { requiredForVerification: event.target.checked })}
                    />
                    Required for verification
                  </label>
                </div>
                <button type="button" onClick={() => onDeleteField(field.id)} className="text-[10px] font-black text-red-600">
                  Delete field
                </button>
              </div>
            ))}
          </section>

          <section className="space-y-3 border-t border-slate-200 pt-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-black text-slate-700 uppercase tracking-wider">Ignore Regions</h3>
              <button type="button" onClick={onAddIgnoreRegion} className="rounded-lg bg-slate-800 px-3 py-1.5 text-[10px] font-black text-white">
                Add Region
              </button>
            </div>
            {pageIgnoreRegions.map((region) => (
              <div key={region.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
                <input className={ratioInputClass} value={region.fieldName} onChange={(event) => onUpdateIgnoreRegion(region.id, { fieldName: event.target.value })} />
                <div className="grid grid-cols-4 gap-2">
                  {(["xRatio", "yRatio", "widthRatio", "heightRatio"] as const).map((key) => (
                    <input
                      key={key}
                      type="number"
                      step="0.01"
                      min="0"
                      max="1"
                      className={ratioInputClass}
                      value={region.roi[key]}
                      onChange={(event) =>
                        onUpdateIgnoreRegion(region.id, {
                          roi: { ...region.roi, [key]: Number(event.target.value) },
                        })
                      }
                    />
                  ))}
                </div>
                <button type="button" onClick={() => onDeleteIgnoreRegion(region.id)} className="text-[10px] font-black text-red-600">
                  Delete region
                </button>
              </div>
            ))}
          </section>

          <section className="space-y-3 border-t border-slate-200 pt-4">
            <h3 className="text-xs font-black text-slate-700 uppercase tracking-wider">Embedding</h3>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs font-semibold text-slate-600 space-y-1">
              <div>qdrant_point_id: {qdrantPointId}</div>
              <div>Status: placeholder</div>
            </div>
            <button type="button" onClick={onGenerateEmbedding} className="w-full rounded-xl bg-emerald-600 px-3 py-2 text-xs font-black text-white">
              Generate Layout Embedding
            </button>
          </section>

          <section className="space-y-3 border-t border-slate-200 pt-4">
            <h3 className="text-xs font-black text-slate-700 uppercase tracking-wider">Test Mode</h3>
            <button type="button" onClick={onRunTestMode} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700">
              Run Template Test Mode
            </button>
          </section>
        </aside>
      </div>
    </BaseWorkspace>
  );
}
