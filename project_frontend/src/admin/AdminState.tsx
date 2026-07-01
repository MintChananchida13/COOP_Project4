"use client";

import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { AdminTemplateRequest, IgnoreRegion, Template, TemplateField, TemplatePage } from "../types/ocr";
import { AdminDashboardSummary } from "./adminTypes";
import {
  defaultRoi,
  fieldFromRequestedField,
  initialFields,
  initialIgnoreRegions,
  initialPages,
  initialTemplates,
  mockRequests,
  samplePage,
} from "./adminMockData";

const API_BASE_URL = "http://localhost:8000";

interface ApiTemplateRequestPage {
  id: string;
  template_request_id: string;
  page_number: number;
  sample_image_url?: string | null;
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

interface ApiTemplateRequest {
  id: string;
  request_title: string;
  document_type?: string | null;
  request_mode: "image_only" | "image_with_roi";
  status: AdminTemplateRequest["status"];
  user_note?: string | null;
  admin_note?: string | null;
  converted_template_id?: string | null;
  page_count: number;
  pages?: ApiTemplateRequestPage[];
  requested_fields?: ApiRequestedField[];
}

const mapApiRequest = (request: ApiTemplateRequest): AdminTemplateRequest => ({
  id: request.id,
  requestTitle: request.request_title,
  documentType: request.document_type || undefined,
  requestMode: request.request_mode,
  status: request.status,
  userNote: request.user_note || undefined,
  adminNote: request.admin_note || undefined,
  convertedTemplateId: request.converted_template_id || undefined,
  pageCount: request.page_count,
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

interface AdminStateValue {
  requests: AdminTemplateRequest[];
  templates: Template[];
  pages: TemplatePage[];
  fields: TemplateField[];
  ignoreRegions: IgnoreRegion[];
  dashboard: AdminDashboardSummary;
  rejectRequest: (requestId: string, adminNote: string) => void;
  convertRequestToTemplate: (requestId: string, adminNote: string) => string | null;
  updateTemplate: (templateId: string, patch: Partial<Template>) => void;
  addPage: (templateId: string) => void;
  removePage: (templateId: string, pageId: string) => void;
  addField: (templateId: string, pageId: string) => void;
  updateField: (fieldId: string, patch: Partial<TemplateField>) => void;
  deleteField: (fieldId: string) => void;
  addIgnoreRegion: (templateId: string, pageId: string) => void;
  updateIgnoreRegion: (regionId: string, patch: Partial<IgnoreRegion>) => void;
  deleteIgnoreRegion: (regionId: string) => void;
  generateEmbedding: (templateId: string, pageId: string) => void;
  markTesting: (templateId: string) => void;
}

const AdminStateContext = createContext<AdminStateValue | null>(null);

export function AdminStateProvider({ children }: { children: ReactNode }) {
  const [requests, setRequests] = useState<AdminTemplateRequest[]>(mockRequests);
  const [templates, setTemplates] = useState<Template[]>(initialTemplates);
  const [pages, setPages] = useState<TemplatePage[]>(initialPages);
  const [fields, setFields] = useState<TemplateField[]>(initialFields);
  const [ignoreRegions, setIgnoreRegions] = useState<IgnoreRegion[]>(initialIgnoreRegions);

  useEffect(() => {
    let cancelled = false;

    const loadTemplateRequests = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/template-requests`);
        if (!response.ok) {
          throw new Error(`Template request load failed with ${response.status}`);
        }
        const json = await response.json();
        const apiRequests = json?.data?.template_requests as ApiTemplateRequest[] | undefined;
        if (!cancelled && apiRequests && apiRequests.length > 0) {
          setRequests(apiRequests.map(mapApiRequest));
        }
      } catch (error) {
        console.warn("Using mock template requests because backend is unavailable.", error);
      }
    };

    loadTemplateRequests();

    return () => {
      cancelled = true;
    };
  }, []);

  const dashboard = useMemo(
    () => ({
      pendingRequests: requests.filter((request) => request.status === "submitted" || request.status === "in_review").length,
      draftTemplates: templates.filter((template) => template.status === "draft").length,
      approvedTemplates: templates.filter((template) => template.status === "approved").length,
      rejectedTemplates: templates.filter((template) => template.status === "rejected").length,
    }),
    [requests, templates]
  );

  const rejectRequest = (requestId: string, adminNote: string) => {
    setRequests((prev) =>
      prev.map((request) =>
        request.id === requestId ? { ...request, status: "rejected", adminNote: adminNote || "Rejected by admin." } : request
      )
    );
  };

  const convertRequestToTemplate = (requestId: string, adminNote: string) => {
    const selectedRequest = requests.find((request) => request.id === requestId);
    if (!selectedRequest) return null;

    const templateId = `tpl_${Date.now()}`;
    const newTemplate: Template = {
      id: templateId,
      name: selectedRequest.requestTitle,
      documentType: selectedRequest.documentType,
      category: "",
      status: "draft",
      version: 1,
      pageCount: selectedRequest.pageCount,
      similarityThreshold: 0.75,
      finalConfidenceThreshold: 0.8,
    };
    const newPages: TemplatePage[] = selectedRequest.pages.map((page) => ({
      id: `tpl_page_${Date.now()}_${page.pageNumber}`,
      templateId,
      pageNumber: page.pageNumber,
      pageName: `Page ${page.pageNumber}`,
      sampleImageUrl: page.sampleImageUrl || samplePage,
      normalizedImageUrl: page.sampleImageUrl || samplePage,
      similarityThreshold: 0.75,
      finalConfidenceThreshold: 0.8,
    }));
    const newFields = selectedRequest.requestedFields.map((field, index) => {
      const page = newPages.find((item) => item.pageNumber === field.roi.pageNumber) || newPages[0];
      return fieldFromRequestedField(field, templateId, page.id, index);
    });

    setTemplates((prev) => [newTemplate, ...prev]);
    setPages((prev) => [...newPages, ...prev]);
    setFields((prev) => [...newFields, ...prev]);
    setRequests((prev) =>
      prev.map((request) =>
        request.id === requestId ? { ...request, status: "converted", convertedTemplateId: templateId, adminNote } : request
      )
    );

    return templateId;
  };

  const updateTemplate = (templateId: string, patch: Partial<Template>) => {
    setTemplates((prev) => prev.map((template) => (template.id === templateId ? { ...template, ...patch } : template)));
  };

  const addPage = (templateId: string) => {
    const templatePages = pages.filter((page) => page.templateId === templateId);
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    const nextPageNumber = templatePages.length + 1;
    setPages((prev) => [
      ...prev,
      {
        id: `tpl_page_${Date.now()}`,
        templateId,
        pageNumber: nextPageNumber,
        pageName: `Page ${nextPageNumber}`,
        sampleImageUrl: samplePage,
        normalizedImageUrl: samplePage,
        similarityThreshold: template.similarityThreshold,
        finalConfidenceThreshold: template.finalConfidenceThreshold,
      },
    ]);
    updateTemplate(templateId, { pageCount: nextPageNumber });
  };

  const removePage = (templateId: string, pageId: string) => {
    const templatePages = pages.filter((page) => page.templateId === templateId);
    if (templatePages.length <= 1) return;
    setPages((prev) => prev.filter((page) => page.id !== pageId));
    setFields((prev) => prev.filter((field) => field.templatePageId !== pageId));
    setIgnoreRegions((prev) => prev.filter((region) => region.templatePageId !== pageId));
    updateTemplate(templateId, { pageCount: templatePages.length - 1 });
  };

  const addField = (templateId: string, pageId: string) => {
    const page = pages.find((item) => item.id === pageId);
    if (!page) return;
    setFields((prev) => [
      ...prev,
      {
        id: `tpl_field_${Date.now()}`,
        templateId,
        templatePageId: pageId,
        pageNumber: page.pageNumber,
        fieldName: `field_${prev.length + 1}`,
        displayLabel: `Field ${prev.length + 1}`,
        roi: defaultRoi(page.pageNumber),
        dataType: "string",
        userSelectable: true,
        defaultSelected: false,
        useForVerification: false,
        expectedText: "",
        matchType: "",
        requiredForVerification: false,
        extractionMethod: "fixed_roi",
        sortOrder: prev.length + 1,
      },
    ]);
  };

  const updateField = (fieldId: string, patch: Partial<TemplateField>) => {
    setFields((prev) => prev.map((field) => (field.id === fieldId ? { ...field, ...patch } : field)));
  };

  const deleteField = (fieldId: string) => {
    setFields((prev) => prev.filter((field) => field.id !== fieldId));
  };

  const addIgnoreRegion = (templateId: string, pageId: string) => {
    const page = pages.find((item) => item.id === pageId);
    if (!page) return;
    setIgnoreRegions((prev) => [
      ...prev,
      {
        id: `ignore_${Date.now()}`,
        templateId,
        templatePageId: pageId,
        pageNumber: page.pageNumber,
        fieldName: `ignore_region_${prev.length + 1}`,
        roi: { pageNumber: page.pageNumber, xRatio: 0.5, yRatio: 0.25, widthRatio: 0.22, heightRatio: 0.08 },
      },
    ]);
  };

  const updateIgnoreRegion = (regionId: string, patch: Partial<IgnoreRegion>) => {
    setIgnoreRegions((prev) => prev.map((region) => (region.id === regionId ? { ...region, ...patch } : region)));
  };

  const deleteIgnoreRegion = (regionId: string) => {
    setIgnoreRegions((prev) => prev.filter((region) => region.id !== regionId));
  };

  const generateEmbedding = (templateId: string, pageId: string) => {
    setPages((prev) => prev.map((page) => (page.id === pageId ? { ...page, qdrantPointId: `qdrant_${Date.now()}` } : page)));
    updateTemplate(templateId, { status: "embedding_generated" });
  };

  const markTesting = (templateId: string) => {
    updateTemplate(templateId, { status: "testing" });
  };

  return (
    <AdminStateContext.Provider
      value={{
        requests,
        templates,
        pages,
        fields,
        ignoreRegions,
        dashboard,
        rejectRequest,
        convertRequestToTemplate,
        updateTemplate,
        addPage,
        removePage,
        addField,
        updateField,
        deleteField,
        addIgnoreRegion,
        updateIgnoreRegion,
        deleteIgnoreRegion,
        generateEmbedding,
        markTesting,
      }}
    >
      {children}
    </AdminStateContext.Provider>
  );
}

export function useAdminState() {
  const context = useContext(AdminStateContext);
  if (!context) {
    throw new Error("useAdminState must be used inside AdminStateProvider");
  }
  return context;
}
