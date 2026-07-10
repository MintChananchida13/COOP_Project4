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
  verification_weight?: number | null;
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
  retrievalScore?: number | null;
  verificationScore?: number | null;
  textAnchorScore?: number | null;
  imageAnchorScore?: number | null;
  verificationPassed?: boolean | null;
  finalScore?: number | null;
  finalPassed?: boolean | null;
  decisionReason?: string | null;
  decisionPath?: string | null;
  requiredPassed?: boolean | null;
  requiredFailedFields?: Record<string, unknown>[];
  finalConfidenceThreshold?: number | null;
  verification?: Record<string, unknown>;
  averageScore?: number | null;
  matchedPages?: number | null;
  templateName?: string | null;
  templateStatus?: string | null;
  pageCount?: number | null;
  fieldCount?: number | null;
  modelName?: string | null;
  vectorStoreEngine?: string | null;
  pageIndex?: number | null;
  alignmentStatus?: "skipped" | "aligned" | "fallback" | "failed" | null;
  alignment?: Record<string, unknown>;
  alignmentDebug?: Record<string, unknown>;
  alignmentScore?: number | null;
  alignmentPassed?: boolean | null;
  alignmentFallbackUsed?: boolean | null;
  alignmentReason?: string | null;
  normalizedVerificationScore?: number | null;
  alignedVerificationScore?: number | null;
  verificationSourceUsed?: "normalized" | "aligned" | null;
  beforeAlignmentVerification?: number | null;
  afterAlignmentVerification?: number | null;
  verificationImprovement?: number | null;
  alignmentMatchImagePreviewUrl?: string | null;
  alignedImagePreviewUrl?: string | null;
  normalizedImagePreviewUrl?: string | null;
  metadata?: Record<string, unknown>;
}

export interface DetectionPageResult {
  pageIndex: number;
  matched: boolean;
  bestCandidate?: DetectionCandidate | null;
  candidates: DetectionCandidate[];
  imagePreviewDataUrl?: string | null;
  originalImagePreviewUrl?: string | null;
  normalizedImagePreviewUrl?: string | null;
  originalImagePath?: string | null;
  normalizedImagePath?: string | null;
  normalization?: Record<string, unknown>;
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

export interface PrepublishCandidate {
  rank: number;
  templateId: string;
  templateName?: string | null;
  templateStatus?: string | null;
  vectorId?: string | null;
  globalScore: number;
  textAnchorScore: number;
  imageAnchorScore: number;
  verificationScore: number;
  finalScore: number;
  alignmentStatus: string;
  decision: string;
  finalPassed: boolean;
  requiredPassed?: boolean | null;
  requiredFailedFields?: Record<string, unknown>[];
  isCurrentDraft?: boolean;
  source?: "draft" | "published" | string;
  sourceLabel?: string | null;
  pageCount?: number | null;
  fieldCount?: number | null;
  verification?: Record<string, unknown>;
  verificationDetails?: Record<string, unknown>[];
}

export interface PrepublishSimulationResult {
  template: Template;
  draftSummary: {
    templateName?: string | null;
    templateId: string;
    status: string;
    pageCount: number;
    extractionFieldCount: number;
    textAnchorCount: number;
    imageAnchorCount: number;
    similarityThreshold?: number | null;
    finalConfidenceThreshold?: number | null;
  };
  temporaryEmbedding: {
    status: string;
    engine: string;
    version: string;
    modelName: string;
    embeddingDimension: number;
    inputCount: number;
    generatedAt?: string;
    persisted: boolean;
    note?: string;
  };
  candidates: PrepublishCandidate[];
  verificationAnchorResults: Record<string, unknown>[];
  separationAnalysis: {
    top1Score: number;
    top2Score?: number | null;
    status: "ready_to_publish" | "needs_review" | "conflict_detected" | "not_ready" | string;
    simulationPassed: boolean;
    conflictTemplates: PrepublishCandidate[];
    message?: string;
  };
}

export interface PrepublishDetectionTestResult {
  testId: string;
  templateId: string;
  matched: boolean;
  selectedTemplate?: PrepublishCandidate | null;
  selectedTemplateType?: string | null;
  finalConfidence: number;
  decisionReason?: string | null;
  draftTemplateRank?: number | null;
  passed: boolean;
  warning: boolean;
  candidates: PrepublishCandidate[];
  separationResult: {
    draftTemplateRank?: number | null;
    draftFinalScore: number;
    closestPublishedTemplate?: string | null;
    closestPublishedScore?: number | null;
    conflictLevel: string;
    recommendation: string;
  };
  debug?: Record<string, unknown>;
}

export interface TemplateStepTestItem {
  fieldId?: string;
  anchorId?: string;
  fieldName?: string | null;
  displayLabel?: string | null;
  pageNumber?: number | null;
  extractionMethod?: string | null;
  ocrText?: string | null;
  actualText?: string | null;
  expectedText?: string | null;
  confidence?: number | null;
  score?: number | null;
  fieldScore?: number | null;
  passed: boolean;
  status?: string | null;
  failureReason?: string | null;
  anchorType?: string | null;
  verificationMethod?: string | null;
  embeddingId?: string | null;
  dinoSimilarityScore?: number | null;
  referenceCropPreviewDataUrl?: string | null;
  currentCropPreviewDataUrl?: string | null;
  referenceCropPreviewUrl?: string | null;
  currentCropPreviewUrl?: string | null;
}

export interface TemplateStepTestResult {
  templateId: string;
  status: string;
  passed?: boolean;
  score?: number | null;
  testedCount: number;
  passedCount: number;
  failedCount: number;
  fields?: TemplateStepTestItem[];
  anchors?: TemplateStepTestItem[];
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
    status === "nonactive" ||
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
  retrievalScore: typeof candidate.retrieval_score === "number" ? candidate.retrieval_score : null,
  verificationScore: typeof candidate.verification_score === "number" ? candidate.verification_score : null,
  textAnchorScore: typeof candidate.text_anchor_score === "number" ? candidate.text_anchor_score : null,
  imageAnchorScore: typeof candidate.image_anchor_score === "number" ? candidate.image_anchor_score : null,
  verificationPassed: typeof candidate.verification_passed === "boolean" ? candidate.verification_passed : null,
  finalScore: typeof candidate.final_score === "number" ? candidate.final_score : null,
  finalPassed: typeof candidate.final_passed === "boolean" ? candidate.final_passed : null,
  decisionReason: (candidate.decision_reason as string | null | undefined) ?? null,
  decisionPath: (candidate.decision_path as string | null | undefined) ?? null,
  requiredPassed: typeof candidate.required_passed === "boolean" ? candidate.required_passed : null,
  requiredFailedFields: Array.isArray(candidate.required_failed_fields)
    ? (candidate.required_failed_fields as Record<string, unknown>[])
    : [],
  finalConfidenceThreshold: typeof candidate.final_confidence_threshold === "number" ? candidate.final_confidence_threshold : null,
  verification: (candidate.verification as Record<string, unknown> | undefined) || undefined,
  averageScore: typeof candidate.average_score === "number" ? candidate.average_score : null,
  matchedPages: typeof candidate.matched_pages === "number" ? candidate.matched_pages : null,
  templateName: (candidate.template_name as string | null | undefined) ?? null,
  templateStatus: (candidate.template_status as string | null | undefined) ?? null,
  pageCount: typeof candidate.page_count === "number" ? candidate.page_count : null,
  fieldCount: typeof candidate.field_count === "number" ? candidate.field_count : null,
  modelName: (candidate.model_name as string | null | undefined) ?? null,
  vectorStoreEngine: (candidate.vector_store_engine as string | null | undefined) ?? null,
  pageIndex: typeof candidate.page_index === "number" ? candidate.page_index : null,
  alignmentStatus:
    candidate.alignment_status === "skipped" ||
    candidate.alignment_status === "fallback" ||
    candidate.alignment_status === "failed" ||
    candidate.alignment_status === "aligned"
      ? candidate.alignment_status
      : null,
  alignment: (candidate.alignment as Record<string, unknown> | undefined) || undefined,
  alignmentDebug: (candidate.alignment_debug as Record<string, unknown> | undefined) || undefined,
  alignmentScore: typeof candidate.alignment_score === "number" ? candidate.alignment_score : null,
  alignmentPassed: typeof candidate.alignment_passed === "boolean" ? candidate.alignment_passed : null,
  alignmentFallbackUsed: typeof candidate.alignment_fallback_used === "boolean" ? candidate.alignment_fallback_used : null,
  alignmentReason: (candidate.alignment_reason as string | null | undefined) ?? null,
  normalizedVerificationScore: typeof candidate.normalized_verification_score === "number" ? candidate.normalized_verification_score : null,
  alignedVerificationScore: typeof candidate.aligned_verification_score === "number" ? candidate.aligned_verification_score : null,
  verificationSourceUsed:
    candidate.verification_source_used === "normalized" || candidate.verification_source_used === "aligned"
      ? candidate.verification_source_used
      : null,
  beforeAlignmentVerification: typeof candidate.before_alignment_verification === "number" ? candidate.before_alignment_verification : null,
  afterAlignmentVerification: typeof candidate.after_alignment_verification === "number" ? candidate.after_alignment_verification : null,
  verificationImprovement: typeof candidate.verification_improvement === "number" ? candidate.verification_improvement : null,
  alignmentMatchImagePreviewUrl: (candidate.alignment_match_image_preview_url as string | null | undefined) ?? null,
  alignedImagePreviewUrl: (candidate.aligned_image_preview_url as string | null | undefined) ?? null,
  normalizedImagePreviewUrl: (candidate.normalized_image_preview_url as string | null | undefined) ?? null,
  metadata: (candidate.metadata as Record<string, unknown> | undefined) || {},
});

const mapDetectionPage = (page: Record<string, unknown>): DetectionPageResult => ({
  pageIndex: typeof page.page_index === "number" ? page.page_index : 1,
  matched: Boolean(page.matched),
  bestCandidate: page.best_candidate ? mapDetectionCandidate(page.best_candidate as Record<string, unknown>) : null,
  candidates: Array.isArray(page.candidates) ? (page.candidates as Record<string, unknown>[]).map(mapDetectionCandidate) : [],
  imagePreviewDataUrl: (page.image_preview_data_url as string | null | undefined) ?? null,
  originalImagePreviewUrl: (page.original_image_preview_url as string | null | undefined) ?? null,
  normalizedImagePreviewUrl: (page.normalized_image_preview_url as string | null | undefined) ?? null,
  originalImagePath: (page.original_image_path as string | null | undefined) ?? null,
  normalizedImagePath: (page.normalized_image_path as string | null | undefined) ?? null,
  normalization: (page.normalization as Record<string, unknown> | undefined) || {},
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
  verificationWeight: field.verification_weight ?? undefined,
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

export const deleteTemplateApi = async (templateId: string) => {
  const response = await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}`, {
    method: "DELETE",
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = json?.detail || json?.error?.message || json?.error || `Delete failed with ${response.status}`;
    throw new Error(typeof detail === "string" ? detail : `Delete failed with ${response.status}`);
  }
  return json?.data as {
    id: string;
    deleted: boolean;
    deleted_records?: {
      templates: number;
      template_pages: number;
      template_fields: number;
      ignore_regions: number;
      embedding_jobs: number;
    };
  };
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

const mapPrepublishCandidate = (candidate: Record<string, unknown>): PrepublishCandidate => ({
  rank: Number(candidate.rank || 0),
  templateId: String(candidate.template_id || ""),
  templateName: (candidate.template_name as string | null | undefined) ?? null,
  templateStatus: (candidate.template_status as string | null | undefined) ?? null,
  vectorId: (candidate.vector_id as string | null | undefined) ?? null,
  globalScore: Number(candidate.global_score || 0),
  textAnchorScore: Number(candidate.text_anchor_score || 0),
  imageAnchorScore: Number(candidate.image_anchor_score || 0),
  verificationScore: Number(candidate.verification_score || 0),
  finalScore: Number(candidate.final_score || 0),
  alignmentStatus: String(candidate.alignment_status || "skipped"),
  decision: String(candidate.decision || ""),
  finalPassed: Boolean(candidate.final_passed),
  requiredPassed: typeof candidate.required_passed === "boolean" ? candidate.required_passed : null,
  requiredFailedFields: Array.isArray(candidate.required_failed_fields)
    ? (candidate.required_failed_fields as Record<string, unknown>[])
    : [],
  isCurrentDraft: Boolean(candidate.is_current_draft),
  source: (candidate.source as string | undefined) || (candidate.is_current_draft ? "draft" : "published"),
  sourceLabel: (candidate.source_label as string | null | undefined) ?? null,
  pageCount: typeof candidate.page_count === "number" ? candidate.page_count : null,
  fieldCount: typeof candidate.field_count === "number" ? candidate.field_count : null,
  verification: (candidate.verification as Record<string, unknown> | undefined) || {},
  verificationDetails: Array.isArray(candidate.verification_details)
    ? (candidate.verification_details as Record<string, unknown>[])
    : [],
});

export const runPrepublishSimulation = async (templateId: string): Promise<PrepublishSimulationResult> => {
  const response = await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}/prepublish-simulation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = json?.detail || json?.error?.message || json?.error || `Pre-publish simulation failed with ${response.status}`;
    throw new Error(typeof detail === "string" ? detail : `Pre-publish simulation failed with ${response.status}`);
  }

  const data = json?.data as Record<string, unknown>;
  const summary = (data?.draft_summary as Record<string, unknown> | undefined) || {};
  const temp = (data?.temporary_embedding as Record<string, unknown> | undefined) || {};
  const separation = (data?.separation_analysis as Record<string, unknown> | undefined) || {};
  const candidates = Array.isArray(data?.candidates)
    ? (data.candidates as Record<string, unknown>[]).map(mapPrepublishCandidate)
    : [];
  const conflictTemplates = Array.isArray(separation.conflict_templates)
    ? (separation.conflict_templates as Record<string, unknown>[]).map(mapPrepublishCandidate)
    : [];

  return {
    template: mapApiTemplate(data.template as ApiTemplate),
    draftSummary: {
      templateName: (summary.template_name as string | null | undefined) ?? null,
      templateId: String(summary.template_id || templateId),
      status: String(summary.status || "draft"),
      pageCount: Number(summary.page_count || 0),
      extractionFieldCount: Number(summary.extraction_field_count || 0),
      textAnchorCount: Number(summary.text_anchor_count || 0),
      imageAnchorCount: Number(summary.image_anchor_count || 0),
      similarityThreshold: typeof summary.similarity_threshold === "number" ? summary.similarity_threshold : null,
      finalConfidenceThreshold: typeof summary.final_confidence_threshold === "number" ? summary.final_confidence_threshold : null,
    },
    temporaryEmbedding: {
      status: String(temp.status || "not_generated"),
      engine: String(temp.engine || "stub"),
      version: String(temp.version || ""),
      modelName: String(temp.model_name || ""),
      embeddingDimension: Number(temp.embedding_dimension || 0),
      inputCount: Number(temp.input_count || 0),
      generatedAt: (temp.generated_at as string | undefined) || undefined,
      persisted: Boolean(temp.persisted),
      note: (temp.note as string | undefined) || undefined,
    },
    candidates,
    verificationAnchorResults: Array.isArray(data?.verification_anchor_results)
      ? (data.verification_anchor_results as Record<string, unknown>[])
      : [],
    separationAnalysis: {
      top1Score: Number(separation.top1_score || 0),
      top2Score: typeof separation.top2_score === "number" ? separation.top2_score : null,
      status: String(separation.status || "not_ready"),
      simulationPassed: Boolean(separation.simulation_passed),
      conflictTemplates,
      message: (separation.message as string | undefined) || undefined,
    },
  };
};

export const runPrepublishDetectionTest = async (templateId: string, file: File): Promise<PrepublishDetectionTestResult> => {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}/prepublish-detection-test`, {
    method: "POST",
    body: formData,
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = json?.detail || json?.error?.message || json?.error || `Pre-publish detection test failed with ${response.status}`;
    throw new Error(typeof detail === "string" ? detail : `Pre-publish detection test failed with ${response.status}`);
  }

  const data = (json?.data as Record<string, unknown> | undefined) || {};
  const candidates = Array.isArray(data.candidates)
    ? (data.candidates as Record<string, unknown>[]).map(mapPrepublishCandidate)
    : [];
  const separation = (data.separation_result as Record<string, unknown> | undefined) || {};
  return {
    testId: String(data.test_id || ""),
    templateId: String(data.template_id || templateId),
    matched: Boolean(data.matched),
    selectedTemplate: data.selected_template ? mapPrepublishCandidate(data.selected_template as Record<string, unknown>) : null,
    selectedTemplateType: (data.selected_template_type as string | null | undefined) ?? null,
    finalConfidence: Number(data.final_confidence || 0),
    decisionReason: (data.decision_reason as string | null | undefined) ?? null,
    draftTemplateRank: typeof data.draft_template_rank === "number" ? data.draft_template_rank : null,
    passed: Boolean(data.passed),
    warning: Boolean(data.warning),
    candidates,
    separationResult: {
      draftTemplateRank: typeof separation.draft_template_rank === "number" ? separation.draft_template_rank : null,
      draftFinalScore: Number(separation.draft_final_score || 0),
      closestPublishedTemplate: (separation.closest_published_template as string | null | undefined) ?? null,
      closestPublishedScore: typeof separation.closest_published_score === "number" ? separation.closest_published_score : null,
      conflictLevel: String(separation.conflict_level || "not_ready"),
      recommendation: String(separation.recommendation || ""),
    },
    debug: (data.debug as Record<string, unknown> | undefined) || {},
  };
};

export const confirmTemplatePublish = async (templateId: string) => {
  const response = await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}/confirm-publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  return mapEmbeddingJobMutationResponse(response);
};

const mapTemplateStepTestItem = (item: Record<string, unknown>): TemplateStepTestItem => ({
  fieldId: (item.field_id as string | undefined) || undefined,
  anchorId: (item.anchor_id as string | undefined) || undefined,
  fieldName: (item.field_name as string | null | undefined) ?? null,
  displayLabel: (item.display_label as string | null | undefined) ?? null,
  pageNumber: typeof item.page_number === "number" ? item.page_number : null,
  extractionMethod: (item.extraction_method as string | null | undefined) ?? null,
  ocrText: (item.ocr_text as string | null | undefined) ?? null,
  actualText: (item.actual_text as string | null | undefined) ?? null,
  expectedText: (item.expected_text as string | null | undefined) ?? null,
  confidence: typeof item.confidence === "number" ? item.confidence : typeof item.ocr_confidence === "number" ? item.ocr_confidence : null,
  score: typeof item.score === "number" ? item.score : null,
  fieldScore: typeof item.field_score === "number" ? item.field_score : null,
  passed: Boolean(item.passed),
  status: (item.status as string | null | undefined) ?? null,
  failureReason: (item.failure_reason as string | null | undefined) ?? null,
  anchorType: (item.anchor_type as string | null | undefined) ?? null,
  verificationMethod: (item.verification_method as string | null | undefined) ?? null,
  embeddingId: (item.embedding_id as string | null | undefined) ?? null,
  dinoSimilarityScore: typeof item.dino_similarity_score === "number" ? item.dino_similarity_score : null,
  referenceCropPreviewDataUrl: (item.reference_crop_preview_data_url as string | null | undefined) ?? null,
  currentCropPreviewDataUrl: (item.current_crop_preview_data_url as string | null | undefined) ?? null,
  referenceCropPreviewUrl: (item.reference_crop_preview_url as string | null | undefined) ?? null,
  currentCropPreviewUrl: (item.current_crop_preview_url as string | null | undefined) ?? null,
});

const mapTemplateStepTestResult = (data: Record<string, unknown>): TemplateStepTestResult => ({
  templateId: String(data.template_id || ""),
  status: String(data.status || ""),
  passed: typeof data.passed === "boolean" ? data.passed : undefined,
  score: typeof data.score === "number" ? data.score : null,
  testedCount: Number(data.tested_count || 0),
  passedCount: Number(data.passed_count || 0),
  failedCount: Number(data.failed_count || 0),
  fields: Array.isArray(data.fields) ? (data.fields as Record<string, unknown>[]).map(mapTemplateStepTestItem) : undefined,
  anchors: Array.isArray(data.anchors) ? (data.anchors as Record<string, unknown>[]).map(mapTemplateStepTestItem) : undefined,
});

const runTemplateStepTest = async (templateId: string, path: "test-extraction" | "test-verification") => {
  const response = await fetch(`${ADMIN_API_BASE_URL}/admin/templates/${templateId}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = json?.detail || json?.error?.message || json?.error || `Template step test failed with ${response.status}`;
    throw new Error(typeof detail === "string" ? detail : `Template step test failed with ${response.status}`);
  }
  return mapTemplateStepTestResult((json?.data as Record<string, unknown> | undefined) || {});
};

export const testTemplateExtractionFields = (templateId: string) => runTemplateStepTest(templateId, "test-extraction");

export const testTemplateVerificationAnchors = (templateId: string) => runTemplateStepTest(templateId, "test-verification");

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
  verification_weight: field.verificationWeight ?? 1,
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
    verification_weight: patch.verificationWeight,
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
