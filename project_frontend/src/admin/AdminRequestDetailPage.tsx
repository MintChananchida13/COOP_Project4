"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { WorkspacePage } from "../shared/workspace/BaseWorkspace";
import PageNavigator from "../shared/workspace/PageNavigator";
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
  convertTemplateRequestToTemplate,
  deleteTemplateRequest,
  fetchTemplateRequest,
  fetchTemplateRequestPages,
  updateTemplateRequest,
  updateTemplateRequestImage,
} from "./adminApi";

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
  )?.label || "อ่านข้อความใน ROI";

const getPageSourceFileId = (page: TemplateRequestPage) =>
  page.sourceFileId ||
  (page.imageSource === "admin_upload"
    ? `${page.templateRequestId || "request"}_admin_upload_${page.id}`
    : `${page.templateRequestId || "request"}_source_file`);

const getPageSourceFileName = (page: TemplateRequestPage) =>
  page.sourceFileName || "ไฟล์ต้นทาง";

export default function AdminRequestDetailPage({
  requestId,
}: {
  requestId: string;
}) {
  const router = useRouter();
  const [request, setRequest] = useState<AdminTemplateRequest | null>(null);
  const [pages, setPages] = useState<TemplateRequestPage[]>([]);
  const [currentPage, setCurrentPage] = useState(0);
  const [imageMetrics, setImageMetrics] = useState<WorkspaceImageMetrics>(
    DEFAULT_WORKSPACE_IMAGE_METRICS
  );
  const [templateName, setTemplateName] = useState("");
  const [adminNote, setAdminNote] = useState("");
  const [loadStatus, setLoadStatus] = useState<
    "loading" | "loaded" | "error"
  >("loading");
  const [actionStatus, setActionStatus] = useState("");
  const [actionError, setActionError] = useState("");
  const [isConverting, setIsConverting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const previewPanelRef = useRef<HTMLDivElement | null>(null);
  const [previewCanvasWidth, setPreviewCanvasWidth] = useState(750);

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
        setTemplateName(requestDetail.requestTitle || "");
        setAdminNote(requestDetail.adminNote || "");
        setLoadStatus("loaded");
      } catch (error) {
        console.warn("Admin request detail load failed.", error);

        if (!cancelled) {
          setRequest(null);
          setPages([]);
          setLoadStatus("error");
        }
      }
    };

    loadRequest();

    return () => {
      cancelled = true;
    };
  }, [requestId]);

  useEffect(() => {
    const panel = previewPanelRef.current;
    if (!panel) return;

    const updatePreviewWidth = () => {
      const panelWidth = panel.clientWidth || panel.getBoundingClientRect().width;
      setPreviewCanvasWidth(Math.max(280, Math.floor(panelWidth - 6)));
    };

    updatePreviewWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updatePreviewWidth);
      return () => window.removeEventListener("resize", updatePreviewWidth);
    }

    const observer = new ResizeObserver(updatePreviewWidth);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [loadStatus]);

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

  const documentGroups = useMemo(() => {
    const groups = new Map<string, { sourceFileId: string; sourceFileName: string; pages: TemplateRequestPage[] }>();
    const sourcePages = pages.length > 0 ? pages : request?.pages || [];
    sourcePages.forEach((page) => {
      const sourceFileId = getPageSourceFileId(page);
      const group = groups.get(sourceFileId) || {
        sourceFileId,
        sourceFileName: getPageSourceFileName(page),
        pages: [],
      };
      group.pages.push(page);
      groups.set(sourceFileId, group);
    });
    return Array.from(groups.values()).map(group => ({
      ...group,
      pages: group.pages.sort((a, b) => a.pageNumber - b.pageNumber),
    }));
  }, [pages, request?.pages]);

  const primaryDocumentGroup = documentGroups[0];

  const workspacePages: WorkspacePage[] = useMemo(() => {
    const sourcePages = primaryDocumentGroup?.pages || [];

    return sourcePages.filter((page) => page.sampleImageUrl).map((page) => ({
      id: page.id,
      src: page.sampleImageUrl || "",
      label: `หน้า ${page.pageNumber}`,
    }));
  }, [primaryDocumentGroup]);

  const handleConvert = async () => {
    if (!request) return;

    setActionError("");
    setActionStatus("");

    if (loadStatus !== "loaded") {
      setActionError(
        "ไม่สามารถสร้าง Template จากข้อมูลตัวอย่างได้ กรุณาโหลดข้อมูลจาก backend อีกครั้ง"
      );
      return;
    }

    const primaryPages = primaryDocumentGroup?.pages || [];
    if (primaryPages.length === 0) {
      setActionError("ต้องมีไฟล์ต้นทางก่อนสร้าง Template");
      return;
    }

    const nextTemplateName = templateName.trim();
    if (!nextTemplateName) {
      setActionError("กรุณาระบุชื่อ Template ก่อนสร้าง Template");
      return;
    }

    setIsConverting(true);

    try {
      const updatedRequest = await updateTemplateRequest(request.id, {
        requestTitle: nextTemplateName,
        adminNote,
      });
      const primaryPageIds = new Set(primaryPages.map((page) => page.id));
      const pendingPages = pages.filter((page) => page.reviewStatus !== "approved" || !primaryPageIds.has(page.id));
      await Promise.all(
        pendingPages.map((page) =>
          updateTemplateRequestImage(request.id, page.id, {
            reviewStatus: primaryPageIds.has(page.id) ? "approved" : "rejected",
            isCanonical: primaryPageIds.has(page.id) && page.pageNumber === 1,
          })
        )
      );
      const result = await convertTemplateRequestToTemplate(request.id);

      setRequest({
        ...updatedRequest,
        status: "converted",
        convertedTemplateId: result.templateId,
        adminNote,
        pages,
      });

      setActionStatus("สร้าง Template ฉบับร่างเรียบร้อยแล้ว");
      router.push(`/admin/templates/${result.templateId}/edit`);
    } catch (error) {
      console.warn("Template request conversion failed.", error);
      setActionError(
        "สร้าง Template ไม่สำเร็จ กรุณาตรวจสอบ backend หรือฐานข้อมูลแล้วลองอีกครั้ง"
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
        "ไม่สามารถลบข้อมูลตัวอย่างได้ กรุณาโหลดข้อมูลจาก backend อีกครั้ง"
      );
      setIsDeleteConfirmOpen(false);
      return;
    }

    setIsDeleting(true);

    try {
      await deleteTemplateRequest(request.id);

      setActionStatus("ลบคำขอเรียบร้อยแล้ว");
      setIsDeleteConfirmOpen(false);
      setTimeout(() => router.push("/admin/requests"), 300);
    } catch (error) {
      console.warn("Template request delete failed.", error);
      setActionError(
        error instanceof Error ? error.message : "ลบคำขอไม่สำเร็จ กรุณาลองอีกครั้ง"
      );
    } finally {
      setIsDeleting(false);
    }
  };

  if (loadStatus === "loading") {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500 shadow-sm">
        กำลังโหลดคำขอ...
      </section>
    );
  }

  if (!request) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-black text-slate-900">
          ไม่พบคำขอ
        </h2>

        <Link
          href="/admin/requests"
          className="mt-4 inline-flex rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white"
        >
          กลับไปรายการคำขอ
        </Link>
      </section>
    );
  }

  const safeCurrentPage = Math.min(
    currentPage,
    Math.max(workspacePages.length - 1, 0)
  );
  const currentPageFields = fieldsByPage[safeCurrentPage + 1] || [];
  const canConvert = loadStatus === "loaded" && Boolean(primaryDocumentGroup?.pages.length);

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-xl font-black text-slate-900">
              {templateName.trim() || request.requestTitle}
            </h2>

            <div className="mt-2 flex flex-wrap gap-2">
              <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-[10px] font-black uppercase text-indigo-600">
                {request.requestMode}
              </span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">
                {request.status}
              </span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">
                {request.documentType || "ไม่ระบุประเภท"}
              </span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">
                {request.pageCount} หน้า
              </span>
            </div>

          </div>

          <Link
            href="/admin/requests"
            className="inline-flex h-10 w-fit items-center rounded-xl border border-slate-200 bg-white px-4 text-xs font-black text-slate-700 hover:bg-slate-50"
          >
            กลับไปรายการคำขอ
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 rounded-2xl border border-slate-200 bg-[#f8fafc] p-4 md:p-5 xl:grid-cols-12 xl:items-stretch">
        <div className="flex min-h-[640px] min-w-0 flex-col overflow-hidden xl:col-span-8 xl:h-[calc(100vh-180px)] xl:min-h-[720px]">
          {workspacePages.length > 0 ? (
            <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="mb-2 flex shrink-0 flex-col gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-sm font-black text-slate-800">ตัวอย่างคำขอ</h2>
                  <p className="text-[11px] font-semibold text-slate-400">
                    Page {Math.min(safeCurrentPage + 1, Math.max(workspacePages.length, 1))} of {Math.max(workspacePages.length, 1)}
                  </p>
                </div>
                <PageNavigator pages={workspacePages} currentPage={safeCurrentPage} onPageChange={setCurrentPage} />
              </div>

              <div ref={previewPanelRef} className="min-h-0 min-w-0 flex-1 overflow-hidden">
                <WorkspaceCanvas
                  imageSrc={workspacePages[safeCurrentPage]?.src || ""}
                  width={previewCanvasWidth}
                  className="h-full w-full overflow-x-hidden overflow-y-auto p-0 [&>div]:mx-auto [&_img]:box-border"
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
              </div>
            </section>
          ) : (
            <section className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center shadow-sm">
              <h3 className="text-base font-black text-slate-900">ยังไม่มีไฟล์ในคำขอนี้</h3>
              <p className="mt-2 max-w-md text-sm font-semibold text-slate-500">
                ยังไม่มีภาพจากไฟล์ต้นทางสำหรับสร้าง Template
              </p>
            </section>
          )}
        </div>

        <aside className="flex flex-col xl:col-span-4 xl:h-[calc(100vh-180px)] xl:min-h-[720px]">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-t-xl border border-slate-200 bg-white p-4 shadow-sm">
          <section className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-3">
            <div>
              <h3 className="text-xs font-black uppercase tracking-wider text-indigo-900">
                Template Info
              </h3>
              <p className="mt-1 text-[11px] font-semibold leading-relaxed text-indigo-700">
                ตั้งชื่อ Template ที่จะสร้างจากไฟล์ต้นทางนี้ ชื่อนี้จะถูกใช้ในคลัง Template และตอนค้นหาเอกสารของผู้ใช้
              </p>
            </div>

            <label className="mt-3 block space-y-1.5">
              <span className="text-[10px] font-black uppercase tracking-wide text-slate-500">
                ชื่อ Template
              </span>
              <input
                type="text"
                value={templateName}
                onChange={(event) => setTemplateName(event.target.value)}
                placeholder="เช่น ใบแจ้งหนี้ผู้ขาย"
                className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-900 outline-none transition-colors focus:border-indigo-500 focus:bg-white focus:ring-2 focus:ring-indigo-100"
              />
            </label>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">
                  ไฟล์ต้นทาง
                </h3>
                <p className="mt-1 text-[11px] font-semibold text-slate-400">
                  ใช้ไฟล์เดียวที่ส่งมาเป็นต้นฉบับสำหรับสร้าง Template
                </p>
              </div>
            </div>

            <div className="space-y-3">
              {primaryDocumentGroup && [primaryDocumentGroup].map((group) => {
                return (
                  <div key={group.sourceFileId} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <div className="border-b border-slate-200 pb-3">
                      <div className="min-w-0">
                        <h4 className="truncate text-xs font-black text-slate-900">{group.sourceFileName}</h4>
                        <p className="mt-1 text-[11px] font-bold text-slate-500">
                          {group.pages.length} หน้า
                        </p>
                      </div>
                    </div>

                    <div className="mt-3 space-y-2">
                      {group.pages.map((page) => (
                        <div key={page.id} className="rounded-xl border border-slate-200 bg-white p-2">
                          <div className="flex min-w-0 gap-3">
                            <button
                              type="button"
                              onClick={() => setCurrentPage(Math.max(page.pageNumber - 1, 0))}
                              className="h-20 w-24 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white"
                            >
                              <img
                                src={page.sampleImageUrl || ""}
                                alt={`หน้าเอกสาร ${page.pageNumber}`}
                                className="h-full w-full object-contain"
                              />
                            </button>

                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap gap-1">
                                <span className="rounded-full bg-slate-50 px-2 py-0.5 text-[10px] font-black text-slate-600">
                                  หน้า {page.pageNumber}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {!canConvert && (
              <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">ต้องมีไฟล์ต้นทางก่อนสร้าง Template</p>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex h-10 items-center justify-between">
              <div>
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">
                  ฟิลด์ ROI ที่ผู้ใช้ส่งมา
                </h3>
                <p className="mt-1 text-[11px] font-semibold text-slate-400">
                  หน้า {safeCurrentPage + 1} จาก {workspacePages.length || 1}
                </p>
              </div>

              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black text-slate-500">
                {currentPageFields.length} ฟิลด์
              </span>
            </div>

            <div className="max-h-[430px] space-y-3 overflow-y-auto pr-1">
              {request.requestMode === "image_only" ? (
                <p className="rounded-xl bg-slate-50 p-3 text-xs font-semibold text-slate-500">
                  คำขอนี้ส่งเฉพาะรูปภาพ จึงไม่มีฟิลด์ ROI
                </p>
              ) : currentPageFields.length === 0 ? (
                <p className="rounded-xl bg-slate-50 p-3 text-xs font-semibold text-slate-500">
                  หน้านี้ยังไม่มีฟิลด์ ROI
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
          </div>

          <section className="shrink-0 rounded-b-xl border border-t-0 border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex h-10 items-center justify-between">
              <div>
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">
                  การดำเนินการ
                </h3>
                <p className="mt-1 text-[11px] font-semibold text-slate-400">
                  ตรวจไฟล์และ ROI ก่อนสร้าง Template
                </p>
              </div>
            </div>

            <label className="block space-y-1">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                หมายเหตุผู้ดูแล
              </span>

              <textarea
                value={adminNote}
                onChange={(event) => setAdminNote(event.target.value)}
                rows={4}
                placeholder="หมายเหตุหรือข้อมูลเพิ่มเติมสำหรับการสร้าง Template"
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
                {isConverting ? "กำลังสร้าง Template..." : "สร้าง Template จากไฟล์ต้นทาง"}
              </button>

              <button
                type="button"
                onClick={() => setIsDeleteConfirmOpen(true)}
                disabled={isDeleting || loadStatus !== "loaded"}
                className="ui-stable-action rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-black text-red-700 hover:bg-red-50 disabled:border-slate-200 disabled:text-slate-400"
              >
                {isDeleting ? "กำลังลบ..." : "ลบคำขอ"}
              </button>
            </div>
          </section>
        </aside>
      </div>

      {isDeleteConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h3 className="text-base font-black text-slate-900">
              ลบคำขอนี้หรือไม่?
            </h3>

            <p className="mt-2 text-sm font-semibold text-slate-500">
              เมื่อลบแล้วจะกู้คืนไม่ได้
            </p>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsDeleteConfirmOpen(false)}
                disabled={isDeleting}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
              >
                ยกเลิก
              </button>

              <button
                type="button"
                onClick={handleDelete}
                disabled={isDeleting}
                className="ui-stable-action-sm rounded-xl bg-red-600 px-4 py-2 text-xs font-black text-white hover:bg-red-700 disabled:bg-slate-300 disabled:text-slate-500"
              >
                {isDeleting ? "กำลังลบ..." : "ลบ"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
