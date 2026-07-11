"use client";

import { ArrowLeft, CheckCircle2, Cpu, FileText, Image as ImageIcon, Table } from "lucide-react";
import { ROI } from "../../types/ocr";
import WorkspaceCustomEditor, { WorkspaceCustomEditorProps } from "../../shared/workspace/WorkspaceCustomEditor";

interface MatchedTemplateInfo {
  id: string;
  name: string;
  confidence?: number | null;
  decisionReason?: string | null;
}

interface MatchedTemplateWorkspaceZoneProps extends WorkspaceCustomEditorProps {
  matchedTemplate: MatchedTemplateInfo;
}

const typeLabel = (roi: ROI) => {
  if (roi.type === "table" || roi.extractionMethod === "ocr_table") return "Table";
  if (roi.type === "image" || roi.extractionMethod === "extract_image") return "Image";
  return "Text";
};

const typeIcon = (roi: ROI) => {
  if (roi.type === "table" || roi.extractionMethod === "ocr_table") return <Table size={13} />;
  if (roi.type === "image" || roi.extractionMethod === "extract_image") return <ImageIcon size={13} />;
  return <FileText size={13} />;
};

export default function MatchedTemplateWorkspaceZone({
  matchedTemplate,
  ...props
}: MatchedTemplateWorkspaceZoneProps) {
  return (
    <WorkspaceCustomEditor
      {...props}
      readOnly
      hideOcrActions
      centerCanvas
      getRoiBadges={(roi) => {
        if (roi.extractionMethod === "extract_image") return ["IMAGE"];
        if (roi.extractionMethod === "ocr_table") return ["TABLE"];
        return ["OCR"];
      }}
      getRoiClassName={(roi, selected) => {
        const disabled = roi.enabled === false;
        return `rnd-box-item border transition-shadow ${
          disabled
            ? "border-slate-300 bg-slate-200/20 opacity-40"
            : selected
              ? "border-emerald-600 bg-emerald-500/10 shadow-md z-30 ring-2 ring-emerald-500/20"
              : "border-emerald-400/90 bg-emerald-50/10 hover:border-emerald-500 z-20"
        }`;
      }}
      getRoiLabelClassName={(roi, selected) =>
        `absolute -top-5 left-0 px-1.5 py-0.5 text-[9px] font-sans rounded shadow border flex items-center gap-1.5 pointer-events-auto cursor-pointer ${
          roi.enabled === false
            ? "bg-slate-100 border-slate-200 text-slate-400"
            : selected
              ? "bg-emerald-600 border-emerald-600 text-white font-extrabold"
              : "bg-white border-emerald-200 text-emerald-700 font-bold"
        }`
      }
      rightPanelRenderer={({ currentPageRois, selectedId, setSelectedId, updateROI, triggerOCRProcessing }) => {
        const enabledCount = currentPageRois.filter((roi) => roi.enabled !== false).length;
        const selectedRoi = currentPageRois.find((roi) => roi.id === selectedId);

        return (
          <>
            <button
              type="button"
              onClick={props.onBackToAdjust}
              className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-sm"
            >
              <ArrowLeft size={14} /> กลับไปตรวจขอบเขตเอกสาร
            </button>

            <section className="rounded-xl border border-emerald-100 bg-emerald-50 p-3">
              <div className="flex items-start gap-2">
                <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" />
                <div>
                  <h3 className="text-xs font-black uppercase tracking-wider text-emerald-800">
                    Template Matched
                  </h3>
                  <p className="mt-1 text-sm font-black text-emerald-950">{matchedTemplate.name}</p>
                  <p className="mt-1 text-[10px] font-semibold text-emerald-700">
                    {matchedTemplate.confidence !== undefined && matchedTemplate.confidence !== null
                      ? `Confidence ${(matchedTemplate.confidence * 100).toFixed(1)}%`
                      : "Confidence N/A"}
                    {matchedTemplate.decisionReason ? ` · ${matchedTemplate.decisionReason}` : ""}
                  </p>
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">
                    เลือก Field สำหรับ OCR
                  </h3>
                  <p className="mt-1 text-[10px] font-semibold text-slate-500">
                    เลือกข้อมูลที่ต้องการอ่านจาก Template นี้
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black text-slate-600">
                  {enabledCount}/{currentPageRois.length}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => currentPageRois.forEach((roi) => updateROI(roi.id, { enabled: true }))}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[10px] font-black text-slate-600 hover:bg-white"
                >
                  Select All
                </button>
                <button
                  type="button"
                  onClick={() => currentPageRois.forEach((roi) => updateROI(roi.id, { enabled: false }))}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[10px] font-black text-slate-600 hover:bg-white"
                >
                  Clear
                </button>
              </div>

              <div className="mt-3 max-h-[360px] space-y-2 overflow-y-auto pr-1">
                {currentPageRois.length === 0 ? (
                  <p className="rounded-xl bg-slate-50 p-3 text-xs font-semibold text-slate-500">
                    ไม่พบ Field สำหรับหน้านี้
                  </p>
                ) : (
                  currentPageRois.map((roi) => {
                    const checked = roi.enabled !== false;
                    const selected = selectedId === roi.id;
                    return (
                      <label
                        key={`${roi.pageIndex ?? 0}-${roi.id}`}
                        className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-xs transition-all ${
                          selected
                            ? "border-emerald-300 bg-emerald-50 text-emerald-950"
                            : checked
                              ? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                              : "border-slate-200 bg-slate-50 text-slate-400"
                        }`}
                        onClick={() => setSelectedId(roi.id)}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => updateROI(roi.id, { enabled: event.target.checked })}
                          className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                        />
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                          {typeIcon(roi)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-black">{roi.fieldName || "(Unnamed)"}</span>
                          <span className="mt-0.5 block text-[10px] font-bold uppercase text-slate-400">
                            {typeLabel(roi)}
                          </span>
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
            </section>

            {selectedRoi && (
              <section className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
                <h3 className="font-black uppercase tracking-wider text-slate-700">Selected Field</h3>
                <p className="mt-2 font-black text-slate-900">{selectedRoi.fieldName}</p>
                <p className="mt-1 text-[10px] font-bold text-slate-500">
                  {typeLabel(selectedRoi)} · Page {(selectedRoi.pageIndex ?? 0) + 1}
                </p>
              </section>
            )}

            <button
              type="button"
              disabled={props.isLoading || enabledCount === 0}
              onClick={triggerOCRProcessing}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-xs font-black uppercase tracking-wider text-white shadow-sm hover:bg-emerald-700 disabled:bg-slate-300 disabled:text-slate-500"
            >
              <Cpu size={14} className={props.isLoading ? "animate-spin" : ""} />
              {props.isLoading ? "กำลัง OCR..." : "OCR Selected Fields"}
            </button>
          </>
        );
      }}
    />
  );
}
