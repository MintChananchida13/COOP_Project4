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

interface PdfJsLib {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (options: { data: ArrayBuffer }) => {
    promise: Promise<{
      numPages: number;
      getPage: (pageNumber: number) => Promise<{
        getViewport: (options: { scale: number }) => { width: number; height: number };
        render: (options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => {
          promise: Promise<void>;
        };
      }>;
    }>;
  };
}

declare global {
  interface Window {
    pdfjsLib?: PdfJsLib;
  }
}

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
  page.sourceFileName || (page.imageSource === "admin_upload" ? `รูปที่ผู้ดูแลเพิ่ม ${page.pageNumber}` : "ไฟล์ต้นทางเดียวกัน");

const reviewStatusLabel = (status?: TemplateRequestPage["reviewStatus"]) => {
  if (status === "approved") return "อนุมัติแล้ว";
  if (status === "rejected") return "ไม่ใช้";
  return "รอตรวจ";
};

const isPdfFile = (file: File) =>
  file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

const loadPdfEngine = (): Promise<PdfJsLib> =>
  new Promise((resolve, reject) => {
    if (window.pdfjsLib) {
      resolve(window.pdfjsLib);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => {
      const pdfjs = window.pdfjsLib;
      if (!pdfjs) {
        reject(new Error("ไม่สามารถโหลด PDF.js ได้"));
        return;
      }
      pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      resolve(pdfjs);
    };
    script.onerror = () => reject(new Error("โหลด PDF.js ไม่สำเร็จ"));
    document.head.appendChild(script);
  });

const convertPdfToImages = async (file: File): Promise<string[]> => {
  const pdfjsLib = await loadPdfEngine();
  const loadingTask = pdfjsLib.getDocument({ data: await file.arrayBuffer() });
  const pdf = await loadingTask.promise;
  const imageUrls: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport }).promise;
    imageUrls.push(canvas.toDataURL("image/jpeg", 0.95));
  }

  return imageUrls;
};

export default function AdminRequestDetailPage({
  requestId,
}: {
  requestId: string;
}) {
  const router = useRouter();
  const { requests } = useAdminState();

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
      label: `หน้า ${page.pageNumber}`,
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

  const documentGroups = useMemo(() => {
    const groups = new Map<string, { sourceFileId: string; sourceFileName: string; pages: TemplateRequestPage[] }>();
    pages.forEach((page) => {
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
  }, [pages]);

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

  const handleAddFiles = async (files: FileList | null) => {
    if (!request || !files || files.length === 0) return;
    setActionError("");
    setActionStatus("");
    setIsUpdatingImages(true);
    try {
      const acceptedFiles = Array.from(files).filter((file) => file.type.startsWith("image/") || isPdfFile(file));
      let addedPageCount = 0;

      for (const [fileIndex, file] of acceptedFiles.entries()) {
        const sourceFileId = `admin_file_${Date.now()}_${fileIndex}`;
        const sourceFileName = file.name || `ไฟล์ที่ผู้ดูแลเพิ่ม ${fileIndex + 1}`;
        const pageImages = isPdfFile(file) ? await convertPdfToImages(file) : [await fileToDataUrl(file)];

        for (const src of pageImages.filter(Boolean)) {
          await addTemplateRequestImage(request.id, src, "admin_upload", sourceFileId, sourceFileName);
          addedPageCount += 1;
        }
      }

      await reloadImages();
      setActionStatus(`เพิ่มไฟล์เรียบร้อยแล้ว (${acceptedFiles.length} ไฟล์, ${addedPageCount} หน้า)`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "เพิ่มไฟล์ไม่สำเร็จ");
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
      setActionStatus("อัปเดตรูปอ้างอิงเรียบร้อยแล้ว");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "อัปเดตรูปไม่สำเร็จ");
    } finally {
      setIsUpdatingImages(false);
    }
  };

  const handleUpdateGroup = async (
    groupPages: TemplateRequestPage[],
    patch: { reviewStatus: "approved" | "rejected" | "pending"; isCanonical?: boolean }
  ) => {
    if (!request || groupPages.length === 0) return;
    setActionError("");
    setActionStatus("");
    setIsUpdatingImages(true);
    try {
      for (const [index, page] of groupPages.entries()) {
        await updateTemplateRequestImage(request.id, page.id, {
          reviewStatus: patch.reviewStatus,
          isCanonical: patch.reviewStatus === "rejected" ? false : patch.isCanonical && index === 0,
        });
      }
      await reloadImages();
      setActionStatus("อัปเดตกลุ่มเอกสารเรียบร้อยแล้ว");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "อัปเดตกลุ่มเอกสารไม่สำเร็จ");
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
      setActionStatus("ลบรูปอ้างอิงเรียบร้อยแล้ว");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "ลบรูปไม่สำเร็จ");
    } finally {
      setIsUpdatingImages(false);
    }
  };

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

    const pendingPages = pages.filter((page) => (page.reviewStatus || "pending") === "pending");
    const approvedPages = pages.filter((page) => page.reviewStatus === "approved");
    if (pendingPages.length > 0) {
      setActionError("กรุณาตรวจทุกหน้าให้เรียบร้อยก่อนสร้าง Template");
      return;
    }
    if (approvedPages.length === 0) {
      setActionError("ต้องอนุมัติอย่างน้อย 1 ไฟล์ก่อนสร้าง Template");
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
                {request.documentType || "ไม่ระบุประเภท"}
              </span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">
                {request.pageCount} หน้า
              </span>
            </div>

            {loadStatus === "fallback" && (
              <p className="mt-2 text-xs font-bold text-amber-600">
                กำลังแสดงข้อมูลตัวอย่าง เพราะยังเชื่อมต่อ backend ไม่ได้
              </p>
            )}
          </div>

          <Link
            href="/admin/requests"
            className="inline-flex h-10 w-fit items-center rounded-xl border border-slate-200 bg-white px-4 text-xs font-black text-slate-700 hover:bg-slate-50"
          >
            กลับไปรายการคำขอ
          </Link>
        </div>
      </div>

      <div className="grid w-full gap-5 xl:grid-cols-[minmax(0,1fr)_460px]">
        <div className="min-w-0">
          <BaseWorkspace
            pages={
              workspacePages.length > 0
                ? workspacePages
                : [{ id: "empty", src: samplePage, label: "หน้า 1" }]
            }
            currentPage={safeCurrentPage}
            onPageChange={setCurrentPage}
            title="ตัวอย่างคำขอ"
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
                  กลุ่มเอกสาร
                </h3>
                <p className="mt-1 text-[11px] font-semibold text-slate-400">
                  หน้าที่มี sourceFileId เดียวกันจะแสดงอยู่ในกล่องเดียวกัน
                </p>
              </div>

              <label className="cursor-pointer rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-[10px] font-black text-indigo-700 hover:bg-indigo-100">
                เพิ่มไฟล์
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  className="hidden"
                  disabled={isUpdatingImages}
                  onChange={(event) => {
                    void handleAddFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
              </label>
            </div>

            <div className="space-y-3">
              {pages.length > 0 && documentGroups.map((group) => {
                const approvedCount = group.pages.filter((page) => page.reviewStatus === "approved").length;
                const rejectedCount = group.pages.filter((page) => page.reviewStatus === "rejected").length;
                const pendingCount = group.pages.filter((page) => (page.reviewStatus || "pending") === "pending").length;
                const isGroupApproved = approvedCount === group.pages.length && group.pages.length > 0;
                const mainPage = group.pages.find((page) => page.isCanonical) || group.pages[0];
                return (
                  <div key={group.sourceFileId} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex flex-col gap-3 border-b border-slate-200 pb-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <h4 className="truncate text-xs font-black text-slate-900">{group.sourceFileName}</h4>
                        <p className="mt-1 text-[11px] font-bold text-slate-500">
                          {group.pages.length} หน้า · {isGroupApproved ? "อนุมัติทั้งไฟล์แล้ว" : `รอตรวจ ${pendingCount} หน้า`} · ไม่ใช้ {rejectedCount}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-1.5">
                        <button
                          type="button"
                          disabled={isUpdatingImages || !mainPage || mainPage.isCanonical}
                          onClick={() => mainPage && void handleUpdateImage(mainPage.id, { isCanonical: true })}
                          className="rounded-lg border border-indigo-200 bg-white px-2 py-1 text-[10px] font-black text-indigo-700 disabled:text-slate-300"
                        >
                          {mainPage?.isCanonical ? "เป็นหน้าหลักแล้ว" : "ตั้งเป็นหน้าหลัก"}
                        </button>
                        <button
                          type="button"
                          disabled={isUpdatingImages || isGroupApproved}
                          onClick={() => void handleUpdateGroup(group.pages, { reviewStatus: "approved" })}
                          className="rounded-lg border border-emerald-200 bg-white px-2 py-1 text-[10px] font-black text-emerald-700 disabled:text-slate-300"
                        >
                          {isGroupApproved ? "อนุมัติแล้ว" : "อนุมัติทั้งไฟล์"}
                        </button>
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
                                src={page.sampleImageUrl || samplePage}
                                alt={`หน้าเอกสาร ${page.pageNumber}`}
                                className="h-full w-full object-contain"
                              />
                            </button>

                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap gap-1">
                                <span className="rounded-full bg-slate-50 px-2 py-0.5 text-[10px] font-black text-slate-600">
                                  หน้า {page.pageNumber}
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
                                  {reviewStatusLabel(page.reviewStatus)}
                                </span>
                                {page.isCanonical && (
                                  <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-black text-indigo-700">
                                    หน้าหลัก
                                  </span>
                                )}
                              </div>

                              <div className="mt-2 flex flex-wrap gap-1.5">
                                <button type="button" disabled={isUpdatingImages} onClick={() => void handleRemoveImage(page.id)} className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] font-black text-red-600 disabled:text-slate-300">
                                  ลบ
                                </button>
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
              <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">กรุณาอนุมัติเป็นรายไฟล์ก่อนสร้าง Template โดยทุกหน้าภายในไฟล์ที่อนุมัติจะถูกนำไปสร้างเป็น Template เดียวกัน</p>
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

          <section className="sticky top-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex h-10 items-center justify-between">
              <div>
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">
                  การดำเนินการ
                </h3>
                <p className="mt-1 text-[11px] font-semibold text-slate-400">
                  ตรวจให้ครบก่อนสร้าง Template
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
                {isConverting ? "กำลังสร้าง Template..." : "สร้าง Template จากไฟล์ที่อนุมัติ"}
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
