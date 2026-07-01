import {
  AdminTemplateRequest,
  IgnoreRegion,
  Template,
  TemplateField,
  TemplatePage,
  TemplateStatus,
} from "../types/ocr";

export type AdminStatusFilter = TemplateStatus | "all";

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
