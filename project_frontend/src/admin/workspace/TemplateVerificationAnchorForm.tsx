"use client";

import { TemplateField } from "../../types/ocr";

interface TemplateVerificationAnchorFormProps {
  anchor: TemplateField;
  onUpdate: (fieldId: string, patch: Partial<TemplateField>) => void;
  onDelete: (fieldId: string) => void;
}

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 outline-none focus:border-amber-500";

export default function TemplateVerificationAnchorForm({ anchor, onUpdate, onDelete }: TemplateVerificationAnchorFormProps) {
  const method = anchor.dataType === "image" ? "image_feature" : "ocr_text";
  const updateMethod = (value: string) => {
    if (value === "image_feature") {
      onUpdate(anchor.id, { dataType: "image", extractionMethod: "extract_image", expectedText: "" });
    } else {
      onUpdate(anchor.id, { dataType: "text", extractionMethod: "ocr_text" });
    }
  };

  return (
    <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
      <h3 className="text-xs font-black uppercase tracking-wider text-amber-900">Verification Anchor</h3>

      <label className="space-y-1 block">
        <span className="text-[9px] font-black uppercase text-slate-400">Name</span>
        <input
          className={inputClass}
          value={anchor.displayLabel || anchor.fieldName}
          onChange={(event) => onUpdate(anchor.id, { fieldName: event.target.value, displayLabel: event.target.value })}
        />
      </label>

      <label className="space-y-1 block">
        <span className="text-[9px] font-black uppercase text-slate-400">Verification Method</span>
        <select
          className={inputClass}
          value={method}
          onChange={(event) => updateMethod(event.target.value)}
        >
          <option value="ocr_text">OCR Text</option>
          <option value="image_feature">Image Feature</option>
          <option disabled>Logo Match (reserved for future)</option>
          <option disabled>Barcode (reserved for future)</option>
          <option disabled>QR Code (reserved for future)</option>
        </select>
      </label>

      <label className="space-y-1 block">
        <span className="text-[9px] font-black uppercase text-slate-400">ROI Padding</span>
        <input
          type="number"
          min="0"
          step="1"
          className={inputClass}
          value={anchor.roiPadding ?? 6}
          onChange={(event) => onUpdate(anchor.id, { roiPadding: Number(event.target.value) })}
        />
      </label>

      {method === "ocr_text" && (
        <label className="space-y-1 block">
          <span className="text-[9px] font-black uppercase text-slate-400">Expected Text</span>
          <input
            className={inputClass}
            placeholder="Thai National ID Card"
            value={anchor.expectedText || ""}
            onChange={(event) => onUpdate(anchor.id, { expectedText: event.target.value })}
          />
        </label>
      )}

      <button
        type="button"
        onClick={() => onDelete(anchor.id)}
        className="w-full rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-black text-red-700"
      >
        Delete Anchor
      </button>
    </section>
  );
}
