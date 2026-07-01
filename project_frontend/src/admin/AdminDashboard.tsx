"use client";

import Link from "next/link";
import {
  ArrowUpRight,
  BadgeCheck,
  CircleX,
  FileClock,
  FilePenLine,
} from "lucide-react";
import { useAdminState } from "./AdminState";

export default function AdminDashboard() {
  const { dashboard, requests, templates } = useAdminState();

  const stats = [
    ["Pending", dashboard.pendingRequests, FileClock, "bg-amber-50 text-amber-600"],
    ["Draft", dashboard.draftTemplates, FilePenLine, "bg-blue-50 text-blue-600"],
    ["Approved", dashboard.approvedTemplates, BadgeCheck, "bg-emerald-50 text-emerald-600"],
    ["Rejected", dashboard.rejectedTemplates, CircleX, "bg-red-50 text-red-600"],
  ] as const;

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-indigo-500">
              Admin Overview
            </p>
            <h1 className="mt-1 text-xl font-black text-slate-900">
              Template OCR Dashboard
            </h1>
            <p className="mt-1 text-xs font-semibold text-slate-400">
              Monitor template requests, drafts, approvals, and rejected items.
            </p>
          </div>

          <Link
            href="/admin/requests"
            className="inline-flex w-fit items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700 hover:bg-slate-50"
          >
            Review Requests
            <ArrowUpRight size={13} />
          </Link>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(([label, value, Icon, tone]) => (
          <div
            key={label}
            className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                  {label}
                </p>
                <p className="mt-2 text-3xl font-black text-slate-900">
                  {value}
                </p>
              </div>

              <div className={`rounded-xl p-2.5 ${tone}`}>
                <Icon size={18} />
              </div>
            </div>

            <div className="mt-3 h-1 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-slate-300"
                style={{ width: `${Math.min(Number(value) * 12, 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <DashboardList
          title="Recent Requests"
          subtitle="Latest template requests."
          href="/admin/requests"
          items={requests.slice(0, 4).map((request) => ({
            id: request.id,
            title: request.requestTitle,
            meta: `${request.pageCount} page${
              request.pageCount === 1 ? "" : "s"
            } · ${request.documentType || "Uncategorized"}`,
            status: request.status,
            tone: "amber",
          }))}
          emptyText="No requests."
        />

        <DashboardList
          title="Recent Templates"
          subtitle="Recently updated templates."
          href="/admin/templates"
          items={templates.slice(0, 4).map((template) => ({
            id: template.id,
            title: template.name,
            meta: template.documentType || "Uncategorized",
            status: template.status,
            tone: "indigo",
            editHref: `/admin/templates/${template.id}/edit`,
          }))}
          emptyText="No templates."
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
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-800">
            {title}
          </h2>
          <p className="text-xs font-semibold text-slate-400">{subtitle}</p>
        </div>

        <Link
          href={href}
          className="inline-flex items-center gap-1 text-xs font-black text-indigo-600 hover:text-indigo-700"
        >
          View All
          <ArrowUpRight size={12} />
        </Link>
      </div>

      <div className="space-y-2">
        {items.length === 0 ? (
          <p className="rounded-xl bg-slate-50 p-3 text-sm font-semibold text-slate-400">
            {emptyText}
          </p>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-black text-slate-800">
                  {item.title}
                </p>
                <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                  {item.meta}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ${
                    item.tone === "amber"
                      ? "bg-amber-50 text-amber-600"
                      : "bg-indigo-50 text-indigo-600"
                  }`}
                >
                  {item.status}
                </span>

                {item.editHref && (
                  <Link
                    href={item.editHref}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-black text-slate-600 hover:bg-slate-50"
                  >
                    Edit
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