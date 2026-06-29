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
}

export interface OCRResult {
  id: number;
  fieldName: string;
  bbox: number[];
  extractedText: string;
  confidence: number;
  saved_path?: string;
}
