import {
  AdminTemplateRequest,
  IgnoreRegion,
  RequestedField,
  Template,
  TemplateField,
  TemplatePage,
  TemplateStatus,
} from "../types/ocr";

export const samplePage =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='750' height='1000' viewBox='0 0 750 1000'%3E%3Crect width='750' height='1000' fill='%23ffffff'/%3E%3Crect x='70' y='70' width='610' height='90' rx='8' fill='%23e2e8f0'/%3E%3Crect x='70' y='210' width='270' height='34' rx='5' fill='%23cbd5e1'/%3E%3Crect x='70' y='275' width='610' height='22' rx='4' fill='%23e2e8f0'/%3E%3Crect x='70' y='325' width='610' height='22' rx='4' fill='%23e2e8f0'/%3E%3Crect x='70' y='420' width='610' height='220' rx='8' fill='%23f1f5f9' stroke='%23cbd5e1'/%3E%3Crect x='95' y='455' width='560' height='20' rx='4' fill='%23cbd5e1'/%3E%3Crect x='95' y='505' width='560' height='20' rx='4' fill='%23cbd5e1'/%3E%3Crect x='95' y='555' width='560' height='20' rx='4' fill='%23cbd5e1'/%3E%3Ctext x='375' y='910' text-anchor='middle' font-family='Arial' font-size='24' fill='%2364758b'%3ETemplate Sample Page%3C/text%3E%3C/svg%3E";

export const templateStatuses: TemplateStatus[] = [
  "draft",
  "pending_review",
  "embedding_generated",
  "testing",
  "approved",
  "rejected",
  "disabled",
];

export const defaultRoi = (pageNumber: number) => ({
  pageNumber,
  xRatio: 0.1,
  yRatio: 0.2,
  widthRatio: 0.32,
  heightRatio: 0.06,
});

export const mockRequests: AdminTemplateRequest[] = [
  {
    id: "req_001",
    requestTitle: "Supplier invoice layout",
    documentType: "invoice",
    requestMode: "image_with_roi",
    status: "submitted",
    userNote: "Please create a template for recurring supplier invoices.",
    pageCount: 2,
    pages: [
      { id: "req_page_001", templateRequestId: "req_001", pageNumber: 1, sampleImageUrl: samplePage },
      { id: "req_page_002", templateRequestId: "req_001", pageNumber: 2, sampleImageUrl: samplePage },
    ],
    requestedFields: [
      {
        id: "requested_field_001",
        fieldName: "invoice_no",
        displayLabel: "Invoice No",
        roi: { pageNumber: 1, xRatio: 0.12, yRatio: 0.22, widthRatio: 0.24, heightRatio: 0.04 },
      },
      {
        id: "requested_field_002",
        fieldName: "total_amount",
        displayLabel: "Total Amount",
        roi: { pageNumber: 2, xRatio: 0.56, yRatio: 0.68, widthRatio: 0.28, heightRatio: 0.05 },
      },
    ],
  },
  {
    id: "req_002",
    requestTitle: "Certificate template",
    documentType: "certificate",
    requestMode: "image_only",
    status: "submitted",
    userNote: "Image only request. Admin should define fields manually.",
    pageCount: 1,
    pages: [{ id: "req_page_003", templateRequestId: "req_002", pageNumber: 1, sampleImageUrl: samplePage }],
    requestedFields: [],
  },
];

export const initialTemplates: Template[] = [
  {
    id: "tpl_001",
    name: "Generic Invoice",
    documentType: "invoice",
    category: "finance",
    status: "draft",
    version: 1,
    pageCount: 1,
    similarityThreshold: 0.75,
    finalConfidenceThreshold: 0.8,
  },
  {
    id: "tpl_002",
    name: "Approved Receipt",
    documentType: "receipt",
    category: "finance",
    status: "approved",
    version: 1,
    pageCount: 1,
    similarityThreshold: 0.78,
    finalConfidenceThreshold: 0.84,
  },
];

export const initialPages: TemplatePage[] = [
  {
    id: "tpl_page_001",
    templateId: "tpl_001",
    pageNumber: 1,
    pageName: "Page 1",
    sampleImageUrl: samplePage,
    normalizedImageUrl: samplePage,
    similarityThreshold: 0.75,
    finalConfidenceThreshold: 0.8,
  },
  {
    id: "tpl_page_002",
    templateId: "tpl_002",
    pageNumber: 1,
    pageName: "Page 1",
    sampleImageUrl: samplePage,
    normalizedImageUrl: samplePage,
    qdrantPointId: "qdrant_receipt_page_1",
    similarityThreshold: 0.78,
    finalConfidenceThreshold: 0.84,
  },
];

export const initialFields: TemplateField[] = [
  {
    id: "tpl_field_001",
    templateId: "tpl_001",
    templatePageId: "tpl_page_001",
    pageNumber: 1,
    fieldName: "invoice_no",
    displayLabel: "Invoice No",
    roi: { pageNumber: 1, xRatio: 0.12, yRatio: 0.22, widthRatio: 0.24, heightRatio: 0.04 },
    dataType: "string",
    userSelectable: true,
    defaultSelected: true,
    useForVerification: true,
    expectedText: "",
    matchType: "contains",
    requiredForVerification: false,
    extractionMethod: "fixed_roi",
    sortOrder: 1,
  },
];

export const initialIgnoreRegions: IgnoreRegion[] = [
  {
    id: "ignore_001",
    templateId: "tpl_001",
    templatePageId: "tpl_page_001",
    pageNumber: 1,
    fieldName: "personal_data_block",
    roi: { pageNumber: 1, xRatio: 0.52, yRatio: 0.26, widthRatio: 0.3, heightRatio: 0.08 },
  },
];

export const fieldFromRequestedField = (
  requestedField: RequestedField,
  templateId: string,
  pageId: string,
  index: number
): TemplateField => ({
  id: `tpl_field_${Date.now()}_${index}`,
  templateId,
  templatePageId: pageId,
  pageNumber: requestedField.roi.pageNumber,
  fieldName: requestedField.fieldName,
  displayLabel: requestedField.displayLabel,
  roi: requestedField.roi,
  dataType: "string",
  userSelectable: true,
  defaultSelected: false,
  useForVerification: false,
  expectedText: "",
  matchType: "",
  requiredForVerification: false,
  extractionMethod: "fixed_roi",
  sortOrder: index + 1,
});
