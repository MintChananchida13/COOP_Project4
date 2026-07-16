"use client";

import { useEffect, useState } from "react";
import { FileImage } from "lucide-react";
import { Template } from "../types/ocr";
import { deleteTemplateApi, fetchTemplates } from "./adminApi";
import { AdminStatusFilter } from "./adminTypes";
import { useAdminState } from "./AdminState";
import { ActionButton, EmptyState, InlineState, LoadingState, PageHeader, StatusBadge, cardClassName } from "../shared/ui";

const statusFilterOptions: { value: AdminStatusFilter; label: string }[] = [
  { value: "all", label: "ทั้งหมด" },
  { value: "draft", label: "ฉบับร่าง" },
  { value: "active", label: "ใช้งานอยู่" },
  { value: "nonactive", label: "ไม่ใช้งาน" },
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
      setDeleteError("ไม่สามารถลบ Template ตัวอย่างได้ เพราะไม่ได้มาจากฐานข้อมูลจริง");
      return;
    }
    const confirmed = window.confirm(
      `ลบ Template "${template.name}"?\n\nระบบจะลบ Template, หน้าเอกสาร, Field, Ignore Region และประวัติ Embedding ออกจากฐานข้อมูลถาวร การดำเนินการนี้ย้อนกลับไม่ได้`
    );
    if (!confirmed) return;

    setDeletingTemplateId(template.id);
    setDeleteMessage("");
    setDeleteError("");
    try {
      await deleteTemplateApi(template.id);
      setTemplates((current) => current.filter((item) => item.id !== template.id));
      setDeleteMessage(`ลบ Template "${template.name}" เรียบร้อยแล้ว`);
    } catch (error) {
      console.warn("Template delete failed.", error);
      setDeleteError(error instanceof Error ? error.message : "ลบ Template ไม่สำเร็จ");
    } finally {
      setDeletingTemplateId(null);
    }
  };

  return (
    <section className="space-y-4">
      <PageHeader
        eyebrow="คลัง Template"
        title="รายการ Template เอกสาร"
        description="จัดการ Template ฉบับร่าง Template ที่ใช้งานจริง และ Template ที่ยังไม่พร้อมใช้งาน การลบข้อมูลจะมีผลกับฐานข้อมูลจริงเท่านั้น"
      />

      <div className={`${cardClassName} p-4 space-y-4`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-800">สถานะ Template</h2>
          <p className="mt-1 text-xs font-medium text-slate-500">เลือกดู Template ตามสถานะโดยไม่เปลี่ยนข้อมูลจริง</p>
        </div>
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

      {loadStatus === "loading" && <LoadingState message="กำลังโหลด Template จากฐานข้อมูล..." />}
      {loadStatus === "fallback" && (
        <InlineState tone="warning" message="เชื่อมต่อ Backend ไม่ได้ กำลังแสดง Template ตัวอย่างสำหรับทดสอบเท่านั้น" />
      )}
      {deleteMessage && (
        <InlineState tone="success" message={deleteMessage} />
      )}
      {deleteError && (
        <InlineState tone="danger" message={deleteError} />
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {filteredTemplates.map((template) => (
          <div key={template.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="relative h-44 border-b border-slate-200 bg-slate-100">
              {template.previewImageUrl ? (
                <img
                  src={template.previewImageUrl}
                  alt={`${template.name} template preview`}
                  className="h-full w-full bg-white object-contain"
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-400">
                  <FileImage size={30} strokeWidth={1.8} />
                  <span className="ui-caption font-semibold">ไม่มีภาพตัวอย่าง</span>
                </div>
              )}
              <div className="absolute bottom-3 right-3 rounded-full border border-slate-200 bg-white/95 px-2.5 py-1 text-[11px] font-bold tabular-nums text-slate-600 shadow-sm">
                {template.pageCount} หน้า
              </div>
            </div>
            <div className="space-y-3 p-4">
            <div>
              <div className="line-clamp-2 min-h-10 text-sm font-black leading-5 text-slate-900">{template.name}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <StatusBadge status={template.status} />
                {loadStatus === "fallback" && (
                  <StatusBadge status="demo fallback" tone="warning" />
                )}
              </div>
            </div>
            <div className="rounded-xl bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500">
              {template.documentType || "No document type"} · Template preview
            </div>
            <div className="flex flex-wrap gap-2">
              <ActionButton href={`/admin/templates/${template.id}/edit`} tone="primary">แก้ไข</ActionButton>
              <ActionButton href={`/admin/templates/${template.id}/test`}>ตรวจสอบก่อนเผยแพร่</ActionButton>
              <button
                type="button"
                onClick={() => handleDeleteTemplate(template)}
                disabled={loadStatus !== "loaded" || deletingTemplateId === template.id}
                className="ui-stable-action-sm rounded-xl border border-red-200 bg-white px-4 py-2.5 text-xs font-black text-red-600 transition-colors hover:bg-red-50 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
              >
                {deletingTemplateId === template.id ? "กำลังลบ..." : "ลบ"}
              </button>
            </div>
            </div>
          </div>
        ))}
        {loadStatus === "loaded" && filteredTemplates.length === 0 && (
          <div className="md:col-span-2 xl:col-span-3">
            <EmptyState title="ไม่พบ Template" message="ไม่มี Template ที่ตรงกับสถานะที่เลือก" />
          </div>
        )}
      </div>
      </div>
    </section>
  );
}
