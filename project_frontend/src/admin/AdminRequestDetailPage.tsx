"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import BaseWorkspace, { WorkspacePage } from "../shared/workspace/BaseWorkspace";
import { DEFAULT_WORKSPACE_IMAGE_METRICS, ratioToImageBox, WorkspaceImageMetrics } from "../shared/workspace/roiGeometry";
import RoiLayer from "../shared/workspace/RoiLayer";
import { WorkspaceRoi } from "../shared/workspace/RoiBox";
import WorkspaceCanvas from "../shared/workspace/WorkspaceCanvas";
import { AdminTemplateRequest, TemplateRequestPage } from "../types/ocr";
import { ADMIN_API_BASE_URL, fetchTemplateRequest, fetchTemplateRequestPages } from "./adminApi";
import { samplePage } from "./adminMockData";
import { useAdminState } from "./AdminState";

const toWorkspaceRoi = (
  field: AdminTemplateRequest["requestedFields"][number],
  index: number,
  imageMetrics: WorkspaceImageMetrics
): WorkspaceRoi & { kind: string; pageNumber: number } => {
  const box = ratioToImageBox(field.roi, imageMetrics);
  return {
    id: Number(field.id.replace(/\D/g, "").slice(-8)) || index + 1,
    fieldName: field.displayLabel || field.fieldName,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    pageIndex: field.roi.pageNumber - 1,
    pageNumber: field.roi.pageNumber,
    kind: "requested_field",
    type: "text",
  };
};

export default function AdminRequestDetailPage({ requestId }: { requestId: string }) {
  const router = useRouter();
  const { requests, convertRequestToTemplate, rejectRequest } = useAdminState();
  const fallbackRequest = requests.find((request) => request.id === requestId);
  const [request, setRequest] = useState<AdminTemplateRequest | null>(fallbackRequest || null);
  const [pages, setPages] = useState<TemplateRequestPage[]>(fallbackRequest?.pages || []);
  const [currentPage, setCurrentPage] = useState(0);
  const [imageMetrics, setImageMetrics] = useState<WorkspaceImageMetrics>(DEFAULT_WORKSPACE_IMAGE_METRICS);
  const [adminNote, setAdminNote] = useState("");
  const [loadStatus, setLoadStatus] = useState<"loading" | "loaded" | "fallback" | "error">("loading");
  const [actionStatus, setActionStatus] = useState("");

  useEffect(() => {
    let cancelled = false;

    const loadRequest = async () => {
      setLoadStatus("loading");
      try {
        const [requestDetail, requestPages] = await Promise.all([
          fetchTemplateRequest(requestId),
          fetchTemplateRequestPages(requestId),
        ]);

        if (cancelled) return;
        setRequest({ ...requestDetail, pages: requestPages.length > 0 ? requestPages : requestDetail.pages });
        setPages(requestPages.length > 0 ? requestPages : requestDetail.pages);
        setLoadStatus("loaded");
      } catch (error) {
        console.warn("Using admin request fallback because backend detail is unavailable.", error);
        if (!cancelled) {
          setRequest(fallbackRequest || null);
          setPages(fallbackRequest?.pages || []);
          setLoadStatus(fallbackRequest ? "fallback" : "error");
        }
      }
    };

    loadRequest();

    return () => {
      cancelled = true;
    };
  }, [fallbackRequest, requestId]);

  const workspacePages: WorkspacePage[] = useMemo(() => {
    const sourcePages = pages.length > 0 ? pages : request?.pages || [];
    return sourcePages.map((page) => ({
      id: page.id,
      src: page.sampleImageUrl || samplePage,
      label: `Page ${page.pageNumber}`,
    }));
  }, [pages, request?.pages]);

  const rois = useMemo(() => {
    return (request?.requestedFields || []).map((field, index) => toWorkspaceRoi(field, index, imageMetrics));
  }, [imageMetrics, request?.requestedFields]);

  const fieldsByPage = useMemo(() => {
    return (request?.requestedFields || []).reduce<Record<number, AdminTemplateRequest["requestedFields"]>>((acc, field) => {
      acc[field.roi.pageNumber] = [...(acc[field.roi.pageNumber] || []), field];
      return acc;
    }, {});
  }, [request?.requestedFields]);

  const handleReject = async () => {
    if (!request) return;
    try {
      const response = await fetch(`${ADMIN_API_BASE_URL}/admin/template-requests/${request.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: adminNote || null }),
      });

      if (!response.ok) {
        throw new Error(`Reject failed with ${response.status}`);
      }

      rejectRequest(request.id, adminNote);
      setRequest({ ...request, status: "rejected", adminNote });
      setActionStatus("Request rejected.");
    } catch (error) {
      console.warn("TODO: backend reject unavailable, using temporary local reject.", error);
      rejectRequest(request.id, adminNote);
      setRequest({ ...request, status: "rejected", adminNote });
      setActionStatus("Request rejected locally. TODO: persist reject when backend is available.");
    }
  };

  const handleConvert = () => {
    if (!request) return;
    const templateId = convertRequestToTemplate(request.id, adminNote, request);
    if (templateId) {
      router.push(`/admin/templates/${templateId}/edit`);
    }
  };

  if (loadStatus === "loading") {
    return <section className="rounded-2xl border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500 shadow-sm">Loading request...</section>;
  }

  if (!request) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-black text-slate-900">Request not found</h2>
        <Link href="/admin/requests" className="mt-4 inline-flex rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white">
          Back to Requests
        </Link>
      </section>
    );
  }

  const safeCurrentPage = Math.min(currentPage, Math.max(workspacePages.length - 1, 0));
  const currentPageFields = fieldsByPage[safeCurrentPage + 1] || [];

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-xl font-black text-slate-900">{request.requestTitle}</h2>
            <div className="mt-2 flex flex-wrap gap-2">
              <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-[10px] font-black uppercase text-indigo-600">{request.requestMode}</span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">{request.status}</span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">{request.documentType || "No type"}</span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">{request.pageCount} pages</span>
            </div>
            {loadStatus === "fallback" && (
              <p className="mt-2 text-xs font-bold text-amber-600">Showing mock fallback because backend detail is unavailable.</p>
            )}
          </div>

          <Link href="/admin/requests" className="inline-flex w-fit rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700 hover:bg-slate-50">
            Back to Requests
          </Link>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <BaseWorkspace
          pages={workspacePages.length > 0 ? workspacePages : [{ id: "empty", src: samplePage, label: "Page 1" }]}
          currentPage={safeCurrentPage}
          onPageChange={setCurrentPage}
          title="Request Preview"
        >
          <WorkspaceCanvas
            imageSrc={workspacePages[safeCurrentPage]?.src || samplePage}
            className="h-[620px]"
            onImageMetricsChange={setImageMetrics}
          >
            {request.requestMode === "image_with_roi" && (
              <RoiLayer rois={rois} currentPage={safeCurrentPage} readonly showLabels />
            )}
          </WorkspaceCanvas>
        </BaseWorkspace>

        <aside className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm h-fit xl:h-[704px] xl:overflow-y-auto space-y-4">
          <section className="space-y-2">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Requested ROI Fields</h3>
            {request.requestMode === "image_only" ? (
              <p className="rounded-xl bg-slate-50 p-3 text-xs font-semibold text-slate-500">
                Image-only request. No requested ROI fields were submitted.
              </p>
            ) : currentPageFields.length === 0 ? (
              <p className="rounded-xl bg-slate-50 p-3 text-xs font-semibold text-slate-500">
                No ROI fields on this page.
              </p>
            ) : (
              currentPageFields.map((field) => (
                <div key={field.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs font-semibold text-slate-700">
                  <div className="font-black text-slate-900">{field.displayLabel}</div>
                  <div className="mt-1 text-slate-500">{field.fieldName}</div>
                  <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] font-bold text-slate-500">
                    <span>x: {field.roi.xRatio.toFixed(3)}</span>
                    <span>y: {field.roi.yRatio.toFixed(3)}</span>
                    <span>w: {field.roi.widthRatio.toFixed(3)}</span>
                    <span>h: {field.roi.heightRatio.toFixed(3)}</span>
                  </div>
                </div>
              ))
            )}
          </section>

          <label className="block space-y-1">
            <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Admin note</span>
            <textarea
              value={adminNote}
              onChange={(event) => setAdminNote(event.target.value)}
              rows={4}
              placeholder="Reason, review note, or conversion context"
              className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-800 outline-none focus:border-indigo-500 focus:bg-white"
            />
          </label>

          {actionStatus && <p className="text-xs font-bold text-emerald-600">{actionStatus}</p>}

          <div className="grid gap-2">
            <button type="button" onClick={handleReject} className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-black text-red-700">
              Reject
            </button>
            <button type="button" onClick={handleConvert} className="rounded-xl bg-indigo-600 px-3 py-2 text-xs font-black text-white">
              Convert to Template Draft
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
}
