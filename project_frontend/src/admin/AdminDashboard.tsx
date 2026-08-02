
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  BadgeCheck,
  CircleX,
  FileClock,
  FilePenLine,
} from "lucide-react";
import { AdminTemplateRequest, Template } from "../types/ocr";
import { fetchAdminDashboard, fetchTemplateRequests, fetchTemplates } from "./adminApi";
import { AdminDashboardSummary } from "./adminTypes";
import { EmptyState, PageHeader, StatusBadge, cardClassName } from "../shared/ui";

export default function AdminDashboard() {
  const [requests, setRequests] = useState<AdminTemplateRequest[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
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
      try {
        const [nextDashboard, nextRequests, nextTemplates] = await Promise.all([fetchAdminDashboard(), fetchTemplateRequests(), fetchTemplates()]);
        if (cancelled) return;
        setDashboard(nextDashboard);
        setRequests(nextRequests);
        setTemplates(nextTemplates);
      } catch (error) {
        console.warn("Admin dashboard load failed.", error);
        if (cancelled) return;
        const [nextRequests, nextTemplates] = await Promise.all([
          fetchTemplateRequests().catch(() => []),
          fetchTemplates().catch(() => []),
        ]);
        if (cancelled) return;
        setRequests(nextRequests);
        setTemplates(nextTemplates);
        setDashboard({
          pendingRequests: nextRequests.filter((request) => request.status === "submitted" || request.status === "in_review").length,
          draftTemplates: nextTemplates.filter((template) => template.status === "draft").length,
          activeTemplates: nextTemplates.filter((template) => template.status === "active").length,
          rejectedRequests: nextRequests.filter((request) => request.status === "rejected").length,
          templateCount: nextTemplates.length,
          latestRequests: nextRequests.slice(0, 4),
          latestTemplates: nextTemplates.slice(0, 4),
        });
      }
    };
    loadDashboard();
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = [
    ["รอตรวจ", dashboard.pendingRequests, FileClock, "bg-amber-50 text-amber-600"],
    ["ฉบับร่าง", dashboard.draftTemplates, FilePenLine, "bg-blue-50 text-blue-600"],
    ["ใช้งานอยู่", dashboard.activeTemplates, BadgeCheck, "bg-emerald-50 text-emerald-600"],
    ["ปฏิเสธ", dashboard.rejectedRequests, CircleX, "bg-red-50 text-red-600"],
  ] as const;

  return (
    <section className="space-y-4">
      <PageHeader
        eyebrow="ภาพรวมผู้ดูแล"
        title="แดชบอร์ด Template OCR"
        description="ติดตามคำขอสร้าง Template, ฉบับร่าง, Template ที่ใช้งานอยู่ และรายการที่ถูกปฏิเสธ"
        actions={
          <Link
            href="/admin/requests"
            className="inline-flex w-fit items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700 hover:bg-slate-50"
          >
            {"ตรวจคำขอ"}
            <ArrowUpRight size={13} />
          </Link>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(([label, value, Icon, tone]) => (
          <div key={label} className={`${cardClassName} p-4`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</p>
                <p className="mt-2 text-3xl font-black text-slate-900">{value}</p>
              </div>
              <div className={`rounded-xl p-2.5 ${tone}`}>
                <Icon size={18} />
              </div>
            </div>
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-slate-300" style={{ width: `${Math.min(Number(value) * 12, 100)}%` }} />
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <DashboardList
          title="คำขอล่าสุด"
          subtitle="คำขอสร้าง Template ที่เพิ่งส่งเข้ามา"
          href="/admin/requests"
          items={(dashboard.latestRequests.length ? dashboard.latestRequests : requests.slice(0, 4)).map((request) => ({
            id: request.id,
            title: request.requestTitle,
            meta: `${request.pageCount} หน้า ? ${request.documentType || "ยังไม่ระบุประเภท"}`,
            status: request.status,
            tone: "amber",
          }))}
          emptyText="ยังไม่มีคำขอ"
        />

        <DashboardList
          title="Template ล่าสุด"
          subtitle="Template ที่มีการอัปเดตล่าสุด"
          href="/admin/templates"
          items={(dashboard.latestTemplates.length ? dashboard.latestTemplates : templates.slice(0, 4)).map((template) => ({
            id: template.id,
            title: template.name,
            meta: template.documentType || "ยังไม่ระบุประเภท",
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
    <div className={`${cardClassName} p-4`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-800">{title}</h2>
          <p className="text-xs font-semibold text-slate-400">{subtitle}</p>
        </div>
        <Link href={href} className="inline-flex shrink-0 items-center gap-1 text-xs font-black text-indigo-600 hover:text-indigo-700">
          {"ดูทั้งหมด"}
          <ArrowUpRight size={12} />
        </Link>
      </div>

      <div className="space-y-2">
        {items.length === 0 ? (
          <EmptyState title={emptyText} message="ข้อมูลจะแสดงที่นี่เมื่อโหลดจาก Backend สำเร็จ" />
        ) : (
          items.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-black text-slate-800">{item.title}</p>
                <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">{item.meta}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <StatusBadge status={item.status} tone={item.tone === "amber" ? "warning" : "primary"} />
                {item.editHref && (
                  <Link href={item.editHref} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-black text-slate-600 hover:bg-slate-50">
                    {"แก้ไข"}
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
