import {
  AdminTemplateRequest,
  IgnoreRegion,
  RoiDataType,
  Template,
  TemplateField,
  TemplatePage,
  TemplateStatus,
} from "../types/ocr";

export const ADMIN_API_BASE_URL = "http://localhost:8000";

interface ApiTemplateRequestPage {
  id: string;
  template_request_id: string;
  page_number: number;
  sample_image_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface ApiRequestedField {
  id: string;
  field_name: string;
  display_label: string;
  data_type?: string | null;
  dataType?: string | null;
  extraction_method?: string | null;
  extractionMethod?: string | null;
  user_note?: string | null;
  roi: {
    page_number: number;
    x_ratio: number;
    y_ratio: number;
    width_ratio: number;
    height_ratio: number;
  };
}

interface ApiTemplatePage {
  id: string;
  template_id: string;
  page_number: number;
  page_name?: string | null;
  sample_image_url?: string | null;
  normalized_image_url?: string | null;
  qdrant_point_id?: string | null;
  similarity_threshold?: number | null;
  final_confidence_threshold?: number | null;
}

interface ApiTemplateField {
  id: string;
  template_id: string;
  template_page_id: string;
  page_number: number;
  field_name: string;
  display_label: string;
  roi: {
    page_number: number;
    x_ratio: number;
    y_ratio: number;
    width_ratio: number;
    height_ratio: number;
  };
  data_type?: string | null;
  user_selectable: boolean;
  default_selected: boolean;
  use_for_verification: boolean;
  expected_text?: string | null;
  match_type?: string | null;
  required_for_verification: boolean;
  extraction_method: string;
  roi_padding?: number | null;
  sort_order: number;
}

interface ApiIgnoreRegion {
  id: string;
  template_id: string;
  template_page_id: string;
  page_number: number;
  field_name: string;
  roi: {
    page_number: number;
    x_ratio: number;
    y_ratio: number;
    width_ratio: number;
    height_ratio: number;
  };
}

interface ApiTemplate {
  id: string;
  name: string;
  document_type?: string | null;
  category?: string | null;
  status: string;
  version: number;
  page_count: number;
  similarity_threshold: number;
  final_confidence_threshold: number;
  rejection_reason?: string | null;
  pages?: ApiTemplatePage[];
  fields?: ApiTemplateField[];
  ignore_regions?: ApiIgnoreRegion[];
}

interface ApiEmbeddingJob {
  id: string;
  template_id: string;
  status: string;
  requested_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
  vector_id?: string | null;
  metadata_json?: string | null;
}

export type EmbeddingJobStatus = "queued" | "running" | "completed" | "failed";

export interface EmbeddingJob {
  id: string;
  templateId: string;
  status: EmbeddingJobStatus;
  requestedAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  errorMessage?: string | null;
  vectorId?: string | null;
  metadataJson?: string | null;
}

export interface DetectionCandidate {
  templateId?: string | null;
  vectorId?: string | null;
  score: number;
  averageScore?: number | null;
  matchedPages?: number | null;
  templateName?: string | null;
  templateStatus?: string | null;
  pageCount?: number | null;
  fieldCount?: number | null;
  modelName?: string | null;
  vectorStoreEngine?: string | null;
  pageIndex?: number | null;
  metadata?: Record<string, unknown>;
}

export interface DetectionPageResult {
  pageIndex: number;
  matched: boolean;
  bestCandidate?: DetectionCandidate | null;
  candidates: DetectionCandidate[];
  imagePreviewDataUrl?: string | null;
  debug?: Record<string, unknown>;
}

export interface DetectionDevResult {
  queryId: string;
  engine: string;
  version: string;
  threshold: number;
  matched: boolean;
  bestCandidate?: DetectionCandidate | null;
  candidates: DetectionCandidate[];
  pages: DetectionPageResult[];
  message?: string | null;
  debug?: Record<string, unknown>;
}

export interface ApiTemplateRequest {
  id: string;
  request_title: string;
  document_type?: string | null;
  request_mode: "image_only" | "image_with_roi";
  status: string;
  user_note?: string | null;
  admin_note?: string | null;
  converted_template_id?: string | null;
  page_count: number;
  created_at?: string | null;
  updated_at?: string | null;
  pages?: ApiTemplateRequestPage[];
  requested_fields?: ApiRequestedField[];
}

const mapRequestStatus = (status: string): AdminTemplateRequest["status"] => {
  if (status === "converted_to_template") return "converted";
  if (status === "draft" || status === "submitted" || status === "in_review" || status === "converted" || status === "rejected") {
    return status;
  }
  return "draft";
};

const mapTemplateStatus = (status: string): TemplateStatus => {
  if (
    status === "draft" ||
    status === "validated" ||
    status === "embedding_pending" ||
    status === "active" ||
    status === "pending_review" ||
    status === "embedding_generated" ||
    status === "testing" ||
    status === "approved" ||
    status === "rejected" ||
    status === "disabled"
  ) {
    return status;
  }
  return "draft";
};

const normalizeExtractionMethod = (value?: string | null) => {
  if (value === "ocr_table" || value === "extract_image") return value;
  return "ocr_text";
};

const mapEmbeddingJobStatus = (status: string): EmbeddingJobStatus => {
  if (status === "running" || status === "completed" || status === "failed") return status;
  return "queued";
};

export const mapApiRequest = (request: ApiTemplateRequest): AdminTemplateRequest => ({
  id: request.id,
  requestTitle: request.request_title,
  documentType: request.document_type || undefined,
  requestMode: request.request_mode,
  status: mapRequestStatus(request.status),
  userNote: request.user_note || undefined,
  adminNote: request.admin_note || undefined,
  convertedTemplateId: request.converted_template_id || undefined,
  pageCount: request.page_count,
  createdAt: request.created_at || undefined,
  updatedAt: request.updated_at || undefined,
  pages: (request.pages || []).map((page) => ({
    id: page.id,
    templateRequestId: page.template_request_id,
    pageNumber: page.page_number,
    sampleImageUrl: page.sample_image_url || undefined,
  })),
  requestedFields: (request.requested_fields || []).map((field) => ({
    id: field.id,
    fieldName: field.field_name,
    displayLabel: field.display_label,
    dataType: (field.data_type || field.dataType || "text") as RoiDataType,
    extractionMethod: normalizeExtractionMethod(field.extraction_method || field.extractionMethod),
    userNote: field.user_note || undefined,
    roi: {
      pageNumber: field.roi.page_number,
      xRatio: field.roi.x_ratio,
      yRatio: field.roi.y_ratio,
      widthRatio: field.roi.width_ratio,
      heightRatio: field.roi.height_ratio,
    },
  })),
});

const mapApiTemplate = (template: ApiTemplate): Template => ({
  id: template.id,
  name: template.name,
  documentType: template.document_type || undefined,
  category: template.category || undefined,
  status: mapTemplateStatus(template.status),
  version: template.version,
  pageCount: template.page_count,
  similarityThreshold: template.similarity_threshold,
  finalConfidenceThreshold: template.final_confidence_threshold,
  rejectionReason: template.rejection_reason || undefined,
});

const mapApiEmbeddingJob = (job?: ApiEmbeddingJob | null): EmbeddingJob | null => {
  if (!job) return null;
  return {
    id: job.id,
    templateId: job.template_id,
    status: mapEmbeddingJobStatus(job.status),
    requestedAt: job.requested_at || undefined,
    startedAt: job.started_at || null,
    completedAt: job.completed_at || null,
    errorMessage: job.error_message || null,
    vectorId: job.vector_id || null,
    metadataJson: job.metadata_json || null,
  };
};

const mapDetectionCandidate = (candidate: Record<string, unknown>): DetectionCandidate => ({
  templateId: (candidate.template_id as string | null | undefined) ?? null,
  vectorId: (candidate.vector_id as string | null | undefined) ?? null,
  score: typeof candidate.score === "number" ? candidate.score : 0,
  averageScore: typeof candidate.average_score === "number" ? candidate.average_score : null,
  matchedPages: typeof candidate.matched_pages === "number" ? candidate.matched_pages : null,
  templateName: (candidate.template_name as string | null | undefined) ?? null,
  templateStatus: (candidate.template_status as string | null | undefined) ?? null,
  pageCount: typeof candidate.page_count === "number" ? candidate.page_count : null,
  fieldCount: typeof candidate.field_count === "number" ? candidate.field_count : null,
  modelName: (candidate.model_name as string | null | undefined) ?? null,
  vectorStoreEngine: (candidate.vector_store_engine as string | null | undefined) ?? null,
  pageIndex: typeof candidate.page_index === "number" ? candidate.page_index : null,
  metadata: (candidate.metadata as Record<string, unknown> | undefined) || {},
});

const mapDetectionPage = (page: Record<string, unknown>): DetectionPageResult => ({
  pageIndex: typeof page.page_index === "number" ? page.page_index : 1,
  matched: Boolean(page.matched),
  bestCandidate: page.best_candidate ? mapDetectionCandidate(page.best_candidate as Record<string, unknown>) : null,
  candidates: Array.isArray(page.candidates) ? (page.candidates as Record<string, unknown>[]).map(mapDetectionCandidate) : [],
  imagePreviewDataUrl: (page.image_preview_data_url as string | null | undefined) ?? null,
  debug: (page.debug as Record<string, unknown> | undefined) || {},
});

const mapApiTemplatePage = (page: ApiTemplatePage): TemplatePage => ({
  id: page.id,
  templateId: page.template_id,
  pageNumber: page.page_number,
  pageName: page.page_name || undefined,
  sampleImageUrl: page.sample_image_url || undefined,
  normalizedImageUrl: page.normalized_image_url || undefined,
  qdrantPointId: page.qdrant_point_id || undefined,
  similarityThreshold: page.similarity_threshold ?? 0.75,
  finalConfidenceThreshold: page.final_confidence_threshold ?? 0.8,
});

const mapApiTemplateField = (field: ApiTemplateField): TemplateField => ({
  id: field.id,
  templateId: field.template_id,
  templatePageId: field.template_page_id,
  pageNumber: field.page_number,
  fieldName: field.field_name,
  displayLabel: field.display_label,
  roi: {
    pageNumber: field.roi.page_number,
    xRatio: field.roi.x_ratio,
    yRatio: field.roi.y_ratio,
    widthRatio: field.roi.width_ratio,
    heightRatio: field.roi.height_ratio,
  },
  dataType: (field.data_type || "text") as RoiDataType,
  userSelectable: field.user_selectable,
  defaultSelected: field.default_selected,
  useForVerification: field.use_for_verification,
  expectedText: field.expected_text || undefined,
  matchType: field.match_type || undefined,
  requiredForVerification: field.required_for_verification,
  extractionMethod: normalizeExtractionMethod(field.extraction_method),
  roiPadding: field.roi_padding ?? undefined,
  sortOrder: field.sort_order,
});

const mapApiIgnoreRegion = (region: ApiIgnoreRegion): IgnoreRegion => ({
  id: region.id,
  templateId: region.template_id,
  templatePageId: region.template_page_id,
  pageNumber: region.page_number,
  fieldName: region.field_name,
  roi: {
    pageNumber: region.roi.page_number,
    xRatio: region.roi.x_ratio,
    yRatio: region.roi.y_ratio,
    widthRatio: region.roi.width_ratio,
    heightRatio: region.roi.height_ratio,
  },
});

interface ConvertTemplateResponse {
  template_request_id: string;
  converted_template_id?: string | null;
  template_id?: string | null;
  status: string;
  created_records?: {
    templates: number;
    template_pages: number;
    template_fields: number;
  };
}

export const fetchTemplateRequests = async () => {
  const response = await fetch(`${ADMIN_API_BASE_URL}/template-requests`);
  if (!response.ok) {
    throw new Error(`Template request load failed with ${response.status}`);
  }

  const json = await response.json();
  const apiRequests = json?.data?.template_requests as ApiTemplateRequest[] | undefined;
  return (apiRequests || []).map(mapApiRequest);
};

export const fetchTemplateRequest = async (requestId: string) => {
  const response = await fetch(`${ADMIN_API_BASE_URL}/template-requests/${requestId}`);
  if (!response.ok) {
    throw new Error(`Template request detail failed with ${response.status}`);
  }

  const json = await response.json();
  return mapApiRequest(json?.data as ApiTemplateRequest);
};

export const fetchTemplateRequestPages = async (requestId: string) => {
  const response = await fetch(`${ADMIN_API_BASE_URL}/template-requests/${requestId}/pages`);
  if (!response.ok) {
    throw new Error(`Template request pages failed with ${response.status}`);
  }

  const json = await response.json();
  const pages = json?.data?.pages as ApiTemplateRequestPage[] | undefined;
  return (pages || []).map((page) => ({
    id: page.id,
    templateRequestId: page.template_request_id,
    pageNumber: page.page_number,
    sampleImageUrl: page.sample_image_url || undefined,
  }));
};

export const deleteTemplateRequest = async (requestId: string) => {
  let response = await fetch(`${ADMIN_API_BASE_URL}/admin/template-requests/${requestId}`, {
    method: "DELETE",
  });

  if (response.status === 405) {
    response = await fetch(`${ADMIN_API_BASE_URL}/template-requests/${requestId}`, {
      method: "DELETE",
    });
  }

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = json?.detail || json?.error?.message || json?.error || `Delete failed with ${response.status}`;
    throw new Error(typeof detail === "string" ? detail : `Delete failed with ${response.status}`);
  }

  const verifyResponse = await fetch(`${ADMIN_API_BASE_URL}/template-requests/${requestId}`, {
    cache: "no-store",
  });
  if (verifyResponse.ok) {
    const verifyJson = await verifyResponse.json().catch(() => null);
    const verifyData = verifyJson?.data;
    if (verifyData && verifyData.status !== "not_found") {
      throw new Error("Backend reported delete success, but the template request still exists. Restart the backend so the real delete service is loaded.");
    }
  }

  return json?.data as {
    id: string;
    deleted: boolean;
    converted_template_id?: string | null;
    deleted_records?: {
      template_requests: number;
      template_request_pages: number;
      requested_fields: number;
    };
  };
};

export const fetchTemplateBundle = async (templateId: string) => {
  const response = await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}`);
  if (!response.ok) {
    throw new Error(`Template load failed with ${response.status}`);
  }

  const json = await response.json();
  const data = json?.data as ApiTemplate;
  if (!data || data.status === "not_found") {
    throw new Error("Template not found");
  }

  return {
    template: mapApiTemplate(data),
    pages: (data.pages || []).map(mapApiTemplatePage),
    fields: (data.fields || []).map(mapApiTemplateField),
    ignoreRegions: (data.ignore_regions || []).map(mapApiIgnoreRegion),
  };
};

export const fetchTemplates = async () => {
  const response = await fetch(`${ADMIN_API_BASE_URL}/admin/templates`);
  if (!response.ok) {
    throw new Error(`Template list failed with ${response.status}`);
  }

  const json = await response.json();
  const templates = json?.data?.templates as ApiTemplate[] | undefined;
  return (templates || []).map(mapApiTemplate);
};

const isTemplateBundle = (data: Partial<ApiTemplate> | null | undefined): data is ApiTemplate =>
  Boolean(data && typeof data.name === "string" && Array.isArray(data.pages) && Array.isArray(data.fields) && Array.isArray(data.ignore_regions));

const mapTemplateBundleResponse = async (response: Response, templateId: string) => {
  if (!response.ok) {
    throw new Error(`Template mutation failed with ${response.status}`);
  }

  const json = await response.json();
  const data = json?.data as Partial<ApiTemplate> | undefined;
  if (data?.status === "not_found") {
    throw new Error("Template mutation did not return a template bundle");
  }

  if (!isTemplateBundle(data)) {
    return fetchTemplateBundle(templateId);
  }

  return {
    template: mapApiTemplate(data),
    pages: (data.pages || []).map(mapApiTemplatePage),
    fields: (data.fields || []).map(mapApiTemplateField),
    ignoreRegions: (data.ignore_regions || []).map(mapApiIgnoreRegion),
  };
};

export const updateTemplateApi = async (templateId: string, patch: Partial<Template>) =>
  mapTemplateBundleResponse(
    await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: patch.name,
        document_type: patch.documentType,
        category: patch.category,
        status: patch.status,
        page_count: patch.pageCount,
        similarity_threshold: patch.similarityThreshold,
        final_confidence_threshold: patch.finalConfidenceThreshold,
        rejection_reason: patch.rejectionReason,
      }),
    }),
    templateId
  );

export const updateTemplateStatus = async (templateId: string, status: TemplateStatus) =>
  updateTemplateApi(templateId, { status });

const embeddingJobResponseError = async (response: Response, fallback: string) => {
  const json = await response.json().catch(() => null);
  const detail = json?.detail || json?.error?.message || json?.error || fallback;
  return new Error(typeof detail === "string" ? detail : fallback);
};

const mapEmbeddingJobMutationResponse = async (response: Response) => {
  if (!response.ok) {
    throw await embeddingJobResponseError(response, `Embedding job request failed with ${response.status}`);
  }

  const json = await response.json();
  const data = json?.data as { job?: ApiEmbeddingJob | null; template?: ApiTemplate } | undefined;
  const job = mapApiEmbeddingJob(data?.job);
  if (!job || !data?.template) {
    throw new Error("Embedding job mutation did not return job and template data");
  }

  return {
    job,
    template: mapApiTemplate(data.template),
  };
};

export const createEmbeddingJob = async (templateId: string) =>
  mapEmbeddingJobMutationResponse(
    await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}/embedding-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
  );

export const fetchLatestEmbeddingJob = async (templateId: string) => {
  const response = await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}/embedding-jobs/latest`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw await embeddingJobResponseError(response, `Embedding job load failed with ${response.status}`);
  }

  const json = await response.json();
  const job = json?.data?.job as ApiEmbeddingJob | null | undefined;
  return mapApiEmbeddingJob(job);
};

export const completeEmbeddingJobDev = async (jobId: string) =>
  mapEmbeddingJobMutationResponse(
    await fetch(`${ADMIN_API_BASE_URL}/admin/embedding-jobs/${jobId}/complete-dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
  );

export const runEmbeddingJobDev = async (jobId: string) =>
  mapEmbeddingJobMutationResponse(
    await fetch(`${ADMIN_API_BASE_URL}/admin/embedding-jobs/${jobId}/run-dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
  );

export const failEmbeddingJobDev = async (jobId: string) =>
  mapEmbeddingJobMutationResponse(
    await fetch(`${ADMIN_API_BASE_URL}/admin/embedding-jobs/${jobId}/fail-dev`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
  );

export const detectTemplateDev = async (file: File): Promise<DetectionDevResult> => {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${ADMIN_API_BASE_URL}/api/templates/detect-dev`, {
    method: "POST",
    body: formData,
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = json?.detail || json?.error?.message || json?.error || `Detection failed with ${response.status}`;
    throw new Error(typeof detail === "string" ? detail : `Detection failed with ${response.status}`);
  }

  const data = json?.data as Record<string, unknown> | undefined;
  const candidates = Array.isArray(data?.candidates) ? (data.candidates as Record<string, unknown>[]).map(mapDetectionCandidate) : [];
  const pages = Array.isArray(data?.pages) ? (data.pages as Record<string, unknown>[]).map(mapDetectionPage) : [];
  return {
    queryId: String(data?.query_id || ""),
    engine: String(data?.engine || "stub"),
    version: String(data?.version || "phase7.0"),
    threshold: typeof data?.threshold === "number" ? data.threshold : 0.75,
    matched: Boolean(data?.matched),
    bestCandidate: data?.best_candidate ? mapDetectionCandidate(data.best_candidate as Record<string, unknown>) : null,
    candidates,
    pages,
    message: (data?.message as string | null | undefined) ?? null,
    debug: (data?.debug as Record<string, unknown> | undefined) || {},
  };
};

export const createTemplatePageApi = async (templateId: string, pageNumber: number, sampleImageUrl?: string) =>
  mapTemplateBundleResponse(
    await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page_number: pageNumber,
        page_name: `Page ${pageNumber}`,
        sample_image_url: sampleImageUrl,
        normalized_image_url: sampleImageUrl,
      }),
    }),
    templateId
  );

export const updateTemplatePageApi = async (templateId: string, pageId: string, patch: Partial<TemplatePage>) =>
  mapTemplateBundleResponse(
    await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}/pages/${pageId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page_number: patch.pageNumber,
        page_name: patch.pageName,
        sample_image_url: patch.sampleImageUrl,
        normalized_image_url: patch.normalizedImageUrl,
        similarity_threshold: patch.similarityThreshold,
        final_confidence_threshold: patch.finalConfidenceThreshold,
      }),
    }),
    templateId
  );

export const deleteTemplatePageApi = async (templateId: string, pageId: string) =>
  mapTemplateBundleResponse(
    await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}/pages/${pageId}`, {
      method: "DELETE",
    }),
    templateId
  );

const fieldToApiPayload = (
  field: Partial<TemplateField> & Pick<TemplateField, "templatePageId" | "pageNumber" | "fieldName" | "displayLabel" | "roi">
) => ({
  template_page_id: field.templatePageId,
  page_number: field.pageNumber,
  field_name: field.fieldName,
  display_label: field.displayLabel,
  roi: {
    page_number: field.roi.pageNumber,
    x_ratio: field.roi.xRatio,
    y_ratio: field.roi.yRatio,
    width_ratio: field.roi.widthRatio,
    height_ratio: field.roi.heightRatio,
  },
  data_type: field.dataType || "text",
  user_selectable: field.userSelectable ?? true,
  default_selected: field.defaultSelected ?? true,
  use_for_verification: field.useForVerification ?? false,
  expected_text: field.expectedText,
  match_type: field.matchType,
  required_for_verification: field.requiredForVerification ?? false,
  extraction_method: normalizeExtractionMethod(field.extractionMethod),
  roi_padding: field.roiPadding ?? 0,
  sort_order: field.sortOrder ?? 0,
});

export const createTemplateFieldApi = async (
  templateId: string,
  field: Partial<TemplateField> & Pick<TemplateField, "templatePageId" | "pageNumber" | "fieldName" | "displayLabel" | "roi">
) =>
  mapTemplateBundleResponse(
    await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}/fields`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fieldToApiPayload(field)),
    }),
    templateId
  );

export const updateTemplateFieldApi = async (templateId: string, fieldId: string, patch: Partial<TemplateField>) => {
  const payload: Record<string, unknown> = {
    template_page_id: patch.templatePageId,
    page_number: patch.pageNumber,
    field_name: patch.fieldName,
    display_label: patch.displayLabel,
    data_type: patch.dataType,
    user_selectable: patch.userSelectable,
    default_selected: patch.defaultSelected,
    use_for_verification: patch.useForVerification,
    expected_text: patch.expectedText,
    match_type: patch.matchType,
    required_for_verification: patch.requiredForVerification,
    extraction_method: patch.extractionMethod ? normalizeExtractionMethod(patch.extractionMethod) : undefined,
    roi_padding: patch.roiPadding,
    sort_order: patch.sortOrder,
  };

  if (patch.roi) {
    payload.roi = {
      page_number: patch.roi.pageNumber,
      x_ratio: patch.roi.xRatio,
      y_ratio: patch.roi.yRatio,
      width_ratio: patch.roi.widthRatio,
      height_ratio: patch.roi.heightRatio,
    };
  }

  return mapTemplateBundleResponse(
    await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}/fields/${fieldId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    templateId
  );
};

export const deleteTemplateFieldApi = async (templateId: string, fieldId: string) =>
  mapTemplateBundleResponse(
    await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}/fields/${fieldId}`, {
      method: "DELETE",
    }),
    templateId
  );

const ignoreRegionToApiPayload = (
  region: Partial<IgnoreRegion> & Pick<IgnoreRegion, "templatePageId" | "pageNumber" | "fieldName" | "roi">
) => ({
  template_page_id: region.templatePageId,
  page_number: region.pageNumber,
  field_name: region.fieldName,
  roi: {
    page_number: region.roi.pageNumber,
    x_ratio: region.roi.xRatio,
    y_ratio: region.roi.yRatio,
    width_ratio: region.roi.widthRatio,
    height_ratio: region.roi.heightRatio,
  },
});

export const createIgnoreRegionApi = async (
  templateId: string,
  region: Partial<IgnoreRegion> & Pick<IgnoreRegion, "templatePageId" | "pageNumber" | "fieldName" | "roi">
) =>
  mapTemplateBundleResponse(
    await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}/ignore-regions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ignoreRegionToApiPayload(region)),
    }),
    templateId
  );

export const updateIgnoreRegionApi = async (templateId: string, regionId: string, patch: Partial<IgnoreRegion>) => {
  const payload: Record<string, unknown> = {
    template_page_id: patch.templatePageId,
    page_number: patch.pageNumber,
    field_name: patch.fieldName,
  };

  if (patch.roi) {
    payload.roi = {
      page_number: patch.roi.pageNumber,
      x_ratio: patch.roi.xRatio,
      y_ratio: patch.roi.yRatio,
      width_ratio: patch.roi.widthRatio,
      height_ratio: patch.roi.heightRatio,
    };
  }

  return mapTemplateBundleResponse(
    await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}/ignore-regions/${regionId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    templateId
  );
};

export const deleteIgnoreRegionApi = async (templateId: string, regionId: string) =>
  mapTemplateBundleResponse(
    await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}/ignore-regions/${regionId}`, {
      method: "DELETE",
    }),
    templateId
  );

export const convertTemplateRequestToTemplate = async (requestId: string) => {
  const response = await fetch(`${ADMIN_API_BASE_URL}/admin/template-requests/${requestId}/convert-to-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Template request conversion failed with ${response.status}`);
  }

  const json = await response.json();
  const result = json?.data as ConvertTemplateResponse;
  const templateId = result?.template_id || result?.converted_template_id;
  if (!templateId) {
    throw new Error("Template request conversion did not return a template id");
  }
  return {
    templateId,
    status: result.status,
    createdRecords: result.created_records,
  };
};
