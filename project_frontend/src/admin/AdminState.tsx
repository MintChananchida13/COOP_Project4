"use client";

import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { AdminTemplateRequest, IgnoreRegion, RoiRatio, Template, TemplateField, TemplatePage } from "../types/ocr";
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
import { fetchTemplateRequests } from "./adminApi";

interface AdminStateValue {
  requests: AdminTemplateRequest[];
  templates: Template[];
  pages: TemplatePage[];
  fields: TemplateField[];
  ignoreRegions: IgnoreRegion[];
  dashboard: AdminDashboardSummary;
  rejectRequest: (requestId: string, adminNote: string) => void;
  convertRequestToTemplate: (requestId: string, adminNote: string, sourceRequest?: AdminTemplateRequest) => string | null;
  updateTemplate: (templateId: string, patch: Partial<Template>) => void;
  addPage: (templateId: string) => void;
  removePage: (templateId: string, pageId: string) => void;
  addField: (templateId: string, pageId: string, roi?: RoiRatio) => void;
  updateField: (fieldId: string, patch: Partial<TemplateField>) => void;
  deleteField: (fieldId: string) => void;
  addIgnoreRegion: (templateId: string, pageId: string, roi?: RoiRatio) => void;
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
        const persistedRequests = await fetchTemplateRequests();
        if (!cancelled && persistedRequests.length > 0) {
          setRequests(persistedRequests);
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

  const convertRequestToTemplate = (requestId: string, adminNote: string, sourceRequest?: AdminTemplateRequest) => {
    const selectedRequest = sourceRequest || requests.find((request) => request.id === requestId);
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

  const addField = (templateId: string, pageId: string, roi?: RoiRatio) => {
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
        roi: roi || defaultRoi(page.pageNumber),
        dataType: "string",
        userSelectable: true,
        defaultSelected: false,
        useForVerification: false,
        expectedText: "",
        matchType: "",
        requiredForVerification: false,
        extractionMethod: "ocr_text",
        roiPadding: 0,
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

  const addIgnoreRegion = (templateId: string, pageId: string, roi?: RoiRatio) => {
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
        roi: roi || { pageNumber: page.pageNumber, xRatio: 0.5, yRatio: 0.25, widthRatio: 0.22, heightRatio: 0.08 },
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
