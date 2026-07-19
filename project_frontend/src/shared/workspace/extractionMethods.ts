"use client";

import { RoiDataType } from "../../types/ocr";

export type TemplateExtractionMethod = "ocr_text" | "ocr_table" | "paddle_thai_ocr" | "extract_image";

export const extractionMethodOptions: { value: TemplateExtractionMethod; label: string }[] = [
  { value: "paddle_thai_ocr", label: "Paddle Thai OCR inside ROI" },
  { value: "ocr_text", label: "OCR Text inside ROI" },
  { value: "ocr_table", label: "OCR Table inside ROI" },
  { value: "extract_image", label: "Extract Image inside ROI" },
];

export const normalizeExtractionMethod = (value?: string): TemplateExtractionMethod => {
  if (value === "typhoon_ocr") return "paddle_thai_ocr";
  if (value === "ocr_text" || value === "ocr_table" || value === "paddle_thai_ocr" || value === "extract_image") return value;
  if (value === "fixed_roi") return "ocr_text";
  return "ocr_text";
};

export const defaultExtractionMethodForDataType = (dataType?: RoiDataType): TemplateExtractionMethod => {
  if (dataType === "table") return "paddle_thai_ocr";
  if (dataType === "image") return "extract_image";
  return "paddle_thai_ocr";
};
