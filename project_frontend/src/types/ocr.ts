export type RoiDataType = 'string' | 'text' | 'number' | 'date' | 'address' | 'currency' | 'table' | 'image';

export interface ROI {
  id: number;
  fieldName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  confidence?: number;
  pageIndex?: number;
  type?: 'text' | 'table' | 'image';
  dataType?: RoiDataType;
  extractionMethod?: 'ocr_text' | 'ocr_table' | 'extract_image';
  role?: 'data_extraction';
  weight?: number;
  points?: { x: number; y: number }[];
  enabled?: boolean;
}

export interface OCRResult {
  id: number;
  fieldName: string;
  bbox: number[];
  extractedText: string;
  originalText?: string;
  confidence: number;
  saved_path?: string;
  type?: 'text' | 'table' | 'image';
  dataType?: RoiDataType;
  role?: 'data_extraction';
  weight?: number;
  points?: { x: number; y: number }[];
}

export type TemplateRequestMode = 'image_only' | 'image_with_roi';

export interface RoiRatio {
  pageNumber: number;
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
}

export interface RequestedField {
  id: string;
  fieldName: string;
  displayLabel: string;
  roi: RoiRatio;
  dataType?: RoiDataType;
  extractionMethod?: string;
  userNote?: string;
}

export interface TemplateRequestDraft {
  requestTitle: string;
  documentType?: string;
  requestMode: TemplateRequestMode;
  pageCount: number;
  userNote?: string;
  requestedFields: RequestedField[];
}

export type TemplateStatus =
  | 'draft'
  | 'validated'
  | 'embedding_pending'
  | 'active'
  | 'pending_review'
  | 'embedding_generated'
  | 'testing'
  | 'approved'
  | 'rejected'
  | 'disabled';

export interface Template {
  id: string;
  name: string;
  documentType?: string;
  category?: string;
  status: TemplateStatus;
  version: number;
  pageCount: number;
  similarityThreshold: number;
  finalConfidenceThreshold: number;
  rejectionReason?: string;
}

export interface TemplatePage {
  id: string;
  templateId: string;
  pageNumber: number;
  pageName?: string;
  sampleImageUrl?: string;
  normalizedImageUrl?: string;
  qdrantPointId?: string;
  similarityThreshold: number;
  finalConfidenceThreshold: number;
}

export interface TemplateField {
  id: string;
  templateId: string;
  templatePageId: string;
  pageNumber: number;
  fieldName: string;
  displayLabel: string;
  roi: RoiRatio;
  dataType?: RoiDataType;
  userSelectable: boolean;
  defaultSelected: boolean;
  useForVerification: boolean;
  expectedText?: string;
  matchType?: string;
  requiredForVerification: boolean;
  extractionMethod: string;
  roiPadding?: number;
  sortOrder: number;
}

export interface IgnoreRegion {
  id: string;
  templateId: string;
  templatePageId: string;
  pageNumber: number;
  fieldName: string;
  roi: RoiRatio;
}

export type TemplateRequestStatus = 'draft' | 'submitted' | 'in_review' | 'converted' | 'rejected';

export interface TemplateRequestPage {
  id: string;
  templateRequestId: string;
  pageNumber: number;
  sampleImageUrl?: string;
}

export interface AdminTemplateRequest {
  id: string;
  requestTitle: string;
  documentType?: string;
  requestMode: TemplateRequestMode;
  status: TemplateRequestStatus;
  userNote?: string;
  adminNote?: string;
  convertedTemplateId?: string;
  pageCount: number;
  pages: TemplateRequestPage[];
  requestedFields: RequestedField[];
  createdAt?: string;
  updatedAt?: string;
}
