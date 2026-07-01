export type RoiDataType = 'string' | 'text' | 'number' | 'date' | 'address' | 'currency';

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
