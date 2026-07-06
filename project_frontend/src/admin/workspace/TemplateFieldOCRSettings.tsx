"use client";

import { useEffect, useState } from "react";
import { TemplateField } from "../../types/ocr";
import { extractionMethodOptions, normalizeExtractionMethod } from "../../shared/workspace/extractionMethods";

interface TemplateFieldOCRSettingsProps {
  field: TemplateField;
  onUpdate: (fieldId: string, patch: Partial<TemplateField>) => void;
}

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 outline-none focus:border-indigo-500";

const matchTypes = ["", "exact", "contains", "regex", "fuzzy"];

export default function TemplateFieldOCRSettings({ field, onUpdate }: TemplateFieldOCRSettingsProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const selectedExtractionMethod = normalizeExtractionMethod(field.extractionMethod);

  useEffect(() => {
    if (field.extractionMethod !== selectedExtractionMethod) {
      onUpdate(field.id, { extractionMethod: selectedExtractionMethod });
    }
  }, [field.id, field.extractionMethod, onUpdate, selectedExtractionMethod]);

  const updateExtractionMethod = (value: string) => {
    onUpdate(field.id, { extractionMethod: normalizeExtractionMethod(value) });
  };

  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-3">
      <section className="space-y-2">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">การดึงข้อมูล</h3>
        <div className="grid gap-2 text-[11px] font-bold text-slate-600">
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
            <input
              type="checkbox"
              checked={field.userSelectable}
              onChange={(event) => onUpdate(field.id, { userSelectable: event.target.checked })}
            />
            ให้ผู้ใช้เลือกได้
          </label>
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
            <input
              type="checkbox"
              checked={field.defaultSelected}
              onChange={(event) => onUpdate(field.id, { defaultSelected: event.target.checked })}
            />
            เลือกไว้เป็นค่าเริ่มต้น
          </label>
          <label className="space-y-1">
            <span className="block text-[10px] font-black uppercase text-slate-400">วิธีดึงข้อมูล</span>
            <select className={inputClass} value={selectedExtractionMethod} onChange={(event) => updateExtractionMethod(event.target.value)}>
              {extractionMethodOptions.map((method) => (
                <option key={method.value} value={method.value}>
                  {method.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-[10px] font-black uppercase text-slate-400">ระยะขยายกรอบ ROI</span>
            <input
              type="number"
              min="0"
              step="1"
              className={inputClass}
              value={field.roiPadding || 0}
              onChange={(event) => onUpdate(field.id, { roiPadding: Number(event.target.value) })}
            />
          </label>
        </div>
      </section>

      <section className="space-y-2 border-t border-slate-200 pt-3">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">การตรวจสอบ Template</h3>
        <div className="grid gap-2 text-[11px] font-bold text-slate-600">
          <label className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
            <input
              type="checkbox"
              checked={field.useForVerification}
              onChange={(event) => onUpdate(field.id, { useForVerification: event.target.checked })}
            />
            <span>
              <span className="block">ใช้ Field นี้ตรวจสอบ Template</span>
              <span className="mt-1 block text-[10px] font-semibold leading-4 text-slate-400">
                OCR will read this field to check if the document matches this template.
              </span>
            </span>
          </label>
          <label className="space-y-1">
            <span className="block text-[10px] font-black uppercase text-slate-400">ข้อความที่คาดว่าจะพบ</span>
            <input
              className={inputClass}
              placeholder="e.g. Tax Invoice"
              value={field.expectedText || ""}
              onChange={(event) => onUpdate(field.id, { expectedText: event.target.value })}
            />
            <span className="block text-[10px] font-semibold text-slate-400">
              Text that should appear in this field, e.g. Tax Invoice.
            </span>
          </label>
        </div>
      </section>

      <section className="space-y-2 border-t border-slate-200 pt-3">
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          className="flex w-full items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-left text-xs font-black text-slate-700 hover:bg-slate-100"
        >
          ตั้งค่าขั้นสูง
          <span className="text-[10px] text-slate-400">{advancedOpen ? "Hide" : "Show"}</span>
        </button>
        {advancedOpen && (
          <div className="grid gap-2 text-[11px] font-bold text-slate-600">
            <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2">
              <input
                type="checkbox"
                checked={field.requiredForVerification}
                onChange={(event) => onUpdate(field.id, { requiredForVerification: event.target.checked })}
              />
              This field is required
            </label>
            <label className="space-y-1">
              <span className="block text-[10px] font-black uppercase text-slate-400">Match Type</span>
              <input
                className={inputClass}
                list="admin-match-types"
                placeholder="exact, contains, regex, fuzzy"
                value={field.matchType || ""}
                onChange={(event) => onUpdate(field.id, { matchType: event.target.value })}
              />
            </label>
            <datalist id="admin-match-types">
              {matchTypes.map((type) => (
                <option key={type || "empty"} value={type} />
              ))}
            </datalist>
          </div>
        )}
      </section>
    </section>
  );
}
