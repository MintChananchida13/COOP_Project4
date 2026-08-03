"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import WorkspaceTemplateEditor from "./workspace/WorkspaceTemplateEditorV2";
import AdjustZone from "../user/components/AdjustZone";
import {
  createIgnoreRegionApi,
  createTemplateFieldApi,
  createTemplatePageApi,
  deleteIgnoreRegionApi,
  deleteTemplateFieldApi,
  deleteTemplatePageApi,
  fetchTemplateBundle,
  updateIgnoreRegionApi,
  updateTemplateApi,
  updateTemplateFieldApi,
  updateTemplatePageApi,
} from "./adminApi";
import type { IgnoreRegion, RoiRatio, Template, TemplateField, TemplatePage } from "../types/ocr";

type LoadStatus = "loading" | "loaded" | "error";
type AdminEditorStage = "adjust" | "roi";

const samplePage =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='750' height='1000' viewBox='0 0 750 1000'%3E%3Crect width='750' height='1000' fill='%23ffffff'/%3E%3Crect x='70' y='70' width='610' height='90' rx='8' fill='%23e2e8f0'/%3E%3Crect x='70' y='210' width='270' height='34' rx='5' fill='%23cbd5e1'/%3E%3Crect x='70' y='275' width='610' height='22' rx='4' fill='%23e2e8f0'/%3E%3Crect x='70' y='325' width='610' height='22' rx='4' fill='%23e2e8f0'/%3E%3Crect x='70' y='420' width='610' height='220' rx='8' fill='%23f1f5f9' stroke='%23cbd5e1'/%3E%3Ctext x='375' y='910' text-anchor='middle' font-family='Arial' font-size='24' fill='%2364758b'%3ETemplate Sample Page%3C/text%3E%3C/svg%3E";

interface AdminAdjustPageConfig {
  rotation: number;
  brightness: number;
  contrast: number;
  sharpness: number;
  perspectiveV: number;
  perspectiveH: number;
  flipH: boolean;
  flipV: boolean;
  cropBox: {
    x: number;
    y: number;
    width: number;
    height: number;
    renderedWidth?: number;
    renderedHeight?: number;
  } | null;
  cropCorners: { x: number; y: number }[] | null;
  isCropActive: boolean;
  isCropped: boolean;
  croppedLocalUrl: string | null;
}

interface AutoDetectedTemplateField {
  roi: RoiRatio;
  defaults: Partial<TemplateField>;
}

type TemplateBundle = { template: Template; pages: TemplatePage[]; fields: TemplateField[]; ignoreRegions: IgnoreRegion[] };

const defaultRoi = (pageNumber: number): RoiRatio => ({
  pageNumber,
  xRatio: 0.1,
  yRatio: 0.2,
  widthRatio: 0.32,
  heightRatio: 0.06,
});

const defaultAdjustPageConfig = (): AdminAdjustPageConfig => ({
  rotation: 0,
  brightness: 100,
  contrast: 100,
  sharpness: 0,
  perspectiveV: 0,
  perspectiveH: 0,
  flipH: false,
  flipV: false,
  cropBox: null,
  cropCorners: null,
  isCropActive: false,
  isCropped: false,
  croppedLocalUrl: null,
});

export default function AdminTemplateEditPage({ templateId }: { templateId: string }) {
  const router = useRouter();
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [selectedTemplatePages, setSelectedTemplatePages] = useState<TemplatePage[]>([]);
  const [selectedTemplateFields, setSelectedTemplateFields] = useState<TemplateField[]>([]);
  const [selectedIgnoreRegions, setSelectedIgnoreRegions] = useState<IgnoreRegion[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [saveStatus, setSaveStatus] = useState("");
  const [showUpdateSuccessDialog, setShowUpdateSuccessDialog] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [editorStage, setEditorStage] = useState<AdminEditorStage>("adjust");
  const [adjustPageConfigs, setAdjustPageConfigs] = useState<AdminAdjustPageConfig[]>([]);
  const localFieldSequenceRef = useRef(0);
  const fieldUpdateSequenceRef = useRef(new Map<string, number>());
  const pendingLocalFieldPatchesRef = useRef(new Map<string, Partial<TemplateField>>());
  const dirtyFieldPatchesRef = useRef(new Map<string, Partial<TemplateField>>());
  const pendingDeletedFieldIdsRef = useRef(new Set<string>());
  const selectedTemplateFieldsRef = useRef<TemplateField[]>([]);
  const pendingFieldSavePromisesRef = useRef(new Set<Promise<unknown>>());

  const applyBundle = (bundle: TemplateBundle) => {
    setSelectedTemplate(bundle.template);
    setSelectedTemplatePages(bundle.pages);
    setSelectedTemplateFields(bundle.fields);
    setSelectedIgnoreRegions(bundle.ignoreRegions);
  };

  useEffect(() => {
    selectedTemplateFieldsRef.current = selectedTemplateFields;
  }, [selectedTemplateFields]);

  const trackFieldSave = <T,>(promise: Promise<T>) => {
    const tracked = promise.finally(() => {
      pendingFieldSavePromisesRef.current.delete(tracked);
    });
    pendingFieldSavePromisesRef.current.add(tracked);
    return tracked;
  };

  const waitForPendingFieldSaves = async () => {
    while (pendingFieldSavePromisesRef.current.size > 0) {
      await Promise.allSettled(Array.from(pendingFieldSavePromisesRef.current));
    }
  };

  const flushFieldDrafts = async () => {
    await waitForPendingFieldSaves();
    if (!canPersistToBackend) {
      setLocalOnly("Field changes saved locally.");
      return;
    }

    let latestBundle: TemplateBundle | null = null;
    const deletedIds = Array.from(pendingDeletedFieldIdsRef.current).filter((fieldId) => !fieldId.startsWith("local_field_"));
    for (const fieldId of deletedIds) {
      latestBundle = await deleteTemplateFieldApi(templateId, fieldId);
      pendingDeletedFieldIdsRef.current.delete(fieldId);
      dirtyFieldPatchesRef.current.delete(fieldId);
      pendingLocalFieldPatchesRef.current.delete(fieldId);
    }

    let currentFields = selectedTemplateFieldsRef.current;
    const localFields = currentFields.filter((field) => field.id.startsWith("local_field_"));
    for (const localField of localFields) {
      const localPatch = pendingLocalFieldPatchesRef.current.get(localField.id) || {};
      const fieldToCreate = { ...localField, ...localPatch };
      latestBundle = await createTemplateFieldApi(templateId, fieldToCreate);
      const savedField =
        latestBundle.fields.find((field) => field.id === localField.id) ||
        latestBundle.fields.find(
          (field) =>
            field.templatePageId === fieldToCreate.templatePageId &&
            field.pageNumber === fieldToCreate.pageNumber &&
            field.fieldName === fieldToCreate.fieldName &&
            field.sortOrder === fieldToCreate.sortOrder
        ) ||
        latestBundle.fields.find(
          (field) =>
            field.templatePageId === fieldToCreate.templatePageId &&
            field.pageNumber === fieldToCreate.pageNumber &&
            field.fieldName === fieldToCreate.fieldName
        );
      if (savedField) {
        const preservedField = {
          ...savedField,
          ...fieldToCreate,
          id: savedField.id,
          templateId: savedField.templateId,
          templatePageId: savedField.templatePageId,
        };
        currentFields = currentFields.map((field) => (field.id === localField.id ? preservedField : field));
        setSelectedTemplateFields(currentFields);
        selectedTemplateFieldsRef.current = currentFields;
        pendingLocalFieldPatchesRef.current.delete(localField.id);
        dirtyFieldPatchesRef.current.delete(localField.id);
      }
    }

    const dirtyEntries = Array.from(dirtyFieldPatchesRef.current.entries()).filter(([fieldId]) => !fieldId.startsWith("local_field_"));
    for (const [fieldId, patch] of dirtyEntries) {
      latestBundle = await updateTemplateFieldApi(templateId, fieldId, patch);
      dirtyFieldPatchesRef.current.delete(fieldId);
    }

    if (latestBundle) {
      applyBundle(latestBundle);
      setSaved("Field changes saved.");
    }
  };

  useEffect(() => {
    let cancelled = false;

    const loadTemplate = async () => {
      setLoadStatus("loading");
      try {
        const bundle = await fetchTemplateBundle(templateId);
        if (cancelled) return;
        applyBundle(bundle);
        setLoadStatus("loaded");
      } catch (error) {
        console.warn("Template editor load failed.", error);
        if (cancelled) return;
        setSelectedTemplate(null);
        setSelectedTemplatePages([]);
        setSelectedTemplateFields([]);
        setSelectedIgnoreRegions([]);
        setLoadStatus("error");
      }
    };

    loadTemplate();
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  const imageList = useMemo(
    () => selectedTemplatePages.map((page) => page.normalizedImageUrl || page.sampleImageUrl || samplePage),
    [selectedTemplatePages]
  );

  const workspacePages = selectedTemplatePages.map((page, index) => ({
    id: page.id,
    src: imageList[index] || samplePage,
    label: page.pageName || `Page ${page.pageNumber}`,
  }));

  useEffect(() => {
    setAdjustPageConfigs((current) => {
      if (current.length === selectedTemplatePages.length) return current;
      return selectedTemplatePages.map((_, index) => current[index] || defaultAdjustPageConfig());
    });
  }, [selectedTemplatePages.length]);

  const safeCurrentPage = Math.min(currentPage, Math.max(selectedTemplatePages.length - 1, 0));
  const currentTemplatePage = selectedTemplatePages[safeCurrentPage];
  const extractionFieldCount = selectedTemplateFields.filter((field) => !field.useForVerification).length;
  const verificationAnchorCount = selectedTemplateFields.filter((field) => field.useForVerification).length;
  const processSteps = [
    {
      id: "adjust",
      label: "2.0 ปรับแต่งภาพ",
      description: "ตรวจภาพและ Crop เอกสาร",
      status: editorStage === "roi" ? "done" : "active",
    },
    {
      id: "roi",
      label: "2.1 กำหนด Extraction ROI",
      description: "วาดพื้นที่ข้อมูลสำหรับ OCR และทดสอบ OCR",
      status: editorStage === "roi" ? "active" : "next",
    },
    {
      id: "verification",
      label: "2.2 กำหนด Verification ROI",
      description: "เลือกจุดอ้างอิงสำหรับยืนยัน Template",
      status: editorStage === "roi" && verificationAnchorCount > 0 ? "active" : "next",
    },
  ] as const;

  const setSaved = (message: string) => setSaveStatus(message);
  const setLocalOnly = (message: string) => setSaveStatus(`${message} Backend unavailable; kept local edit.`);
  const canPersistToBackend = loadStatus === "loaded";

  const handleConfirmAdjustedImages = async (finalImages: string[]) => {
    if (finalImages.length === 0) return;

    const previousPages = selectedTemplatePages;
    const nextPages = selectedTemplatePages.map((page, index) => ({
      ...page,
      normalizedImageUrl: finalImages[index] || page.normalizedImageUrl || page.sampleImageUrl || samplePage,
    }));
    setSelectedTemplatePages(nextPages);
    setCurrentPage(0);
    setEditorStage("roi");

    if (!canPersistToBackend) {
      setLocalOnly("Adjusted images saved locally.");
      return;
    }

    try {
      let latestBundle: Awaited<ReturnType<typeof updateTemplatePageApi>> | null = null;
      for (const page of nextPages) {
        if (!page.id.startsWith("local_page_")) {
          latestBundle = await updateTemplatePageApi(templateId, page.id, {
            normalizedImageUrl: page.normalizedImageUrl,
          });
        }
      }
      if (latestBundle) applyBundle(latestBundle);
      setSaved("Adjusted images saved. Workspace ROI is ready.");
    } catch (error) {
      console.warn("Adjusted image save failed.", error);
      setSelectedTemplatePages(nextPages.length > 0 ? nextPages : previousPages);
      setLocalOnly("Adjusted images saved locally.");
    }
  };

  const persistTemplatePatch = async (patch: Partial<Template>) => {
    if (!selectedTemplate) return;
    setSelectedTemplate({ ...selectedTemplate, ...patch });
    if (!canPersistToBackend) {
      setLocalOnly("Template saved locally.");
      return;
    }
    try {
      const bundle = await updateTemplateApi(templateId, patch);
      applyBundle(bundle);
      setSaved("Template saved.");
    } catch (error) {
      console.warn("Template save failed.", error);
      setLocalOnly("Template saved locally.");
    }
  };

  const handleAddPage = () => {
    const nextPageNumber = selectedTemplatePages.length + 1;
    const optimisticPage: TemplatePage = {
      id: `local_page_${Date.now()}`,
      templateId,
      pageNumber: nextPageNumber,
      pageName: `Page ${nextPageNumber}`,
      sampleImageUrl: samplePage,
      normalizedImageUrl: samplePage,
      similarityThreshold: selectedTemplate?.similarityThreshold ?? 0.75,
      finalConfidenceThreshold: selectedTemplate?.finalConfidenceThreshold ?? 0.8,
    };
    setSelectedTemplatePages((prev) => [...prev, optimisticPage]);

    if (!canPersistToBackend) {
      setLocalOnly("Page added locally.");
      return;
    }

    createTemplatePageApi(templateId, nextPageNumber, samplePage)
      .then((bundle) => {
        applyBundle(bundle);
        setSaved("Page saved.");
      })
      .catch((error) => {
        console.warn("Page create failed.", error);
        setLocalOnly("Page added locally.");
      });
  };

  const handleUpdatePage = (pageId: string, patch: Partial<TemplatePage>) => {
    setSelectedTemplatePages((prev) => prev.map((page) => (page.id === pageId ? { ...page, ...patch } : page)));
    if (!canPersistToBackend || pageId.startsWith("local_page_")) {
      setLocalOnly("Page saved locally.");
      return;
    }

    updateTemplatePageApi(templateId, pageId, patch)
      .then((bundle) => {
        applyBundle(bundle);
        setSaved("Page saved.");
      })
      .catch((error) => {
        console.warn("Page update failed.", error);
        setLocalOnly("Page saved locally.");
      });
  };

  const handleRemovePage = (pageId: string) => {
    const previousPages = selectedTemplatePages;
    const previousFields = selectedTemplateFields;
    const previousIgnoreRegions = selectedIgnoreRegions;
    setSelectedTemplatePages((prev) => prev.filter((page) => page.id !== pageId));
    setSelectedTemplateFields((prev) => prev.filter((field) => field.templatePageId !== pageId));
    setSelectedIgnoreRegions((prev) => prev.filter((region) => region.templatePageId !== pageId));
    setCurrentPage(0);

    if (!canPersistToBackend || pageId.startsWith("local_page_")) {
      setLocalOnly("Page removed locally.");
      return;
    }

    deleteTemplatePageApi(templateId, pageId)
      .then((bundle) => {
        applyBundle(bundle);
        setSaved("Page removed.");
      })
      .catch((error) => {
        console.warn("Page delete failed.", error);
        if (!pageId.startsWith("local_page_")) {
          setSelectedTemplatePages(previousPages);
          setSelectedTemplateFields(previousFields);
          setSelectedIgnoreRegions(previousIgnoreRegions);
        }
        setLocalOnly("Page removal could not be persisted.");
      });
  };

  const handleAddField = (roi?: RoiRatio, defaults?: Partial<TemplateField>) => {
    if (!currentTemplatePage) return;
    const nextIndex = selectedTemplateFields.length + 1;
    const nextRoi = roi || defaultRoi(currentTemplatePage.pageNumber);
    localFieldSequenceRef.current += 1;
    const optimisticId = defaults?.id || `local_field_${Date.now()}_${localFieldSequenceRef.current}`;
    const optimisticField: TemplateField = {
      id: optimisticId,
      templateId,
      templatePageId: currentTemplatePage.id,
      pageNumber: currentTemplatePage.pageNumber,
      fieldName: defaults?.fieldName || `field_${nextIndex}`,
      displayLabel: defaults?.displayLabel || defaults?.fieldName || `Field ${nextIndex}`,
      roi: nextRoi,
      dataType: defaults?.dataType || "text",
      userSelectable: defaults?.userSelectable ?? true,
      defaultSelected: defaults?.defaultSelected ?? true,
      useForVerification: defaults?.useForVerification ?? false,
      expectedText: defaults?.expectedText || "",
      matchType: defaults?.matchType || "",
      requiredForVerification: defaults?.requiredForVerification ?? false,
      extractionMethod:
        defaults?.extractionMethod ||
        (defaults?.dataType === "image" ? "extract_image" : defaults?.dataType === "table" ? "table_recognition_v2" : "paddle_thai_ocr"),
      roiPadding: defaults?.roiPadding ?? 0,
      verificationWeight: defaults?.verificationWeight ?? 1,
      sortOrder: nextIndex,
    };
    setSelectedTemplateFields((prev) => [...prev, optimisticField]);
    pendingLocalFieldPatchesRef.current.set(optimisticId, optimisticField);
    setSaved("Field added to draft.");
  };

  const handleUpdateField = (fieldId: string, patch: Partial<TemplateField>) => {
    const requestSequence = (fieldUpdateSequenceRef.current.get(fieldId) || 0) + 1;
    fieldUpdateSequenceRef.current.set(fieldId, requestSequence);
    setSelectedTemplateFields((prev) => prev.map((field) => (field.id === fieldId ? { ...field, ...patch } : field)));
    if (fieldId.startsWith("local_field_")) {
      pendingLocalFieldPatchesRef.current.set(fieldId, {
        ...(pendingLocalFieldPatchesRef.current.get(fieldId) || {}),
        ...patch,
      });
    } else {
      dirtyFieldPatchesRef.current.set(fieldId, {
        ...(dirtyFieldPatchesRef.current.get(fieldId) || {}),
        ...patch,
      });
    }
    setSaved("Field changes saved to draft.");
  };

  const handleReorderFields = (orderedFieldIds: string[]) => {
    const orderMap = new Map(orderedFieldIds.map((fieldId, index) => [fieldId, index + 1]));
    const previousFields = selectedTemplateFields;
    const changedFields = previousFields
      .filter((field) => orderMap.has(field.id) && field.sortOrder !== orderMap.get(field.id))
      .map((field) => ({ ...field, sortOrder: orderMap.get(field.id) || field.sortOrder || 0 }));

    if (changedFields.length === 0) return;

    setSelectedTemplateFields((prev) =>
      prev.map((field) => {
        const nextSortOrder = orderMap.get(field.id);
        return nextSortOrder ? { ...field, sortOrder: nextSortOrder } : field;
      })
    );

    changedFields.forEach((field) => {
      const patch = { sortOrder: field.sortOrder };
      if (field.id.startsWith("local_field_")) {
        pendingLocalFieldPatchesRef.current.set(field.id, {
          ...(pendingLocalFieldPatchesRef.current.get(field.id) || {}),
          ...patch,
        });
      } else {
        dirtyFieldPatchesRef.current.set(field.id, {
          ...(dirtyFieldPatchesRef.current.get(field.id) || {}),
          ...patch,
        });
      }
    });
    setSaved("Field order saved to draft.");
  };

  const handleDeleteField = (fieldId: string) => {
    setSelectedTemplateFields((prev) => prev.filter((field) => field.id !== fieldId));
    pendingLocalFieldPatchesRef.current.delete(fieldId);
    dirtyFieldPatchesRef.current.delete(fieldId);
    if (!fieldId.startsWith("local_field_")) {
      pendingDeletedFieldIdsRef.current.add(fieldId);
    }
    setSaved("Field deleted from draft.");
  };

  const handleEnterTemplateTestMode = () => {
    void (async () => {
      await flushFieldDrafts();
      if (selectedTemplate?.status === "active") {
        setShowUpdateSuccessDialog(true);
        return;
      }
      router.push(`/admin/templates/${templateId}/test`);
    })();
  };

  const handleReplacePageExtractionFields = (pageNumber: number, detectedFields: AutoDetectedTemplateField[]) => {
    const targetPage = selectedTemplatePages.find((page) => page.pageNumber === pageNumber);
    if (!targetPage) return;

    const previousFields = selectedTemplateFields;
    const fieldsToDelete = previousFields.filter((field) => field.pageNumber === pageNumber && !field.useForVerification);
    const remainingFields = previousFields.filter((field) => !(field.pageNumber === pageNumber && !field.useForVerification));

    const optimisticFields = detectedFields.map(({ roi, defaults }, index) => {
      localFieldSequenceRef.current += 1;
      const fieldNumber = index + 1;
      const fieldName = defaults.fieldName || `field_${fieldNumber}`;
      return {
        id: `local_field_${Date.now()}_${localFieldSequenceRef.current}`,
        templateId,
        templatePageId: targetPage.id,
        pageNumber,
        fieldName,
        displayLabel: defaults.displayLabel || fieldName,
        roi,
        dataType: defaults.dataType || "text",
        userSelectable: defaults.userSelectable ?? true,
        defaultSelected: defaults.defaultSelected ?? true,
        useForVerification: false,
        expectedText: "",
        matchType: "",
        requiredForVerification: false,
        extractionMethod:
          defaults.extractionMethod ||
          (defaults.dataType === "image" ? "extract_image" : defaults.dataType === "table" ? "table_recognition_v2" : "paddle_thai_ocr"),
        roiPadding: defaults.roiPadding ?? 0,
        verificationWeight: defaults.verificationWeight ?? 1,
        sortOrder: fieldNumber,
      } satisfies TemplateField;
    });

    setSelectedTemplateFields([...remainingFields, ...optimisticFields]);

    if (!canPersistToBackend) {
      setLocalOnly("Auto ROI fields replaced locally.");
      return;
    }

    (async () => {
      try {
        for (const field of fieldsToDelete) {
          if (!field.id.startsWith("local_field_")) {
            await deleteTemplateFieldApi(templateId, field.id);
          }
        }

        let latestBundle: Awaited<ReturnType<typeof createTemplateFieldApi>> | null = null;
        for (const field of optimisticFields) {
          latestBundle = await createTemplateFieldApi(templateId, field);
        }

        if (latestBundle) {
          applyBundle(latestBundle);
        } else {
          const bundle = await fetchTemplateBundle(templateId);
          applyBundle(bundle);
        }
        setSaved(`Auto ROI replaced ${fieldsToDelete.length} old fields with ${optimisticFields.length} fields.`);
      } catch (error) {
        console.warn("Auto ROI replace failed.", error);
        setSelectedTemplateFields(previousFields);
        setLocalOnly("Auto ROI replace could not be persisted.");
      }
    })();
  };

  const handleReplaceExtractionFieldsForPages = (
    items: { pageNumber: number; fields: AutoDetectedTemplateField[] }[]
  ) => {
    const pageNumbers = new Set(items.map((item) => item.pageNumber));
    const templatePageByNumber = new Map(selectedTemplatePages.map((page) => [page.pageNumber, page]));
    const previousFields = selectedTemplateFields;
    const fieldsToDelete = previousFields.filter((field) => pageNumbers.has(field.pageNumber) && !field.useForVerification);
    const remainingFields = previousFields.filter((field) => !(pageNumbers.has(field.pageNumber) && !field.useForVerification));
    const optimisticFields = items.flatMap(({ pageNumber, fields: detectedFields }) => {
      const targetPage = templatePageByNumber.get(pageNumber);
      if (!targetPage) return [];

      return detectedFields.map(({ roi, defaults }, index) => {
        localFieldSequenceRef.current += 1;
        const fieldNumber = index + 1;
        const fieldName = defaults.fieldName || `field_${pageNumber}_${fieldNumber}`;
        return {
          id: `local_field_${Date.now()}_${localFieldSequenceRef.current}`,
          templateId,
          templatePageId: targetPage.id,
          pageNumber,
          fieldName,
          displayLabel: defaults.displayLabel || fieldName,
          roi,
          dataType: defaults.dataType || "text",
          userSelectable: defaults.userSelectable ?? true,
          defaultSelected: defaults.defaultSelected ?? true,
          useForVerification: false,
          expectedText: "",
          matchType: "",
          requiredForVerification: false,
          extractionMethod:
            defaults.extractionMethod ||
            (defaults.dataType === "image" ? "extract_image" : defaults.dataType === "table" ? "table_recognition_v2" : "paddle_thai_ocr"),
          roiPadding: defaults.roiPadding ?? 0,
          verificationWeight: defaults.verificationWeight ?? 1,
          sortOrder: fieldNumber,
        } satisfies TemplateField;
      });
    });

    setSelectedTemplateFields([...remainingFields, ...optimisticFields]);

    if (!canPersistToBackend) {
      setLocalOnly("Auto ROI fields replaced locally for all pages.");
      return;
    }

    (async () => {
      try {
        for (const field of fieldsToDelete) {
          if (!field.id.startsWith("local_field_")) {
            await deleteTemplateFieldApi(templateId, field.id);
          }
        }

        let latestBundle: Awaited<ReturnType<typeof createTemplateFieldApi>> | null = null;
        for (const field of optimisticFields) {
          latestBundle = await createTemplateFieldApi(templateId, field);
        }

        if (latestBundle) {
          applyBundle(latestBundle);
        } else {
          const bundle = await fetchTemplateBundle(templateId);
          applyBundle(bundle);
        }
        setSaved(`Auto ROI replaced ${fieldsToDelete.length} old fields with ${optimisticFields.length} fields across ${items.length} pages.`);
      } catch (error) {
        console.warn("Auto ROI batch replace failed.", error);
        setSelectedTemplateFields(previousFields);
        setLocalOnly("Auto ROI batch replace could not be persisted.");
      }
    })();
  };

  const handleAddIgnoreRegion = (roi?: RoiRatio) => {
    if (!currentTemplatePage) return;
    const nextIndex = selectedIgnoreRegions.length + 1;
    const nextRoi = roi || {
      pageNumber: currentTemplatePage.pageNumber,
      xRatio: 0.5,
      yRatio: 0.25,
      widthRatio: 0.22,
      heightRatio: 0.08,
    };
    const optimisticRegion: IgnoreRegion = {
      id: `local_ignore_${Date.now()}`,
      templateId,
      templatePageId: currentTemplatePage.id,
      pageNumber: currentTemplatePage.pageNumber,
      fieldName: `ignore_region_${nextIndex}`,
      roi: nextRoi,
    };
    setSelectedIgnoreRegions((prev) => [...prev, optimisticRegion]);

    if (!canPersistToBackend) {
      setLocalOnly("Ignore region added locally.");
      return;
    }

    createIgnoreRegionApi(templateId, optimisticRegion)
      .then((bundle) => {
        applyBundle(bundle);
        setSaved("Ignore region saved.");
      })
      .catch((error) => {
        console.warn("Ignore region create failed.", error);
        setLocalOnly("Ignore region added locally.");
      });
  };

  const handleUpdateIgnoreRegion = (regionId: string, patch: Partial<IgnoreRegion>) => {
    setSelectedIgnoreRegions((prev) => prev.map((region) => (region.id === regionId ? { ...region, ...patch } : region)));
    if (!canPersistToBackend || regionId.startsWith("local_ignore_")) {
      setLocalOnly("Ignore region saved locally.");
      return;
    }

    updateIgnoreRegionApi(templateId, regionId, patch)
      .then((bundle) => {
        applyBundle(bundle);
        setSaved("Ignore region saved.");
      })
      .catch((error) => {
        console.warn("Ignore region update failed.", error);
        setLocalOnly("Ignore region saved locally.");
      });
  };

  const handleDeleteIgnoreRegion = (regionId: string) => {
    const previousRegions = selectedIgnoreRegions;
    setSelectedIgnoreRegions((prev) => prev.filter((region) => region.id !== regionId));
    if (!canPersistToBackend || regionId.startsWith("local_ignore_")) {
      setLocalOnly("Ignore region deleted locally.");
      return;
    }

    deleteIgnoreRegionApi(templateId, regionId)
      .then((bundle) => {
        applyBundle(bundle);
        setSaved("Ignore region deleted.");
      })
      .catch((error) => {
        console.warn("Ignore region delete failed.", error);
        setSelectedIgnoreRegions(previousRegions);
        setLocalOnly("Ignore region delete could not be persisted.");
      });
  };

  if (loadStatus === "loading") {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500 shadow-sm">
        Loading template editor...
      </section>
    );
  }

  if (!selectedTemplate) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-black text-slate-900">Template not found</h2>
        <Link href="/admin/templates" className="mt-4 inline-flex rounded-xl bg-indigo-600 px-4 py-2 text-xs font-black text-white">
          Back to Templates
        </Link>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      {saveStatus && <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">{saveStatus}</p>}

      {selectedTemplatePages.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-sm font-black uppercase tracking-wide text-slate-800">กระบวนการเตรียม Template</h2>
              <p className="mt-1 text-xs font-semibold text-slate-500">
                ทำตามลำดับจากปรับภาพ วาด ROI ทดสอบ OCR แล้วตั้ง Verification Anchors ก่อนเข้าสู่ Test Mode
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full bg-sky-50 px-3 py-2 text-[11px] font-black text-sky-700">
                Pages: {selectedTemplatePages.length}
              </span>
              <span className="rounded-full bg-indigo-50 px-3 py-2 text-[11px] font-black text-indigo-700">
                ROI: {extractionFieldCount}
              </span>
              <span className="rounded-full bg-amber-50 px-3 py-2 text-[11px] font-black text-amber-700">
                Anchors: {verificationAnchorCount}
              </span>
            </div>
          </div>

          <div className="mt-4 grid gap-2 md:grid-cols-3">
            {processSteps.map((item, index) => {
                const isActive = item.status === "active";
                const isDone = item.status === "done";
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      if (item.id === "adjust") setEditorStage("adjust");
                      if (item.id === "roi") setEditorStage("roi");
                    }}
                    disabled={item.id === "verification"}
                    className={`min-h-[74px] rounded-xl border px-4 py-3 text-left transition-colors disabled:cursor-default ${
                      isActive
                        ? "border-indigo-300 bg-indigo-50 text-indigo-800"
                        : isDone
                          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                          : "border-slate-200 bg-slate-50 text-slate-600"
                    }`}
                  >
                    <span className={`mb-2 inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-black ${
                      isDone ? "bg-emerald-600 text-white" : isActive ? "bg-indigo-600 text-white" : "bg-white text-slate-400"
                    }`}>
                      {index + 1}
                    </span>
                    <span className="block text-xs font-black">{item.label}</span>
                    <span className="block text-[11px] font-semibold opacity-75">{item.description}</span>
                  </button>
                );
            })}
          </div>
        </div>
      )}

      {selectedTemplatePages.length > 0 && currentTemplatePage && (
        <div className="space-y-4">
          {editorStage === "adjust" ? (
            <AdjustZone
              imagesList={imageList}
              currentIndex={safeCurrentPage}
              onIndexChange={setCurrentPage}
              pagesConfig={adjustPageConfigs}
              setPagesConfig={setAdjustPageConfigs}
              onBatchConfirm={(finalImages) => {
                void handleConfirmAdjustedImages(finalImages);
              }}
            />
          ) : (
            <WorkspaceTemplateEditor
              templateId={templateId}
              pages={workspacePages}
              currentPage={safeCurrentPage}
              onPageChange={setCurrentPage}
              fields={selectedTemplateFields}
              ignoreRegions={selectedIgnoreRegions}
              onAddField={handleAddField}
              onUpdateField={handleUpdateField}
              onReorderFields={handleReorderFields}
              onReplacePageExtractionFields={handleReplacePageExtractionFields}
              onReplaceExtractionFieldsForPages={handleReplaceExtractionFieldsForPages}
              onDeleteField={handleDeleteField}
              onAddIgnoreRegion={handleAddIgnoreRegion}
              onUpdateIgnoreRegion={handleUpdateIgnoreRegion}
              onDeleteIgnoreRegion={handleDeleteIgnoreRegion}
              onGenerateEmbedding={handleEnterTemplateTestMode}
              onRunTestMode={handleEnterTemplateTestMode}
              onBeforeRunTest={flushFieldDrafts}
              testModeLabel={selectedTemplate?.status === "active" ? "อัปเดต Template" : "Test Mode"}
              onBackToAdjust={() => setEditorStage("adjust")}
            />
          )}
        </div>
      )}

      {showUpdateSuccessDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4">
          <div className="w-full max-w-md rounded-2xl border border-emerald-100 bg-white p-6 text-center shadow-2xl">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl font-black text-emerald-700">
              ✓
            </div>
            <h3 className="mt-4 text-lg font-black text-slate-950">อัปเดต Template สำเร็จ</h3>
            <p className="mt-2 text-sm font-semibold leading-6 text-slate-500">
              ระบบบันทึกการเปลี่ยนแปลงล่าสุดของ Template แล้ว และจะพากลับไปยังคลัง Template
            </p>
            <button
              type="button"
              onClick={() => {
                setShowUpdateSuccessDialog(false);
                router.push("/admin/templates");
              }}
              className="mt-5 rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-black text-white shadow-sm hover:bg-emerald-700"
            >
              ตกลง
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
