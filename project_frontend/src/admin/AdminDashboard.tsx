"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, BadgeCheck, CircleX, FileClock, FilePenLine, Plus } from "lucide-react";
import { AdminTemplateRequest, Template } from "../types/ocr";
import { EmptyState, InlineState, LoadingState, StatusBadge } from "../shared/ui";
import { fetchTemplateRequests, fetchTemplates } from "./adminApi";

type LoadStatus = "loading" | "loaded" | "error";

const formatDateTime = (value?: string) => {
  if (!value) return "ไม่พบเวลาอัปเดต";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
};

export default function AdminDashboard() {
  const [requests, setRequests] = useState<AdminTemplateRequest[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");

  useEffect(() => {
    let cancelled = false;

    const loadDashboardLists = async () => {
      setLoadStatus("loading");
      try {
        const [persistedRequests, persistedTemplates] = await Promise.all([fetchTemplateRequests(), fetchTemplates()]);
        if (cancelled) return;
        setRequests(persistedRequests);
        setTemplates(persistedTemplates);
        setLoadStatus("loaded");
      } catch (error) {
        console.warn("Admin dashboard lists load failed.", error);
        if (cancelled) return;
        setRequests([]);
        setTemplates([]);
        setLoadStatus("error");
      }
    };

    loadDashboardLists();

    return () => {
      cancelled = true;
    };
  }, []);

  const summary = useMemo(
    () => ({
      pendingRequests: requests.filter((request) => request.status === "submitted" || request.status === "in_review").length,
      publishedTemplates: templates.filter((template) => template.status === "active").length,
      draftVersions: templates.filter((template) => template.status === "draft").length,
      rejectedRequests: requests.filter((request) => request.status === "rejected").length,
      recentRequests: requests.slice(0, 4),
      recentTemplates: templates.slice(0, 4),
    }),
    [requests, templates]
  );

  const stats = [
    ["Pending Requests", summary.pendingRequests, FileClock, "bg-amber-50 text-amber-600"],
    ["Published Templates", summary.publishedTemplates, BadgeCheck, "bg-emerald-50 text-emerald-600"],
    ["Draft Versions", summary.draftVersions, FilePenLine, "bg-sky-50 text-sky-600"],
    ["Rejected Requests", summary.rejectedRequests, CircleX, "bg-red-50 text-red-600"],
  ] as const;

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-black tracking-tight text-slate-950">Admin Dashboard</h1>
          <p className="mt-1 text-sm font-semibold text-slate-500">ภาพรวมคำขอและ Template ล่าสุดของระบบ OCR</p>
        </div>
        <Link
          href="/admin/templates"
          className="inline-flex w-fit items-center gap-2 rounded-lg bg-slate-950 px-3 py-2 text-xs font-black text-white shadow-sm hover:bg-slate-800"
        >
          <Plus size={14} />
          Create
        </Link>
      </div>

      {loadStatus === "loading" && <LoadingState message="กำลังโหลดข้อมูลจาก Backend..." />}
      {loadStatus === "error" && (
        <InlineState tone="warning" message="โหลดข้อมูล Dashboard จาก Backend ไม่สำเร็จ กรุณาตรวจการเชื่อมต่อแล้วลองใหม่" />
      )}

      {loadStatus === "loaded" && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {stats.map(([label, value, Icon, tone]) => (
              <div key={label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold text-slate-500">{label}</p>
                    <p className="mt-1 text-2xl font-black tracking-tight text-slate-950">{value}</p>
                  </div>
                  <div className={`rounded-lg p-2 ${tone}`}>
                    <Icon size={16} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <DashboardList
              title="Recent Template Requests"
              subtitle="คำขอสร้าง Template ที่อัปเดตล่าสุด"
              href="/admin/requests"
              items={summary.recentRequests.map((request) => ({
                id: request.id,
                title: request.requestTitle,
                meta: `${request.pageCount} หน้า · ${request.documentType || "ไม่ระบุประเภท"} · ${formatDateTime(request.updatedAt || request.createdAt)}`,
                status: request.status,
                tone: "warning",
              }))}
              emptyText="ยังไม่มีคำขอ Template"
            />

            <DashboardList
              title="Recent Templates"
              subtitle="Template ที่อัปเดตล่าสุด"
              href="/admin/templates"
              items={summary.recentTemplates.map((template) => ({
                id: template.id,
                title: template.name,
                meta: `${template.documentType || "ไม่ระบุประเภท"} · ${template.pageCount} หน้า · ${formatDateTime(template.updatedAt || template.createdAt)}`,
                status: template.status,
                tone: "primary",
                editHref: `/admin/templates/${template.id}/edit`,
              }))}
              emptyText="ยังไม่มี Template"
            />
          </div>
        </>
      )}
    </section>
  );
}

function DashboardList({
  title,
  subtitle,
  href,
  items,
  emptyText,
}: {
  title: string;
  subtitle: string;
  href: string;
  items: {
    id: string;
    title: string;
    meta: string;
    status: string;
    tone: "primary" | "warning";
    editHref?: string;
  }[];
  emptyText: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-black tracking-tight text-slate-950">{title}</h2>
          <p className="text-xs font-semibold text-slate-500">{subtitle}</p>
        </div>
        <Link href={href} className="inline-flex shrink-0 items-center gap-1 text-xs font-black text-slate-600 hover:text-slate-950">
          ดูทั้งหมด
          <ArrowUpRight size={12} />
        </Link>
      </div>

      <div className="divide-y divide-slate-100">
        {items.length === 0 ? (
          <EmptyState title={emptyText} message="ข้อมูลจะแสดงที่นี่เมื่อโหลดจาก Backend สำเร็จ" />
        ) : (
          items.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="truncate text-sm font-black text-slate-900">{item.title}</p>
                <p className="mt-1 truncate text-[11px] font-semibold text-slate-500">{item.meta}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <StatusBadge status={item.status} tone={item.tone} />
                {item.editHref && (
                  <Link href={item.editHref} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-black text-slate-600 hover:bg-slate-50">
                    แก้ไข
                  </Link>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
