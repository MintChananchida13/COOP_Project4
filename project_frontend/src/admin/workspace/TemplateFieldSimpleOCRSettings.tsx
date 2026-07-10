"use client";

import { useEffect } from "react";
import { TemplateField } from "../../types/ocr";
import { extractionMethodOptions, normalizeExtractionMethod } from "../../shared/workspace/extractionMethods";

interface TemplateFieldSimpleOCRSettingsProps {
  field: TemplateField;
  onUpdate: (fieldId: string, patch: Partial<TemplateField>) => void;
}

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 outline-none focus:border-indigo-500 disabled:bg-slate-100 disabled:text-slate-400";

export default function TemplateFieldSimpleOCRSettings({ field, onUpdate }: TemplateFieldSimpleOCRSettingsProps) {
  const selectedExtractionMethod = normalizeExtractionMethod(field.extractionMethod);
  const useAsTemplateAnchor = Boolean(field.useForVerification);

  useEffect(() => {
    const patch: Partial<TemplateField> = {};

    if (field.extractionMethod !== selectedExtractionMethod) {
      patch.extractionMethod = selectedExtractionMethod;
    }
    if (field.roiPadding === undefined || field.roiPadding === null) {
      patch.roiPadding = 0;
    }
    if (field.expectedText === undefined) {
      patch.expectedText = "";
    }
    if (!field.userSelectable) {
      patch.userSelectable = true;
    }
    if (!field.defaultSelected) {
      patch.defaultSelected = true;
    }

    if (Object.keys(patch).length > 0) {
      onUpdate(field.id, patch);
    }
  }, [
    field.defaultSelected,
    field.expectedText,
    field.extractionMethod,
    field.id,
    field.roiPadding,
    field.userSelectable,
    onUpdate,
    selectedExtractionMethod,
  ]);

  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
      <section className="space-y-3">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Extraction</h3>
        <label className="space-y-1">
          <span className="block text-[10px] font-black uppercase text-slate-400">Method</span>
          <select
            className={inputClass}
            value={selectedExtractionMethod}
            onChange={(event) => onUpdate(field.id, { extractionMethod: normalizeExtractionMethod(event.target.value) })}
          >
            {extractionMethodOptions.map((method) => (
              <option key={method.value} value={method.value}>
                {method.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="block text-[10px] font-black uppercase text-slate-400">ROI Padding</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              step="1"
              className={inputClass}
              value={field.roiPadding ?? 0}
              onChange={(event) => onUpdate(field.id, { roiPadding: Number(event.target.value) })}
            />
            <span className="text-xs font-bold text-slate-400">px</span>
          </div>
        </label>
      </section>

      <section className="space-y-3 border-t border-slate-200 pt-4">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Verification</h3>
        <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-bold text-slate-700">
          <input
            type="checkbox"
            checked={useAsTemplateAnchor}
            onChange={(event) =>
              onUpdate(field.id, {
                useForVerification: event.target.checked,
                requiredForVerification: event.target.checked,
                matchType: event.target.checked ? field.matchType || "contains" : field.matchType,
              })
            }
          />
          Use as Template Anchor
        </label>

        <label className="space-y-1">
          <span className="block text-[10px] font-black uppercase text-slate-400">Expected Text</span>
          <input
            className={inputClass}
            disabled={!useAsTemplateAnchor}
            placeholder="e.g. Tax Invoice"
            value={field.expectedText || ""}
            onChange={(event) => onUpdate(field.id, { expectedText: event.target.value })}
          />
        </label>
      </section>
    </section>
  );
}
