import { AdminTemplateRequest } from "../types/ocr";

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
  user_note?: string | null;
  roi: {
    page_number: number;
    x_ratio: number;
    y_ratio: number;
    width_ratio: number;
    height_ratio: number;
  };
}

export interface ApiTemplateRequest {
  id: string;
  request_title: string;
  document_type?: string | null;
  request_mode: "image_only" | "image_with_roi";
  status: AdminTemplateRequest["status"];
  user_note?: string | null;
  admin_note?: string | null;
  converted_template_id?: string | null;
  page_count: number;
  created_at?: string | null;
  updated_at?: string | null;
  pages?: ApiTemplateRequestPage[];
  requested_fields?: ApiRequestedField[];
}

export const mapApiRequest = (request: ApiTemplateRequest): AdminTemplateRequest => ({
  id: request.id,
  requestTitle: request.request_title,
  documentType: request.document_type || undefined,
  requestMode: request.request_mode,
  status: request.status,
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
