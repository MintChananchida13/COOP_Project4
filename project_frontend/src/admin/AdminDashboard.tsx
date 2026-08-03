"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, BadgeCheck, CircleX, FileClock, FilePenLine, Plus } from "lucide-react";
import { AdminTemplateRequest, Template } from "../types/ocr";
import { EmptyState, StatusBadge } from "../shared/ui";
import { fetchAdminDashboard, fetchTemplateRequests, fetchTemplates } from "./adminApi";
import { AdminDashboardSummary } from "./adminTypes";

const buildDashboardFromLists = (nextRequests: AdminTemplateRequest[], nextTemplates: Template[]): AdminDashboardSummary => ({
  pendingRequests: nextRequests.filter((request) => request.status === "submitted" || request.status === "in_review").length,
  draftTemplates: nextTemplates.filter((template) => template.status === "draft").length,
  activeTemplates: nextTemplates.filter((template) => template.status === "active").length,
  rejectedRequests: nextRequests.filter((request) => request.status === "rejected").length,
  templateCount: nextTemplates.length,
  latestRequests: nextRequests.slice(0, 4),
  latestTemplates: nextTemplates.slice(0, 4),
});

const mergeDashboardWithLists = (
  nextDashboard: AdminDashboardSummary,
  nextRequests: AdminTemplateRequest[],
  nextTemplates: Template[]
): AdminDashboardSummary => {
  const listDashboard = buildDashboardFromLists(nextRequests, nextTemplates);
  const shouldTrustListCounts =
    nextDashboard.templateCount === 0 &&
    nextDashboard.pendingRequests === 0 &&
    nextDashboard.draftTemplates === 0 &&
    nextDashboard.activeTemplates === 0 &&
    nextDashboard.rejectedRequests === 0 &&
    (nextRequests.length > 0 || nextTemplates.length > 0);

  return {
    pendingRequests: shouldTrustListCounts ? listDashboard.pendingRequests : nextDashboard.pendingRequests,
    draftTemplates: shouldTrustListCounts ? listDashboard.draftTemplates : nextDashboard.draftTemplates,
    activeTemplates: shouldTrustListCounts ? listDashboard.activeTemplates : nextDashboard.activeTemplates,
    rejectedRequests: shouldTrustListCounts ? listDashboard.rejectedRequests : nextDashboard.rejectedRequests,
    templateCount: shouldTrustListCounts ? listDashboard.templateCount : nextDashboard.templateCount,
    latestRequests: nextDashboard.latestRequests.length ? nextDashboard.latestRequests : listDashboard.latestRequests,
    latestTemplates: nextDashboard.latestTemplates.length ? nextDashboard.latestTemplates : listDashboard.latestTemplates,
  };
};

const formatDateTime = (value?: string) => {
  if (!value) return "ไม่พบเวลาอัปเดต";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
};

export default function AdminDashboard() {
  const [requests, setRequests] = useState<AdminTemplateRequest[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadStatus, setLoadStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [dashboard, setDashboard] = useState<AdminDashboardSummary>({
    pendingRequests: 0,
    draftTemplates: 0,
    activeTemplates: 0,
    rejectedRequests: 0,
    templateCount: 0,
    latestRequests: [],
    latestTemplates: [],
  });

  useEffect(() => {
    let cancelled = false;
    const loadDashboard = async () => {
      setLoadStatus("loading");
      try {
        const [dashboardResult, requestsResult, templatesResult] = await Promise.allSettled([
          fetchAdminDashboard(),
          fetchTemplateRequests(),
          fetchTemplates(),
        ]);
        if (cancelled) return;

        const nextRequests = requestsResult.status === "fulfilled" ? requestsResult.value : [];
        const nextTemplates = templatesResult.status === "fulfilled" ? templatesResult.value : [];
        const listDashboard = buildDashboardFromLists(nextRequests, nextTemplates);
        const nextDashboard = dashboardResult.status === "fulfilled"
          ? mergeDashboardWithLists(dashboardResult.value, nextRequests, nextTemplates)
          : listDashboard;

        setRequests(nextRequests);
        setTemplates(nextTemplates);
        setDashboard(nextDashboard);
        setLoadStatus(requestsResult.status === "fulfilled" || templatesResult.status === "fulfilled" ? "loaded" : "error");

        if (dashboardResult.status === "rejected") console.warn("Admin dashboard summary load failed.", dashboardResult.reason);
        if (requestsResult.status === "rejected") console.warn("Template request list load failed.", requestsResult.reason);
        if (templatesResult.status === "rejected") console.warn("Template list load failed.", templatesResult.reason);
      } catch (error) {
        console.warn("Admin dashboard load failed.", error);
        if (cancelled) return;
        const [nextRequests, nextTemplates] = await Promise.allSettled([
          fetchTemplateRequests().catch(() => []),
          fetchTemplates().catch(() => []),
        ]);
        if (cancelled) return;
        const safeRequests = nextRequests.status === "fulfilled" ? nextRequests.value : [];
        const safeTemplates = nextTemplates.status === "fulfilled" ? nextTemplates.value : [];
        setRequests(safeRequests);
        setTemplates(safeTemplates);
        setDashboard(buildDashboardFromLists(safeRequests, safeTemplates));
        setLoadStatus(safeRequests.length > 0 || safeTemplates.length > 0 ? "loaded" : "error");
      }
    };
    loadDashboard();
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = [
    ["Pending Requests", dashboard.pendingRequests, FileClock, "bg-amber-50 text-amber-600"],
    ["Published Templates", dashboard.activeTemplates, BadgeCheck, "bg-emerald-50 text-emerald-600"],
    ["Draft Versions", dashboard.draftTemplates, FilePenLine, "bg-sky-50 text-sky-600"],
    ["Rejected Requests", dashboard.rejectedRequests, CircleX, "bg-red-50 text-red-600"],
  ] as const;

  const recentRequests = dashboard.latestRequests.length ? dashboard.latestRequests : requests.slice(0, 4);
  const recentTemplates = dashboard.latestTemplates.length ? dashboard.latestTemplates : templates.slice(0, 4);

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

      {loadStatus === "loading" && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm font-semibold text-slate-500 shadow-sm">
          กำลังโหลดข้อมูลล่าสุดจาก Backend...
        </div>
      )}
      {loadStatus === "error" && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-700 shadow-sm">
          โหลดข้อมูล Dashboard ไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อ Backend แล้วลองใหม่
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <DashboardList
          title="Recent Template Requests"
          subtitle="คำขอสร้าง Template ที่อัปเดตล่าสุด"
          href="/admin/requests"
          items={recentRequests.map((request) => ({
            id: request.id,
            title: request.requestTitle,
            meta: `${request.pageCount} หน้า · ${request.documentType || "ไม่ระบุประเภท"} · ${formatDateTime(request.updatedAt || request.createdAt)}`,
            status: request.status,
            tone: "amber",
          }))}
          emptyText="ยังไม่มีคำขอ"
        />

        <DashboardList
          title="Recent Templates"
          subtitle="Template ที่อัปเดตล่าสุด"
          href="/admin/templates"
          items={recentTemplates.map((template) => ({
            id: template.id,
            title: template.name,
            meta: `${template.documentType || "ไม่ระบุประเภท"} · ${template.pageCount} หน้า · ${formatDateTime(template.updatedAt || template.createdAt)}`,
            status: template.status,
            tone: "indigo",
            editHref: `/admin/templates/${template.id}/edit`,
          }))}
          emptyText="ยังไม่มี Template"
        />
      </div>
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
    tone: "amber" | "indigo";
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
                <StatusBadge status={item.status} tone={item.tone === "amber" ? "warning" : "primary"} />
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
