"use client";

import Link from "next/link";
import { useState } from "react";
import { useAdminState } from "./AdminState";

export default function AdminRequestsPage() {
  const { requests, rejectRequest, convertRequestToTemplate } = useAdminState();

  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [adminNote, setAdminNote] = useState("");

  const selectedRequest = requests.find(
    (request) => request.id === selectedRequestId
  );

  const handleOpenDetail = (requestId: string) => {
    setSelectedRequestId(requestId);
    setAdminNote("");
  };

  const handleCloseDetail = () => {
    setSelectedRequestId(null);
    setAdminNote("");
  };

  const handleConvert = () => {
    if (!selectedRequest) return;
    convertRequestToTemplate(selectedRequest.id, adminNote);
  };

  return (
<section className="space-y-4">
  {requests.map((request) => {
    const isOpen = selectedRequestId === request.id;

    return (
      <div
        key={request.id}
        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-black text-slate-900">
              {request.requestTitle}
            </h3>

            <p className="mt-1 text-xs font-bold uppercase text-slate-400">
              {request.requestMode} | {request.status} |{" "}
              {request.pageCount} page{request.pageCount === 1 ? "" : "s"}
            </p>
          </div>

          <button
            type="button"
            onClick={() =>
              setSelectedRequestId(isOpen ? null : request.id)
            }
            className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-xs font-black text-indigo-700 hover:bg-indigo-100"
          >
            {isOpen ? "Hide Details" : "View Details"}
          </button>
        </div>

        {isOpen && (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs font-bold text-slate-700">
              {request.userNote || "No user note."}
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <h3 className="text-[10px] font-black uppercase text-slate-400">
                  Pages
                </h3>

                <div className="mt-2 flex flex-wrap gap-2">
                  {request.pages.map((page) => (
                    <span
                      key={page.id}
                      className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] font-black text-slate-600"
                    >
                      Page {page.pageNumber}
                    </span>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <h3 className="text-[10px] font-black uppercase text-slate-400">
                  Requested ROI Fields
                </h3>

                <div className="mt-2 space-y-1.5">
                  {request.requestedFields.length === 0 ? (
                    <p className="text-xs font-semibold text-slate-500">
                      No ROI fields. Admin creates fields manually.
                    </p>
                  ) : (
                    request.requestedFields.map((field) => (
                      <div
                        key={field.id}
                        className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-bold text-slate-700"
                      >
                        Page {field.roi.pageNumber}: {field.displayLabel}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <textarea
              value={adminNote}
              onChange={(event) => setAdminNote(event.target.value)}
              placeholder="Admin note"
              className="mt-4 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold outline-none focus:border-indigo-500"
              rows={3}
            />

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => rejectRequest(request.id, adminNote)}
                className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-black text-red-700"
              >
                Reject
              </button>

              <button
                type="button"
                onClick={() =>
                  convertRequestToTemplate(request.id, adminNote)
                }
                className="rounded-xl bg-indigo-600 px-3 py-2 text-xs font-black text-white"
              >
                Convert to Template Draft
              </button>
            </div>
          </div>
        )}
      </div>
    );
  })}
</section>
  );
}