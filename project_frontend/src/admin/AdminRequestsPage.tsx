"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AdminTemplateRequest } from "../types/ocr";
import { fetchTemplateRequests } from "./adminApi";
import { useAdminState } from "./AdminState";

type RequestFilter = "pending" | "converted" | "rejected" | "all";

const formatDate = (value?: string) => {
  if (!value) return "Not submitted";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

export default function AdminRequestsPage() {
  const { requests: fallbackRequests } = useAdminState();
  const [requests, setRequests] = useState<AdminTemplateRequest[]>([]);
  const [loadStatus, setLoadStatus] = useState<"loading" | "loaded" | "fallback">("loading");
  const [filter, setFilter] = useState<RequestFilter>("pending");

  useEffect(() => {
    let cancelled = false;

    const loadRequests = async () => {
      setLoadStatus("loading");
      try {
        const persistedRequests = await fetchTemplateRequests();
        if (cancelled) return;
        setRequests(persistedRequests);
        setLoadStatus("loaded");
      } catch (error) {
        console.warn("Using mock template request fallback because backend is unavailable.", error);
        if (cancelled) return;
        setRequests(fallbackRequests);
        setLoadStatus("fallback");
      }
    };

    loadRequests();

    return () => {
      cancelled = true;
    };
  }, [fallbackRequests]);

  const counts = {
    pending: requests.filter((request) => request.status === "submitted" || request.status === "in_review").length,
    converted: requests.filter((request) => request.status === "converted").length,
    rejected: requests.filter((request) => request.status === "rejected").length,
    all: requests.length,
  };

  const filteredRequests = requests.filter((request) => {
    if (filter === "all") return true;
    if (filter === "pending") return request.status === "submitted" || request.status === "in_review";
    return request.status === filter;
  });

  const filterTabs: { value: RequestFilter; label: string; count: number }[] = [
    { value: "pending", label: "Pending", count: counts.pending },
    { value: "converted", label: "Converted", count: counts.converted },
    { value: "rejected", label: "Rejected", count: counts.rejected },
    { value: "all", label: "All", count: counts.all },
  ];

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-sm font-black uppercase tracking-wide text-slate-800">
              Template Requests
            </h2>
            <p className="mt-1 text-xs font-semibold text-slate-400">
              Review submitted template requests from the OCR Studio.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-4">
            {filterTabs.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => setFilter(tab.value)}
                className={`rounded-xl border px-3 py-2 text-xs font-black transition-colors ${
                  filter === tab.value
                    ? "border-indigo-500 bg-indigo-600 text-white shadow-sm"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {tab.label}
                <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] ${
                  filter === tab.value ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"
                }`}>
                  {tab.count}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {loadStatus === "loading" && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm font-semibold text-slate-500 shadow-sm">
          Loading persisted template requests...
        </div>
      )}
      {loadStatus === "fallback" && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs font-bold text-amber-700 shadow-sm">
          Backend unavailable. Showing demo fallback requests only.
        </div>
      )}

      {requests.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500 shadow-sm">
          No template requests found.
        </div>
      ) : filteredRequests.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500 shadow-sm">
          No {filter === "pending" ? "pending" : filter} template requests.
        </div>
      ) : (
        <div className="grid gap-3">
          {filteredRequests.map((request) => (
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

                <div className="flex flex-wrap gap-2">
                  {request.status === "converted" && request.convertedTemplateId && (
                    <Link
                      href={`/admin/templates/${request.convertedTemplateId}/edit`}
                      className="inline-flex w-fit rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-black text-emerald-700 hover:bg-emerald-100"
                    >
                      Open Template
                    </Link>
                  )}
                  <Link
                    href={`/admin/requests/${request.id}`}
                    className="inline-flex w-fit rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white hover:bg-indigo-700"
                  >
                    View Request
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
