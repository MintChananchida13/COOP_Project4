"use client";

import Link from "next/link";
import { useAdminState } from "./AdminState";

const formatDate = (value?: string) => {
  if (!value) return "Not submitted";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

export default function AdminRequestsPage() {
  const { requests } = useAdminState();

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-black uppercase tracking-wide text-slate-800">
          Template Requests
        </h2>
        <p className="mt-1 text-xs font-semibold text-slate-400">
          Review submitted template requests from the OCR Studio.
        </p>
      </div>

      {requests.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500 shadow-sm">
          No template requests found.
        </div>
      ) : (
        <div className="grid gap-3">
          {requests.map((request) => (
            <article
              key={request.id}
              className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-black text-slate-900">
                    {request.requestTitle}
                  </h3>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-[10px] font-black uppercase text-indigo-600">
                      {request.requestMode}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">
                      {request.status}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">
                      {request.documentType || "No type"}
                    </span>
                  </div>
                  <p className="mt-2 text-xs font-semibold text-slate-500">
                    {request.pageCount} page{request.pageCount === 1 ? "" : "s"} | Submitted: {formatDate(request.createdAt)}
                  </p>
                </div>

                <Link
                  href={`/admin/requests/${request.id}`}
                  className="inline-flex w-fit rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white hover:bg-indigo-700"
                >
                  View Request
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
