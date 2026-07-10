"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Template } from "../types/ocr";
import { deleteTemplateApi, fetchTemplates } from "./adminApi";
import { AdminStatusFilter } from "./adminTypes";
import { useAdminState } from "./AdminState";

const statusFilterOptions: { value: AdminStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "active", label: "Active" },
  { value: "nonactive", label: "Nonactive" },
];

export default function AdminTemplatesPage() {
  const { templates: fallbackTemplates } = useAdminState();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedStatus, setSelectedStatus] = useState<AdminStatusFilter>("all");
  const [loadStatus, setLoadStatus] = useState<"loading" | "loaded" | "fallback">("loading");
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);
  const [deleteMessage, setDeleteMessage] = useState("");
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    let cancelled = false;

    const loadTemplates = async () => {
      setLoadStatus("loading");
      try {
        const persistedTemplates = await fetchTemplates();
        if (cancelled) return;
        setTemplates(persistedTemplates);
        setLoadStatus("loaded");
      } catch (error) {
        console.warn("Using demo templates because backend templates are unavailable.", error);
        if (cancelled) return;
        setTemplates(fallbackTemplates);
        setLoadStatus("fallback");
      }
    };

    loadTemplates();

    return () => {
      cancelled = true;
    };
  }, [fallbackTemplates]);

  const filteredTemplates = templates.filter((template) => {
    if (selectedStatus === "all") return true;
    if (selectedStatus === "draft") return template.status === "draft";
    if (selectedStatus === "active") return template.status === "active";
    return template.status !== "draft" && template.status !== "active";
  });

  const statusCounts: Record<AdminStatusFilter, number> = {
    all: templates.length,
    draft: templates.filter((template) => template.status === "draft").length,
    active: templates.filter((template) => template.status === "active").length,
    nonactive: templates.filter((template) => template.status !== "draft" && template.status !== "active").length,
  };

  const handleDeleteTemplate = async (template: Template) => {
    if (loadStatus !== "loaded") {
      setDeleteError("Demo fallback templates cannot be deleted from the database.");
      return;
    }
    const confirmed = window.confirm(
      `Delete template "${template.name}"?\n\nThis will permanently delete the template, pages, fields, ignore regions, and embedding jobs from the database. This action cannot be undone.`
    );
    if (!confirmed) return;

    setDeletingTemplateId(template.id);
    setDeleteMessage("");
    setDeleteError("");
    try {
      await deleteTemplateApi(template.id);
      setTemplates((current) => current.filter((item) => item.id !== template.id));
      setDeleteMessage(`Deleted template "${template.name}".`);
    } catch (error) {
      console.warn("Template delete failed.", error);
      setDeleteError(error instanceof Error ? error.message : "Template delete failed.");
    } finally {
      setDeletingTemplateId(null);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <h2 className="text-sm font-black text-slate-800 uppercase tracking-wide">Templates</h2>
        <div className="grid w-full gap-2 sm:grid-cols-4 lg:w-auto lg:min-w-[520px]">
          {statusFilterOptions.map((status) => (
            <button
              key={status.value}
              type="button"
              onClick={() => setSelectedStatus(status.value)}
              className={`inline-flex h-10 items-center justify-between rounded-xl border px-3 text-xs font-black transition-colors ${
                selectedStatus === status.value
                  ? "border-indigo-500 bg-indigo-600 text-white"
                  : "border-slate-200 bg-slate-100 text-slate-600 hover:bg-slate-50"
              }`}
            >
              <span>{status.label}</span>
              <span className={`ml-2 inline-flex min-w-6 justify-center rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                selectedStatus === status.value ? "bg-white/20 text-white" : "bg-white text-slate-500"
              }`}>
                {statusCounts[status.value]}
              </span>
            </button>
          ))}
        </div>
      </div>

      {loadStatus === "loading" && (
        <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500">Loading persisted templates...</p>
      )}
      {loadStatus === "fallback" && (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
          Backend unavailable. Showing clearly labeled demo fallback templates only.
        </p>
      )}
      {deleteMessage && (
        <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">{deleteMessage}</p>
      )}
      {deleteError && (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-700">{deleteError}</p>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {filteredTemplates.map((template) => (
          <div key={template.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
            <div>
              <div className="text-sm font-black text-slate-800">{template.name}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <span className="text-[10px] font-bold uppercase text-slate-400">{template.status}</span>
                {loadStatus === "fallback" && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-black uppercase text-amber-700">demo fallback</span>
                )}
              </div>
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
              <button
                type="button"
                onClick={() => handleDeleteTemplate(template)}
                disabled={loadStatus !== "loaded" || deletingTemplateId === template.id}
                className="rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-black text-red-600 disabled:border-slate-200 disabled:text-slate-400"
              >
                {deletingTemplateId === template.id ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        ))}
        {loadStatus === "loaded" && filteredTemplates.length === 0 && (
          <p className="rounded-xl bg-slate-50 p-4 text-sm font-semibold text-slate-500 md:col-span-2 xl:col-span-3">
            No persisted templates found.
          </p>
        )}
      </div>
    </section>
  );
}
