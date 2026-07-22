"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import BaseWorkspace, { WorkspacePage } from "../shared/workspace/BaseWorkspace";
import {
  DEFAULT_WORKSPACE_IMAGE_METRICS,
  ratioToImageBox,
  WorkspaceImageMetrics,
} from "../shared/workspace/roiGeometry";
import RoiLayer from "../shared/workspace/RoiLayer";
import { WorkspaceRoi } from "../shared/workspace/RoiBox";
import WorkspaceCanvas from "../shared/workspace/WorkspaceCanvas";
import {
  extractionMethodOptions,
  normalizeExtractionMethod,
} from "../shared/workspace/extractionMethods";
import { AdminTemplateRequest, TemplateRequestPage } from "../types/ocr";
import {
  ADMIN_API_BASE_URL,
  addTemplateRequestImage,
  convertTemplateRequestToTemplate,
  deleteTemplateRequest,
  deleteTemplateRequestImage,
  fetchTemplateRequest,
  fetchTemplateRequestPages,
  updateTemplateRequestImage,
} from "./adminApi";
import { samplePage } from "./adminMockData";
import { useAdminState } from "./AdminState";

const toWorkspaceRoi = (
  field: AdminTemplateRequest["requestedFields"][number],
  index: number,
  imageMetrics: WorkspaceImageMetrics
): WorkspaceRoi & { kind: string; pageNumber: number } => {
  const box = ratioToImageBox(field.roi, imageMetrics);
  const method = normalizeExtractionMethod(field.extractionMethod);

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
    type:
      method === "ocr_table"
        ? "table"
        : method === "extract_image"
          ? "image"
          : "text",
  };
};

const extractionMethodLabel = (value?: string) =>
  extractionMethodOptions.find(
    (option) => option.value === normalizeExtractionMethod(value)
  )?.label || "OCR Text inside ROI";

export default function AdminRequestDetailPage({
  requestId,
}: {
  requestId: string;
}) {
  const router = useRouter();
  const { requests, rejectRequest } = useAdminState();

  const fallbackRequest = requests.find((request) => request.id === requestId);

  const [request, setRequest] = useState<AdminTemplateRequest | null>(
    fallbackRequest || null
  );
  const [pages, setPages] = useState<TemplateRequestPage[]>(
    fallbackRequest?.pages || []
  );
  const [currentPage, setCurrentPage] = useState(0);
  const [imageMetrics, setImageMetrics] = useState<WorkspaceImageMetrics>(
    DEFAULT_WORKSPACE_IMAGE_METRICS
  );
  const [adminNote, setAdminNote] = useState("");
  const [loadStatus, setLoadStatus] = useState<
    "loading" | "loaded" | "fallback" | "error"
  >("loading");
  const [actionStatus, setActionStatus] = useState("");
  const [actionError, setActionError] = useState("");
  const [isConverting, setIsConverting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUpdatingImages, setIsUpdatingImages] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);

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

        setRequest({
          ...requestDetail,
          pages: requestPages.length > 0 ? requestPages : requestDetail.pages,
        });
        setPages(requestPages.length > 0 ? requestPages : requestDetail.pages);
        setLoadStatus("loaded");
      } catch (error) {
        console.warn(
          "Using admin request fallback because backend detail is unavailable.",
          error
        );

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
    return (request?.requestedFields || []).map((field, index) =>
      toWorkspaceRoi(field, index, imageMetrics)
    );
  }, [imageMetrics, request?.requestedFields]);

  const fieldsByPage = useMemo(() => {
    return (request?.requestedFields || []).reduce<
      Record<number, AdminTemplateRequest["requestedFields"]>
    >((acc, field) => {
      acc[field.roi.pageNumber] = [
        ...(acc[field.roi.pageNumber] || []),
        field,
      ];
      return acc;
    }, {});
  }, [request?.requestedFields]);

  const reloadImages = async () => {
    const requestPages = await fetchTemplateRequestPages(requestId);
    setPages(requestPages);
    setRequest((current) =>
      current
        ? {
            ...current,
            pages: requestPages,
            pageCount: requestPages.length,
          }
        : current
    );
  };

  const fileToDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const handleAddImages = async (files: FileList | null) => {
    if (!request || !files || files.length === 0) return;
    setActionError("");
    setActionStatus("");
    setIsUpdatingImages(true);
    try {
      const dataUrls = await Promise.all(Array.from(files).filter((file) => file.type.startsWith("image/")).map(fileToDataUrl));
      for (const src of dataUrls.filter(Boolean)) {
        await addTemplateRequestImage(request.id, src, "admin_upload");
      }
      await reloadImages();
      setActionStatus("Reference image added.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Add image failed.");
    } finally {
      setIsUpdatingImages(false);
    }
  };

  const handleReplaceImage = async (imageId: string, files: FileList | null) => {
    if (!request || !files?.[0]) return;
    setActionError("");
    setActionStatus("");
    setIsUpdatingImages(true);
    try {
      const src = await fileToDataUrl(files[0]);
      await updateTemplateRequestImage(request.id, imageId, {
        sampleImageUrl: src,
        imageSource: "admin_upload",
        reviewStatus: "pending",
        isCanonical: false,
      });
      await reloadImages();
      setActionStatus("Reference image replaced and marked pending.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Replace image failed.");
    } finally {
      setIsUpdatingImages(false);
    }
  };

  const handleUpdateImage = async (
    imageId: string,
    patch: {
      reviewStatus?: "pending" | "approved" | "rejected";
      isCanonical?: boolean;
    }
  ) => {
    if (!request) return;
    setActionError("");
    setActionStatus("");
    setIsUpdatingImages(true);
    try {
      await updateTemplateRequestImage(request.id, imageId, patch);
      await reloadImages();
      setActionStatus("Reference image updated.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Update image failed.");
    } finally {
      setIsUpdatingImages(false);
    }
  };

  const handleRemoveImage = async (imageId: string) => {
    if (!request) return;
    setActionError("");
    setActionStatus("");
    setIsUpdatingImages(true);
    try {
      await deleteTemplateRequestImage(request.id, imageId);
      await reloadImages();
      setActionStatus("Reference image removed.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Remove image failed.");
    } finally {
      setIsUpdatingImages(false);
    }
  };

  const handleReject = async () => {
    if (!request) return;

    setActionError("");
    setActionStatus("");

    try {
      const response = await fetch(
        `${ADMIN_API_BASE_URL}/admin/template-requests/${request.id}/reject`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: adminNote || null }),
        }
      );

      if (!response.ok) {
        throw new Error(`Reject failed with ${response.status}`);
      }

      rejectRequest(request.id, adminNote);
      setRequest({ ...request, status: "rejected", adminNote });
      setActionStatus("Request rejected.");
    } catch (error) {
      console.warn(
        "TODO: backend reject unavailable, using temporary local reject.",
        error
      );

      rejectRequest(request.id, adminNote);
      setRequest({ ...request, status: "rejected", adminNote });
      setActionStatus(
        "Request rejected locally. TODO: persist reject when backend is available."
      );
    }
  };

  const handleConvert = async () => {
    if (!request) return;

    setActionError("");
    setActionStatus("");

    if (loadStatus !== "loaded") {
      setActionError(
        "Cannot convert a demo/fallback request. Reload backend data and try again."
      );
      return;
    }

    const pendingPages = pages.filter((page) => (page.reviewStatus || "pending") === "pending");
    const approvedPages = pages.filter((page) => page.reviewStatus === "approved");
    if (pendingPages.length > 0) {
      setActionError("กรุณาตรวจสอบทุกหน้าก่อนสร้าง Template");
      return;
    }
    if (approvedPages.length === 0) {
      setActionError("ต้องอนุมัติอย่างน้อย 1 หน้า ก่อนสร้าง Template");
      return;
    }

    setIsConverting(true);

    try {
      const result = await convertTemplateRequestToTemplate(request.id);

      setRequest({
        ...request,
        status: "converted",
        convertedTemplateId: result.templateId,
        adminNote,
      });

      setActionStatus("Request converted to a persisted template draft.");
      router.push(`/admin/templates/${result.templateId}/edit`);
    } catch (error) {
      console.warn("Template request conversion failed.", error);
      setActionError(
        "Convert failed. No local template was created. Please check backend/database and try again."
      );
    } finally {
      setIsConverting(false);
    }
  };

  const handleDelete = async () => {
    if (!request) return;

    setActionError("");
    setActionStatus("");

    if (loadStatus !== "loaded") {
      setActionError(
        "Cannot delete a demo/fallback request. Reload backend data and try again."
      );
      setIsDeleteConfirmOpen(false);
      return;
    }

    setIsDeleting(true);

    try {
      await deleteTemplateRequest(request.id);

      setActionStatus("Template request deleted.");
      setIsDeleteConfirmOpen(false);
      setTimeout(() => router.push("/admin/requests"), 300);
    } catch (error) {
      console.warn("Template request delete failed.", error);
      setActionError(
        error instanceof Error ? error.message : "Delete failed. Please try again."
      );
    } finally {
      setIsDeleting(false);
    }
  };

  if (loadStatus === "loading") {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500 shadow-sm">
        Loading request...
      </section>
    );
  }

  if (!request) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-black text-slate-900">
          Request not found
        </h2>

        <Link
          href="/admin/requests"
          className="mt-4 inline-flex rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white"
        >
          Back to Requests
        </Link>
      </section>
    );
  }

  const safeCurrentPage = Math.min(
    currentPage,
    Math.max(workspacePages.length - 1, 0)
  );
  const currentPageFields = fieldsByPage[safeCurrentPage + 1] || [];
  const approvedPageCount = pages.filter((page) => page.reviewStatus === "approved").length;
  const pendingPageCount = pages.filter((page) => (page.reviewStatus || "pending") === "pending").length;
  const canConvert = loadStatus === "loaded" && pages.length > 0 && pendingPageCount === 0 && approvedPageCount > 0;

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-xl font-black text-slate-900">
              {request.requestTitle}
            </h2>

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
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">
                {request.pageCount} pages
              </span>
            </div>

            {loadStatus === "fallback" && (
              <p className="mt-2 text-xs font-bold text-amber-600">
                Showing mock fallback because backend detail is unavailable.
              </p>
            )}
          </div>

          <Link
            href="/admin/requests"
            className="inline-flex h-10 w-fit items-center rounded-xl border border-slate-200 bg-white px-4 text-xs font-black text-slate-700 hover:bg-slate-50"
          >
            Back to Requests
          </Link>
        </div>
      </div>

      <div className="grid w-full gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0">
          <BaseWorkspace
            pages={
              workspacePages.length > 0
                ? workspacePages
                : [{ id: "empty", src: samplePage, label: "Page 1" }]
            }
            currentPage={safeCurrentPage}
            onPageChange={setCurrentPage}
            title="Request Preview"
          >
            <WorkspaceCanvas
              imageSrc={workspacePages[safeCurrentPage]?.src || samplePage}
              className="h-[620px] w-full"
              onImageMetricsChange={setImageMetrics}
            >
              {request.requestMode === "image_with_roi" && (
                <RoiLayer
                  rois={rois}
                  currentPage={safeCurrentPage}
                  readonly
                  showLabels
                />
              )}
            </WorkspaceCanvas>
          </BaseWorkspace>
        </div>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">
                  Document Pages
                </h3>
                <p className="mt-1 text-[11px] font-semibold text-slate-400">
                  Review each page. Approved pages become one multi-page Template.
                </p>
              </div>

              <label className="cursor-pointer rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-[10px] font-black text-indigo-700 hover:bg-indigo-100">
                Add
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  disabled={isUpdatingImages}
                  onChange={(event) => {
                    void handleAddImages(event.target.files);
                    event.target.value = "";
                  }}
                />
              </label>
            </div>

            <div className="space-y-3">
              {pages.length === 0 ? (
                <p className="rounded-xl bg-slate-50 p-3 text-xs font-semibold text-slate-500">
                  No reference images were uploaded.
                </p>
              ) : (
                pages.map((page) => (
                  <div key={page.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => setCurrentPage(Math.max(page.pageNumber - 1, 0))}
                        className="h-20 w-24 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white"
                      >
                        <img
                          src={page.sampleImageUrl || samplePage}
                          alt={`Reference ${page.pageNumber}`}
                          className="h-full w-full object-contain"
                        />
                      </button>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap gap-1">
                          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-black text-slate-600">
                            Image {page.pageNumber}
                          </span>
                          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-black text-slate-600">
                            {page.imageSource || "user_request"}
                          </span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-black ${
                              page.reviewStatus === "approved"
                                ? "bg-emerald-50 text-emerald-700"
                                : page.reviewStatus === "rejected"
                                  ? "bg-red-50 text-red-700"
                                  : "bg-amber-50 text-amber-700"
                            }`}
                          >
                            {page.reviewStatus || "pending"}
                          </span>
                          {page.isCanonical && (
                            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-black text-indigo-700">
                              primary
                            </span>
                          )}
                        </div>

                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            disabled={isUpdatingImages}
                            onClick={() => void handleUpdateImage(page.id, { reviewStatus: "approved" })}
                            className="rounded-lg border border-emerald-200 bg-white px-2 py-1 text-[10px] font-black text-emerald-700 disabled:text-slate-300"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={isUpdatingImages || page.reviewStatus === "rejected"}
                            onClick={() => void handleUpdateImage(page.id, { reviewStatus: "approved", isCanonical: true })}
                            className="rounded-lg border border-indigo-200 bg-white px-2 py-1 text-[10px] font-black text-indigo-700 disabled:text-slate-300"
                          >
                            Primary
                          </button>
                          <button
                            type="button"
                            disabled={isUpdatingImages}
                            onClick={() => void handleUpdateImage(page.id, { reviewStatus: "rejected", isCanonical: false })}
                            className="rounded-lg border border-red-200 bg-white px-2 py-1 text-[10px] font-black text-red-700 disabled:text-slate-300"
                          >
                            Reject
                          </button>
                          <label className="cursor-pointer rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] font-black text-slate-600">
                            Replace
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              disabled={isUpdatingImages}
                              onChange={(event) => {
                                void handleReplaceImage(page.id, event.target.files);
                                event.target.value = "";
                              }}
                            />
                          </label>
                          <button
                            type="button"
                            disabled={isUpdatingImages}
                            onClick={() => void handleRemoveImage(page.id)}
                            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] font-black text-red-600 disabled:text-slate-300"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {!canConvert && (
              <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
                ตรวจสอบทุกหน้าให้เรียบร้อยก่อนสร้าง Template หน้าที่อนุมัติจะถูกใช้เป็น Template เดียวหลายหน้า
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex h-10 items-center justify-between">
              <div>
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">
                  Requested ROI Fields
                </h3>
                <p className="mt-1 text-[11px] font-semibold text-slate-400">
                  Page {safeCurrentPage + 1} of {workspacePages.length || 1}
                </p>
              </div>

              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black text-slate-500">
                {currentPageFields.length} fields
              </span>
            </div>

            <div className="max-h-[430px] space-y-3 overflow-y-auto pr-1">
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
                  <div
                    key={field.id}
                    className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs font-semibold text-slate-700"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-black text-slate-900">
                          {field.displayLabel}
                        </div>
                        <div className="mt-1 text-slate-500">
                          {field.fieldName}
                        </div>
                      </div>

                      <span className="rounded bg-white px-2 py-0.5 text-[10px] font-black uppercase text-slate-500">
                        {field.dataType || "text"}
                      </span>
                    </div>

                    <div className="mt-2 inline-flex rounded bg-indigo-50 px-2 py-0.5 text-[10px] font-black text-indigo-700">
                      {extractionMethodLabel(field.extractionMethod)}
                    </div>

                    <div className="mt-3 grid grid-cols-4 gap-2 border-t border-slate-200 pt-2 text-[10px] font-bold text-slate-500">
                      <span>x: {field.roi.xRatio.toFixed(3)}</span>
                      <span>y: {field.roi.yRatio.toFixed(3)}</span>
                      <span>w: {field.roi.widthRatio.toFixed(3)}</span>
                      <span>h: {field.roi.heightRatio.toFixed(3)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="sticky top-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex h-10 items-center justify-between">
              <div>
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">
                  Review Decision
                </h3>
                <p className="mt-1 text-[11px] font-semibold text-slate-400">
                  Admin action area
                </p>
              </div>
            </div>

            <label className="block space-y-1">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                Admin note
              </span>

              <textarea
                value={adminNote}
                onChange={(event) => setAdminNote(event.target.value)}
                rows={4}
                placeholder="Reason, review note, or conversion context"
                className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-800 outline-none focus:border-indigo-500 focus:bg-white"
              />
            </label>

            {actionStatus && (
              <p className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">
                {actionStatus}
              </p>
            )}

            {actionError && (
              <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-700">
                {actionError}
              </p>
            )}

            <div className="mt-4 grid gap-2">
              <button
                type="button"
                onClick={handleConvert}
                disabled={isConverting || !canConvert}
                className="ui-stable-action-lg rounded-xl bg-indigo-600 px-3 py-2.5 text-xs font-black text-white hover:bg-indigo-700 disabled:bg-slate-300 disabled:text-slate-500"
              >
                {isConverting ? "Converting..." : "Convert Approved Pages to Template Draft"}
              </button>

              <button
                type="button"
                onClick={handleReject}
                className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs font-black text-red-700 hover:bg-red-100"
              >
                Reject
              </button>

              <button
                type="button"
                onClick={() => setIsDeleteConfirmOpen(true)}
                disabled={isDeleting || loadStatus !== "loaded"}
                className="ui-stable-action rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-black text-red-700 hover:bg-red-50 disabled:border-slate-200 disabled:text-slate-400"
              >
                {isDeleting ? "Deleting..." : "Delete Request"}
              </button>
            </div>
          </section>
        </aside>
      </div>

      {isDeleteConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h3 className="text-base font-black text-slate-900">
              Delete this template request?
            </h3>

            <p className="mt-2 text-sm font-semibold text-slate-500">
              This action cannot be undone.
            </p>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsDeleteConfirmOpen(false)}
                disabled={isDeleting}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handleDelete}
                disabled={isDeleting}
                className="ui-stable-action-sm rounded-xl bg-red-600 px-4 py-2 text-xs font-black text-white hover:bg-red-700 disabled:bg-slate-300 disabled:text-slate-500"
              >
                {isDeleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
