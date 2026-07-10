import {
  AdminTemplateRequest,
  IgnoreRegion,
  Template,
  TemplateField,
  TemplatePage,
} from "../types/ocr";

export type AdminStatusFilter = "all" | "draft" | "active" | "nonactive";

export interface AdminDashboardSummary {
  pendingRequests: number;
  draftTemplates: number;
  approvedTemplates: number;
  rejectedTemplates: number;
}

export interface AdminDataSnapshot {
  requests: AdminTemplateRequest[];
  templates: Template[];
  pages: TemplatePage[];
  fields: TemplateField[];
  ignoreRegions: IgnoreRegion[];
}
