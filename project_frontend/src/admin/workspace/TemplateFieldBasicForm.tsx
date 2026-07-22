"use client";

import { FileText, Image as ImageIcon, Table } from "lucide-react";
import { RoiDataType, TemplateField } from "../../types/ocr";
import { defaultExtractionMethodForDataType } from "../../shared/workspace/extractionMethods";

interface TemplateFieldBasicFormProps {
  field: TemplateField;
  onUpdate: (fieldId: string, patch: Partial<TemplateField>) => void;
  onDelete: (fieldId: string) => void;
}

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 outline-none focus:border-indigo-500";

const roiTypes = [
  { label: "Text", value: "text" as const, icon: FileText },
  { label: "Table", value: "table" as const, icon: Table },
  { label: "Image", value: "image" as const, icon: ImageIcon },
];

export default function TemplateFieldBasicForm({ field, onUpdate, onDelete }: TemplateFieldBasicFormProps) {
  const selectedDataType = field.dataType === "string" || !field.dataType ? "text" : field.dataType;
  const selectedRoiType = selectedDataType === "table" || selectedDataType === "image" ? selectedDataType : "text";

  const updateDataType = (dataType: RoiDataType) => {
    onUpdate(field.id, {
      dataType,
      extractionMethod: defaultExtractionMethodForDataType(dataType),
    });
  };

  const handleSave = () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };

  return (
    <section className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50/40 p-3">
      <h3 className="text-xs font-black uppercase tracking-wider text-indigo-800">Template Field</h3>

      <label className="space-y-1 block">
        <span className="text-[9px] font-black uppercase text-slate-400">Field Name</span>
        <input
          className={inputClass}
          value={field.fieldName}
          onChange={(event) => onUpdate(field.id, { fieldName: event.target.value, displayLabel: event.target.value })}
        />
      </label>

      <div className="space-y-1">
        <span className="text-[9px] font-black uppercase text-slate-400">ROI Type</span>
        <div className="grid grid-cols-3 gap-1">
          {roiTypes.map(({ label, value, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => updateDataType(value)}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] font-black transition-all ${
                selectedRoiType === value
                  ? "bg-indigo-600 text-white shadow-sm shadow-indigo-500/20"
                  : "bg-white text-slate-500 ring-1 ring-slate-200 hover:bg-slate-50 hover:text-slate-700"
              }`}
            >
              <Icon size={11} />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={handleSave} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-black text-white">
          Save Field
        </button>
        <button type="button" onClick={() => onDelete(field.id)} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-black text-red-700">
          Delete Field
        </button>
      </div>
    </section>
  );
}
