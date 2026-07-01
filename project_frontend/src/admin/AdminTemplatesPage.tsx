"use client";

import Link from "next/link";
import { useState } from "react";
import { TemplateStatus } from "../types/ocr";
import { templateStatuses } from "./adminMockData";
import { AdminStatusFilter } from "./adminTypes";
import { useAdminState } from "./AdminState";

export default function AdminTemplatesPage() {
  const { templates } = useAdminState();
  const [selectedStatus, setSelectedStatus] = useState<AdminStatusFilter>("all");
  const filteredTemplates = selectedStatus === "all" ? templates : templates.filter((template) => template.status === selectedStatus);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <h2 className="text-sm font-black text-slate-800 uppercase tracking-wide">Templates</h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setSelectedStatus("all")} className={`rounded-lg px-3 py-1.5 text-[10px] font-black ${selectedStatus === "all" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600"}`}>
            all
          </button>
          {templateStatuses.map((status: TemplateStatus) => (
            <button key={status} type="button" onClick={() => setSelectedStatus(status)} className={`rounded-lg px-3 py-1.5 text-[10px] font-black ${selectedStatus === status ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600"}`}>
              {status}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {filteredTemplates.map((template) => (
          <div key={template.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
            <div>
              <div className="text-sm font-black text-slate-800">{template.name}</div>
              <div className="mt-1 text-[10px] font-bold uppercase text-slate-400">{template.status}</div>
            </div>
            <div className="text-xs font-semibold text-slate-500">
              {template.documentType || "No type"} | {template.pageCount} page{template.pageCount === 1 ? "" : "s"}
            </div>
            <div className="flex gap-2">
              <Link href={`/admin/templates/${template.id}/edit`} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-black text-white">
                Edit
              </Link>
              <Link href={`/admin/templates/${template.id}/test`} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700">
                Test
              </Link>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
