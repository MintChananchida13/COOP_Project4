"use client";

import { useMemo, useState } from "react";
import { ROI, RequestedField, TemplateRequestMode } from "../../types/ocr";

type PageAwareRoi = ROI & { pageIndex?: number };

interface TemplateRequestPanelProps {
  imagesList: string[];
  rois: PageAwareRoi[];
  isOpen: boolean;
  onClose: () => void;
}

type RequestStatus = "idle" | "submitting" | "submitted" | "mock_submitted" | "error";

interface ImageSize {
  width: number;
  height: number;
}

interface TemplateRequestPageResponse {
  id: string;
  page_number: number;
}

interface TemplateRequestCreateResponse {
  id: string;
  pages?: TemplateRequestPageResponse[];
}

const API_BASE_URL = "http://localhost:8000";
const WORKSPACE_RENDERED_WIDTH = 750;

const clampRatio = (value: number) => Math.min(1, Math.max(0, value));

const loadImageSize = (src: string): Promise<ImageSize> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || WORKSPACE_RENDERED_WIDTH, height: img.naturalHeight || WORKSPACE_RENDERED_WIDTH });
    img.onerror = reject;
    img.src = src;
  });

const toRequestedField = (roi: PageAwareRoi, renderedHeight: number, index: number): RequestedField => {
  const pageIndex = roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0;
  return {
    id: `requested_field_${roi.id}`,
    fieldName: roi.fieldName || `field_${index + 1}`,
    displayLabel: roi.fieldName || `Field ${index + 1}`,
    roi: {
      pageNumber: pageIndex + 1,
      xRatio: clampRatio(roi.x / WORKSPACE_RENDERED_WIDTH),
      yRatio: clampRatio(roi.y / renderedHeight),
      widthRatio: clampRatio(roi.width / WORKSPACE_RENDERED_WIDTH),
      heightRatio: clampRatio(roi.height / renderedHeight),
    },
  };
};

export default function TemplateRequestPanel({ imagesList, rois, isOpen, onClose }: TemplateRequestPanelProps) {
  const [requestTitle, setRequestTitle] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [userNote, setUserNote] = useState("");
  const [requestMode, setRequestMode] = useState<TemplateRequestMode>("image_only");
  const [status, setStatus] = useState<RequestStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");

  const enabledRois = useMemo(() => rois.filter((roi) => roi.enabled !== false), [rois]);
  const fieldsByPage = useMemo(() => {
    return enabledRois.reduce<Record<number, number>>((acc, roi) => {
      const pageNumber = (roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0) + 1;
      acc[pageNumber] = (acc[pageNumber] || 0) + 1;
      return acc;
    }, {});
  }, [enabledRois]);

  const canSubmit = imagesList.length > 0 && requestTitle.trim().length > 0 && status !== "submitting";

  const buildRequestedFields = async () => {
    const imageSizes = await Promise.all(imagesList.map((src) => loadImageSize(src)));
    return enabledRois.map((roi, index) => {
      const pageIndex = roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0;
      const imageSize = imageSizes[pageIndex] || imageSizes[0] || { width: WORKSPACE_RENDERED_WIDTH, height: WORKSPACE_RENDERED_WIDTH };
      const renderedHeight = imageSize.width > 0 ? (imageSize.height / imageSize.width) * WORKSPACE_RENDERED_WIDTH : WORKSPACE_RENDERED_WIDTH;
      return toRequestedField(roi, renderedHeight, index);
    });
  };

  const submitWithBackend = async (requestedFields: RequestedField[]) => {
    const createResponse = await fetch(`${API_BASE_URL}/template-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_title: requestTitle.trim(),
        document_type: documentType.trim() || null,
        sample_file_url: imagesList[0] || null,
        request_mode: requestMode,
        page_count: imagesList.length,
        user_note: userNote.trim() || null,
        pages: imagesList.map((src, index) => ({
          page_number: index + 1,
          original_image_url: src,
          normalized_image_url: src,
        })),
      }),
    });

    if (!createResponse.ok) {
      throw new Error(`Template request create failed with ${createResponse.status}`);
    }

    const createJson = await createResponse.json();
    const createdRequest = createJson?.data as TemplateRequestCreateResponse | undefined;
    const requestId = createdRequest?.id;
    if (!requestId) {
      throw new Error("Template request response did not include an id");
    }

    if (requestMode === "image_with_roi") {
      await Promise.all(
        requestedFields.map((field) =>
          fetch(`${API_BASE_URL}/template-requests/${requestId}/requested-fields`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              template_request_page_id:
                createdRequest?.pages?.find((page) => page.page_number === field.roi.pageNumber)?.id ||
                `template_request_page_${field.roi.pageNumber}`,
              page_number: field.roi.pageNumber,
              field_name: field.fieldName,
              display_label: field.displayLabel,
              roi: {
                page_number: field.roi.pageNumber,
                x_ratio: field.roi.xRatio,
                y_ratio: field.roi.yRatio,
                width_ratio: field.roi.widthRatio,
                height_ratio: field.roi.heightRatio,
              },
              user_note: field.userNote || null,
            }),
          })
        )
      );
    }

    const submitResponse = await fetch(`${API_BASE_URL}/template-requests/${requestId}/submit`, {
      method: "POST",
    });

    if (!submitResponse.ok) {
      throw new Error(`Template request submit failed with ${submitResponse.status}`);
    }

    return requestId;
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setStatus("submitting");
    setStatusMessage("");

    try {
      const requestedFields = requestMode === "image_with_roi" ? await buildRequestedFields() : [];
      const requestId = await submitWithBackend(requestedFields);
      setStatus("submitted");
      setStatusMessage(`Template request submitted: ${requestId}`);
    } catch (error) {
      console.error("Template request submission failed.", error);
      setStatus("error");
      setStatusMessage(error instanceof Error ? error.message : "Template request submission failed.");
    }
  };

  return (
    <div className={`fixed inset-0 z-50 ${isOpen ? "pointer-events-auto" : "pointer-events-none"}`} aria-hidden={!isOpen}>
      <div
        className={`absolute inset-0 bg-slate-950/30 transition-opacity ${isOpen ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <aside
        className={`absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-2xl transition-transform duration-200 ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex h-full flex-col">
          <div className="border-b border-slate-200 px-5 py-4 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-black text-slate-800 uppercase tracking-wide">Template Request</h2>
              <p className="text-xs font-semibold text-slate-500">
                Send this OCR session to admin review.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-black text-slate-500 hover:bg-slate-50"
            >
              Close
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500">
              {imagesList.length} page{imagesList.length === 1 ? "" : "s"}
              {requestMode === "image_with_roi" && `, ${enabledRois.length} requested ROI`}
            </div>

            <div className="space-y-1">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Request Mode</span>
              <div className="grid grid-cols-2 rounded-xl border border-slate-200 bg-slate-50 p-1">
                <button
                  type="button"
                  onClick={() => setRequestMode("image_only")}
                  className={`px-3 py-2 rounded-lg text-xs font-black transition-all ${
                    requestMode === "image_only" ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500"
                  }`}
                >
                  Image Only
                </button>
                <button
                  type="button"
                  onClick={() => setRequestMode("image_with_roi")}
                  className={`px-3 py-2 rounded-lg text-xs font-black transition-all ${
                    requestMode === "image_with_roi" ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500"
                  }`}
                >
                  Image + ROI
                </button>
              </div>
            </div>

            <label className="block space-y-1">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Request Title</span>
              <input
                type="text"
                value={requestTitle}
                onChange={(event) => setRequestTitle(event.target.value)}
                placeholder="e.g. New invoice template"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-semibold text-slate-800 outline-none focus:border-indigo-500 focus:bg-white"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Document Type</span>
              <input
                type="text"
                value={documentType}
                onChange={(event) => setDocumentType(event.target.value)}
                placeholder="Optional"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-semibold text-slate-800 outline-none focus:border-indigo-500 focus:bg-white"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">User Note</span>
              <textarea
                value={userNote}
                onChange={(event) => setUserNote(event.target.value)}
                rows={4}
                placeholder="Optional note for admin review"
                className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-semibold text-slate-800 outline-none focus:border-indigo-500 focus:bg-white"
              />
            </label>

            {requestMode === "image_with_roi" && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-[10px] font-black uppercase tracking-wider text-slate-400">Requested fields by page</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {Object.keys(fieldsByPage).length === 0 ? (
                    <span className="text-xs font-semibold text-slate-500">No ROI has been drawn yet.</span>
                  ) : (
                    Object.entries(fieldsByPage).map(([pageNumber, count]) => (
                      <span key={pageNumber} className="rounded-lg bg-white border border-slate-200 px-2.5 py-1 text-xs font-bold text-slate-700">
                        Page {pageNumber}: {count} ROI
                      </span>
                    ))
                  )}
                </div>
              </div>
            )}

            <div className={`text-xs font-bold ${
              status === "error" ? "text-red-600" : status === "submitted" || status === "mock_submitted" ? "text-emerald-600" : "text-slate-500"
            }`}>
              {statusMessage || "Request status: not submitted"}
            </div>
          </div>

          <div className="border-t border-slate-200 p-5">
            <button
              type="button"
              disabled={!canSubmit}
              onClick={handleSubmit}
              className="w-full px-5 py-3 rounded-xl bg-indigo-600 text-white text-xs font-black uppercase tracking-wider shadow-sm disabled:bg-slate-300 disabled:text-slate-500"
            >
              {status === "submitting" ? "Submitting..." : "Submit"}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
