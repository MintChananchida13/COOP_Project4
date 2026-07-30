"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, FileImage, Loader2, Pencil, UploadCloud, X } from "lucide-react";
import { Template, TemplateStatus } from "../types/ocr";
import { addTemplateRequestImage, createTemplateRequest, deleteTemplateApi, fetchTemplates, updateTemplateApi, updateTemplateStatus } from "./adminApi";
import { AdminStatusFilter } from "./adminTypes";
import { ActionButton, EmptyState, InlineState, LoadingState, PageHeader, StatusBadge, cardClassName } from "../shared/ui";

const statusFilterOptions: { value: AdminStatusFilter; label: string }[] = [
  { value: "all", label: "ทั้งหมด" },
  { value: "draft", label: "ฉบับร่าง" },
  { value: "active", label: "ใช้งานอยู่" },
  { value: "nonactive", label: "ไม่ใช้งาน" },
];

const manageableStatuses: TemplateStatus[] = ["active", "nonactive", "disabled"];

interface PdfJsLib {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (options: { data: ArrayBuffer }) => {
    promise: Promise<{
      numPages: number;
      getPage: (pageNumber: number) => Promise<{
        getViewport: (options: { scale: number }) => { width: number; height: number };
        render: (options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> };
      }>;
    }>;
  };
}

declare global {
  interface Window {
    pdfjsLib?: PdfJsLib;
  }
}

const isPdfFile = (file: File) =>
  file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

const fileToDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("อ่านไฟล์ไม่สำเร็จ"));
    reader.readAsDataURL(file);
  });

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
        reject(new Error("โหลดตัวอ่าน PDF ไม่สำเร็จ"));
        return;
      }
      pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      resolve(pdfjs);
    };
    script.onerror = () => reject(new Error("โหลดตัวอ่าน PDF ไม่สำเร็จ"));
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
    if (!ctx) throw new Error("ไม่สามารถเตรียมภาพจาก PDF ได้");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport }).promise;
    imageUrls.push(canvas.toDataURL("image/png"));
  }
  return imageUrls;
};

const statusSelectLabel = (status: TemplateStatus) => {
  if (status === "active") return "ใช้งานอยู่";
  if (status === "nonactive" || status === "disabled") return "ปิดใช้งานชั่วคราว";
  if (status === "draft") return "ฉบับร่าง";
  if (status === "embedding_pending") return "กำลังเตรียมเผยแพร่";
  if (status === "validated") return "ตรวจสอบแล้ว";
  return status.replaceAll("_", " ");
};

export default function AdminTemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedStatus, setSelectedStatus] = useState<AdminStatusFilter>("all");
  const [loadStatus, setLoadStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);
  const [statusUpdatingTemplateId, setStatusUpdatingTemplateId] = useState<string | null>(null);
  const [deleteMessage, setDeleteMessage] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [statusError, setStatusError] = useState("");
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editingTemplateName, setEditingTemplateName] = useState("");
  const [renamingTemplateId, setRenamingTemplateId] = useState<string | null>(null);
  const [renameMessage, setRenameMessage] = useState("");
  const [renameError, setRenameError] = useState("");
  const [newTemplateType, setNewTemplateType] = useState("");
  const [isCreatingRequest, setIsCreatingRequest] = useState(false);
  const [createRequestError, setCreateRequestError] = useState("");

  useEffect(() => {
    let cancelled = false;

    const loadTemplates = async () => {
      setLoadStatus("loading");
      try {
        const persistedTemplates = await fetchTemplates();
        if (cancelled) return;
        setTemplates(persistedTemplates);
        setLoadStatus("loaded");
      } catch (error) {
        console.warn("Templates load failed.", error);
        if (cancelled) return;
        setTemplates([]);
        setLoadStatus("error");
      }
    };

    loadTemplates();

    return () => {
      cancelled = true;
    };
  }, []);

  const filteredTemplates = templates.filter((template) => {
    if (selectedStatus === "all") return true;
    if (selectedStatus === "draft") return template.status === "draft";
    if (selectedStatus === "active") return template.status === "active";
    return template.status !== "draft" && template.status !== "active";
  });

  const statusCounts: Record<AdminStatusFilter, number> = {
    all: templates.length,
    draft: templates.filter((template) => template.status === "draft").length,
    active: templates.filter((template) => template.status === "active").length,
    nonactive: templates.filter((template) => template.status !== "draft" && template.status !== "active").length,
  };

  const handleChangeTemplateStatus = async (template: Template, nextStatus: TemplateStatus) => {
    if (loadStatus !== "loaded") {
      setStatusError("ไม่สามารถเปลี่ยนสถานะ Template ตัวอย่างได้ เพราะไม่ได้โหลดจากฐานข้อมูลจริง");
      return;
    }

    const actionLabel = nextStatus === "active" ? "เปิดใช้งาน" : "ปิดใช้งานชั่วคราว";
    if (!window.confirm(`${actionLabel} Template "${template.name}"?`)) return;

    setStatusUpdatingTemplateId(template.id);
    setStatusMessage("");
    setStatusError("");
    setDeleteMessage("");
    setDeleteError("");

    try {
      const bundle = await updateTemplateStatus(template.id, nextStatus);
      setTemplates((current) => current.map((item) => (item.id === template.id ? bundle.template : item)));
      setStatusMessage(`${actionLabel} Template "${template.name}" เรียบร้อยแล้ว`);
    } catch (error) {
      console.warn("Template status update failed.", error);
      setStatusError(error instanceof Error ? error.message : "เปลี่ยนสถานะ Template ไม่สำเร็จ");
    } finally {
      setStatusUpdatingTemplateId(null);
    }
  };

  const startRenameTemplate = (template: Template) => {
    setEditingTemplateId(template.id);
    setEditingTemplateName(template.name);
    setRenameMessage("");
    setRenameError("");
  };

  const cancelRenameTemplate = () => {
    setEditingTemplateId(null);
    setEditingTemplateName("");
    setRenameError("");
  };

  const handleRenameTemplate = async (template: Template) => {
    if (loadStatus !== "loaded") {
      setRenameError("ไม่สามารถเปลี่ยนชื่อ Template ได้ เพราะยังไม่ได้โหลดข้อมูลจาก Backend");
      return;
    }

    const nextName = editingTemplateName.trim();
    if (!nextName) {
      setRenameError("กรุณาระบุชื่อ Template");
      return;
    }
    if (nextName === template.name) {
      cancelRenameTemplate();
      return;
    }

    setRenamingTemplateId(template.id);
    setRenameMessage("");
    setRenameError("");
    setDeleteMessage("");
    setDeleteError("");
    setStatusMessage("");
    setStatusError("");

    try {
      const bundle = await updateTemplateApi(template.id, { name: nextName });
      setTemplates((current) => current.map((item) => (item.id === template.id ? bundle.template : item)));
      setEditingTemplateId(null);
      setEditingTemplateName("");
      setRenameMessage(`เปลี่ยนชื่อ Template เป็น "${bundle.template.name}" เรียบร้อยแล้ว`);
    } catch (error) {
      console.warn("Template rename failed.", error);
      setRenameError(error instanceof Error ? error.message : "เปลี่ยนชื่อ Template ไม่สำเร็จ");
    } finally {
      setRenamingTemplateId(null);
    }
  };

  const handleCreateTemplateRequest = async (files: FileList | null) => {
    if (!files?.length) return;
    if (loadStatus !== "loaded") {
      setCreateRequestError("ต้องเชื่อมต่อ Backend ก่อนสร้าง Template Request ใหม่");
      return;
    }

    const acceptedFiles = Array.from(files).filter((file) => file.type.startsWith("image/") || isPdfFile(file));
    if (acceptedFiles.length === 0) {
      setCreateRequestError("กรุณาเลือกไฟล์รูปภาพหรือ PDF");
      return;
    }

    setIsCreatingRequest(true);
    setCreateRequestError("");
    setDeleteMessage("");
    setDeleteError("");
    setStatusMessage("");
    setStatusError("");

    try {
      const firstFile = acceptedFiles[0];
      const requestTitle = firstFile.name.replace(/\.[^.]+$/, "") || "Template ใหม่";
      const request = await createTemplateRequest({
        requestTitle,
        documentType: newTemplateType.trim() || "เอกสารทั่วไป",
        requestMode: "image_only",
        pageCount: 1,
        userNote: "สร้างโดยผู้ดูแลระบบจากหน้า Template",
        requestedBy: "admin",
      });

      for (const [fileIndex, file] of acceptedFiles.entries()) {
        const sourceFileId = `admin_template_file_${Date.now()}_${fileIndex}`;
        const sourceFileName = file.name || `ไฟล์ Template ${fileIndex + 1}`;
        const pageImages = isPdfFile(file) ? await convertPdfToImages(file) : [await fileToDataUrl(file)];
        for (const imageUrl of pageImages) {
          await addTemplateRequestImage(request.id, imageUrl, "admin_upload", sourceFileId, sourceFileName);
        }
      }

      setNewTemplateType("");
      router.push(`/admin/requests/${request.id}`);
    } catch (error) {
      console.warn("Admin create template request failed.", error);
      setCreateRequestError(error instanceof Error ? error.message : "สร้าง Template Request ไม่สำเร็จ");
    } finally {
      setIsCreatingRequest(false);
    }
  };

  const handleDeleteTemplate = async (template: Template) => {
    if (loadStatus !== "loaded") {
      setDeleteError("ไม่สามารถลบ Template ตัวอย่างได้ เพราะไม่ได้มาจากฐานข้อมูลจริง");
      return;
    }
    const confirmed = window.confirm(
      `ลบ Template "${template.name}"?\n\nระบบจะลบ Template, หน้าเอกสาร, Field, Ignore Region และประวัติ Embedding ออกจากฐานข้อมูลถาวร การดำเนินการนี้ย้อนกลับไม่ได้`
    );
    if (!confirmed) return;

    setDeletingTemplateId(template.id);
    setDeleteMessage("");
    setDeleteError("");
    try {
      await deleteTemplateApi(template.id);
      setTemplates((current) => current.filter((item) => item.id !== template.id));
      setDeleteMessage(`ลบ Template "${template.name}" เรียบร้อยแล้ว`);
    } catch (error) {
      console.warn("Template delete failed.", error);
      setDeleteError(error instanceof Error ? error.message : "ลบ Template ไม่สำเร็จ");
    } finally {
      setDeletingTemplateId(null);
    }
  };

  return (
    <section className="space-y-4">
      <PageHeader
        eyebrow="คลัง Template"
        title="รายการ Template เอกสาร"
        description="จัดการ Template ฉบับร่าง Template ที่ใช้งานจริง และ Template ที่ยังไม่พร้อมใช้งาน การลบข้อมูลจะมีผลกับฐานข้อมูลจริงเท่านั้น"
      />

      <div className={`${cardClassName} overflow-hidden p-0`}>
        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-3 p-5">
            <div>
              <h2 className="text-base font-black text-slate-900">สร้าง Template ใหม่</h2>
              <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">
                อัปโหลดรูปภาพหรือ PDF เพื่อสร้างคำขอ Template ใหม่ จากนั้นระบบจะพาไปหน้า Request Detail เพื่อตรวจไฟล์ ใส่ชื่อ Template และสร้าง Template
              </p>
            </div>
            <div className="grid gap-3">
              <label className="space-y-1.5">
                <span className="text-[11px] font-black uppercase tracking-wide text-slate-500">ประเภทเอกสาร</span>
                <input
                  type="text"
                  value={newTemplateType}
                  onChange={(event) => setNewTemplateType(event.target.value)}
                  placeholder="เช่น Invoice, ใบสมัคร, ใบรับรอง"
                  className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                />
              </label>
            </div>
            {createRequestError && <InlineState tone="danger" message={createRequestError} />}
          </div>
          <div className="border-t border-slate-100 bg-slate-50 p-5 lg:border-l lg:border-t-0">
            <label
              className={`flex h-full min-h-44 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-4 text-center transition-colors ${
                isCreatingRequest || loadStatus !== "loaded"
                  ? "cursor-not-allowed border-slate-200 bg-white text-slate-400"
                  : "border-indigo-200 bg-white text-indigo-700 hover:border-indigo-400 hover:bg-indigo-50"
              }`}
            >
              {isCreatingRequest ? <Loader2 size={28} className="animate-spin" /> : <UploadCloud size={32} />}
              <span className="mt-3 text-sm font-black">{isCreatingRequest ? "กำลังสร้าง Template Request..." : "เลือกไฟล์เพื่อสร้าง Template"}</span>
              <span className="mt-1 text-xs font-semibold text-slate-500">รองรับ PNG, JPG, WebP และ PDF หลายหน้า</span>
              <input
                type="file"
                multiple
                accept="image/*,application/pdf"
                disabled={isCreatingRequest || loadStatus !== "loaded"}
                onChange={(event) => {
                  handleCreateTemplateRequest(event.target.files);
                  event.currentTarget.value = "";
                }}
                className="sr-only"
              />
            </label>
          </div>
        </div>
      </div>

      <div className={`${cardClassName} p-4 space-y-4`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-800">สถานะ Template</h2>
          <p className="mt-1 text-xs font-medium text-slate-500">เลือกดู Template ตามสถานะโดยไม่เปลี่ยนข้อมูลจริง</p>
        </div>
        <div className="grid w-full gap-2 sm:grid-cols-4 lg:w-auto lg:min-w-[520px]">
          {statusFilterOptions.map((status) => (
            <button
              key={status.value}
              type="button"
              onClick={() => setSelectedStatus(status.value)}
              className={`inline-flex h-10 items-center justify-between rounded-xl border px-3 text-xs font-black transition-colors ${
                selectedStatus === status.value
                  ? "border-indigo-500 bg-indigo-600 text-white"
                  : "border-slate-200 bg-slate-100 text-slate-600 hover:bg-slate-50"
              }`}
            >
              <span>{status.label}</span>
              <span className={`ml-2 inline-flex min-w-6 justify-center rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                selectedStatus === status.value ? "bg-white/20 text-white" : "bg-white text-slate-500"
              }`}>
                {statusCounts[status.value]}
              </span>
            </button>
          ))}
        </div>
      </div>

      {loadStatus === "loading" && <LoadingState message="กำลังโหลด Template จากฐานข้อมูล..." />}
      {loadStatus === "error" && (
        <InlineState tone="warning" message="โหลดรายการ Template จาก Backend ไม่สำเร็จ กรุณาตรวจการเชื่อมต่อแล้วลองใหม่" />
      )}
      {deleteMessage && (
        <InlineState tone="success" message={deleteMessage} />
      )}
      {deleteError && (
        <InlineState tone="danger" message={deleteError} />
      )}
      {statusMessage && (
        <InlineState tone="success" message={statusMessage} />
      )}
      {statusError && (
        <InlineState tone="danger" message={statusError} />
      )}
      {renameMessage && (
        <InlineState tone="success" message={renameMessage} />
      )}
      {renameError && (
        <InlineState tone="danger" message={renameError} />
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {filteredTemplates.map((template) => (
          <div key={template.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="relative h-44 border-b border-slate-200 bg-slate-100">
              {template.previewImageUrl ? (
                <img
                  src={template.previewImageUrl}
                  alt={`${template.name} template preview`}
                  className="h-full w-full bg-white object-contain"
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-400">
                  <FileImage size={30} strokeWidth={1.8} />
                  <span className="ui-caption font-semibold">ไม่มีภาพตัวอย่าง</span>
                </div>
              )}
              <div className="absolute bottom-3 right-3 rounded-full border border-slate-200 bg-white/95 px-2.5 py-1 text-[11px] font-bold tabular-nums text-slate-600 shadow-sm">
                {template.pageCount} หน้า
              </div>
            </div>
            <div className="space-y-3 p-4">
            <div>
              {editingTemplateId === template.id ? (
                <div className="space-y-2">
                  <label className="block space-y-1">
                    <span className="text-[10px] font-black uppercase tracking-wide text-slate-500">ชื่อ Template</span>
                    <input
                      type="text"
                      value={editingTemplateName}
                      onChange={(event) => setEditingTemplateName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleRenameTemplate(template);
                        }
                        if (event.key === "Escape") {
                          cancelRenameTemplate();
                        }
                      }}
                      disabled={renamingTemplateId === template.id}
                      autoFocus
                      className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-900 outline-none transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-100 disabled:text-slate-400"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void handleRenameTemplate(template)}
                      disabled={renamingTemplateId === template.id}
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-indigo-600 px-3 text-xs font-black text-white transition-colors hover:bg-indigo-700 disabled:bg-slate-300 disabled:text-slate-500"
                    >
                      {renamingTemplateId === template.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                      บันทึก
                    </button>
                    <button
                      type="button"
                      onClick={cancelRenameTemplate}
                      disabled={renamingTemplateId === template.id}
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-black text-slate-600 transition-colors hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400"
                    >
                      <X size={14} />
                      ยกเลิก
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex min-h-10 items-start justify-between gap-2">
                  <div className="line-clamp-2 text-sm font-black leading-5 text-slate-900">{template.name}</div>
                  <button
                    type="button"
                    onClick={() => startRenameTemplate(template)}
                    disabled={loadStatus !== "loaded" || deletingTemplateId === template.id || statusUpdatingTemplateId === template.id || renamingTemplateId === template.id}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 disabled:bg-slate-100 disabled:text-slate-300"
                    title="เปลี่ยนชื่อ Template"
                    aria-label={`เปลี่ยนชื่อ ${template.name}`}
                  >
                    <Pencil size={14} />
                  </button>
                </div>
              )}
              <div className="mt-1 flex flex-wrap gap-1.5">
                <StatusBadge status={template.status} />
                {loadStatus === "error" && (
                  <StatusBadge status="backend error" tone="warning" />
                )}
              </div>
            </div>
            <div className="rounded-xl bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500">
              {template.documentType || "No document type"} · Template preview
            </div>
            <div className="flex flex-wrap gap-2">
              <ActionButton href={`/admin/templates/${template.id}/edit`} tone="primary">แก้ไข</ActionButton>
              <ActionButton href={`/admin/templates/${template.id}/test`}>ตรวจสอบก่อนเผยแพร่</ActionButton>
              <label className="min-w-[170px]">
                <span className="sr-only">Template status</span>
                <select
                  value={manageableStatuses.includes(template.status) ? (template.status === "disabled" ? "nonactive" : template.status) : template.status}
                  onChange={(event) => {
                    const nextStatus = event.target.value as TemplateStatus;
                    if (nextStatus !== template.status) {
                      handleChangeTemplateStatus(template, nextStatus);
                    }
                  }}
                  disabled={
                    loadStatus !== "loaded" ||
                    deletingTemplateId === template.id ||
                    statusUpdatingTemplateId === template.id ||
                    !manageableStatuses.includes(template.status)
                  }
                  title={!manageableStatuses.includes(template.status) ? "Template ต้องผ่านการ Publish ก่อน จึงจะเปิดหรือปิดใช้งานได้" : undefined}
                  className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs font-black text-slate-700 shadow-sm outline-none transition-colors hover:border-indigo-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-100 disabled:text-slate-400"
                >
                  {!manageableStatuses.includes(template.status) && (
                    <option value={template.status}>{statusSelectLabel(template.status)}</option>
                  )}
                  <option value="active">ใช้งานอยู่</option>
                  <option value="nonactive">ปิดใช้งานชั่วคราว</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() => handleDeleteTemplate(template)}
                disabled={loadStatus !== "loaded" || deletingTemplateId === template.id || statusUpdatingTemplateId === template.id}
                className="ui-stable-action-sm rounded-xl border border-red-200 bg-white px-4 py-2.5 text-xs font-black text-red-600 transition-colors hover:bg-red-50 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
              >
                {deletingTemplateId === template.id ? "กำลังลบ..." : "ลบ"}
              </button>
            </div>
            </div>
          </div>
        ))}
        {loadStatus === "loaded" && filteredTemplates.length === 0 && (
          <div className="md:col-span-2 xl:col-span-3">
            <EmptyState title="ไม่พบ Template" message="ไม่มี Template ที่ตรงกับสถานะที่เลือก" />
          </div>
        )}
      </div>
      </div>
    </section>
  );
}
