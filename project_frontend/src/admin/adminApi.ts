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
