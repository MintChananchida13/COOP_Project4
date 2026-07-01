"use client";

import Link from "next/link";
import { useAdminState } from "./AdminState";

export default function AdminTemplateTestPage({ templateId }: { templateId: string }) {
  const { templates, markTesting } = useAdminState();
  const template = templates.find((item) => item.id === templateId);

  if (!template) {
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
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-black text-slate-900">Template Test Mode</h2>
          <p className="text-xs font-semibold text-slate-500">{template.name}</p>
        </div>
        <Link href={`/admin/templates/${templateId}/edit`} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700">
          Back to Editor
        </Link>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {["Layout Preview", "Layout Overlay Preview", "OCR Verification Preview"].map((label) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</div>
            <p className="mt-2 text-xs font-semibold text-slate-500">Placeholder for Phase test workflow.</p>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => markTesting(templateId)} className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white">
        Run Template Test Mode
      </button>
    </section>
  );
}
