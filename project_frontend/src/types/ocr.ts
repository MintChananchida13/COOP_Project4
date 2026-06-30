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
  dataType?: 'string' | 'date' | 'currency';
  role?: 'anchor' | 'data_extraction' | 'visual_anchor';
  weight?: number;
  verificationRule?: string;
  points?: { x: number; y: number }[];
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
  dataType?: 'string' | 'date' | 'currency';
  role?: 'anchor' | 'data_extraction' | 'visual_anchor';
  weight?: number;
  verificationRule?: string;
  points?: { x: number; y: number }[];
}
