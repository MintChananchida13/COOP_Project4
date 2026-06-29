"use client";

import React, { useState } from 'react';
import { Upload, Loader2 } from 'lucide-react';

interface UploadZoneProps {
  onUploadSuccess: (urls: string[]) => void;
}

export default function UploadZone({ onUploadSuccess }: UploadZoneProps) {
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  // 🔮 ฟังก์ชันโหลดสคริปต์ PDF.js จากภายนอกแบบ Pure Client-Side เพื่อหนีตัวยึด Chunk ของ Turbopack
  const loadPdfEngine = (): Promise<any> => {
    return new Promise((resolve, reject) => {
      if ((window as any).pdfjsLib) {
        resolve((window as any).pdfjsLib);
        return;
      }
      const script = document.createElement('script');
      // ล็อกเวอร์ชันผ่านคลังไฟล์ประมวลผลสากล
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      script.onload = () => {
        const pdfjs = (window as any).pdfjsLib;
        pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        resolve(pdfjs);
      };
      script.onerror = (err) => reject(err);
      document.head.appendChild(script);
    });
  };

  // 📄 ฟังก์ชันแกะหน้าเอกสาร PDF ออกมาเป็นภาพพิกเซลดิบ
  const convertPdfToImages = async (file: File): Promise<string[]> => {
    const pdfjsLib = await loadPdfEngine();
    const arrayBuffer = await file.arrayBuffer();
    
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    const imageUrls: string[] = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2.0 }); // ขยายสเกลเพื่อความคมชัดของข้อความภาษาไทย

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      await page.render({
        canvasContext: ctx,
        viewport: viewport
      }).promise;

      imageUrls.push(canvas.toDataURL('image/jpeg', 0.95));
    }
    return imageUrls;
  };

  // 鼠标 ดักจับเหตุการณ์โยนหรือเลือกไฟล์ (ภาพหลายภาพ หรือไฟล์ PDF)
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsProcessing(true);
    let accumulatedImages: string[] = [];

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
          const pdfImages = await convertPdfToImages(file);
          accumulatedImages = [...accumulatedImages, ...pdfImages];
        } else {
          const base64 = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(file);
          });
          accumulatedImages.push(base64);
        }
      }

      if (accumulatedImages.length > 0) {
        onUploadSuccess(accumulatedImages);
      }
    } catch (error) {
      alert("เกิดข้อผิดพลาดในการแปลงไฟล์เอกสาร");
      console.error(error);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="w-full max-w-3xl mx-auto py-12 px-4 animate-fade-in">
      <div className={`relative group border-2 border-dashed rounded-2xl p-12 text-center transition-all duration-300 shadow-sm min-h-[340px] flex flex-col items-center justify-center bg-white ${isProcessing ? 'border-indigo-300 bg-indigo-50/10' : 'border-slate-200 hover:border-indigo-500 hover:shadow-indigo-500/5'}`}>
        
        {isProcessing ? (
          <div className="flex flex-col items-center justify-center space-y-4 animate-fade-in">
            <Loader2 className="h-10 w-10 text-indigo-600 animate-spin" />
            <p className="text-xs font-bold text-slate-600">กำลังประมวลผลและสกัดหน้าเอกสาร...</p>
            <p className="text-[10px] text-slate-400 font-mono">กำลังคุยกับ Vanilla Engine บนเบราว์เซอร์...</p>
          </div>
        ) : (
          <>
            <div className="absolute inset-0 bg-gradient-to-b from-indigo-50/0 to-indigo-50/0 group-hover:to-indigo-50/20 opacity-0 group-hover:opacity-100 transition-all duration-300 pointer-events-none" />
            <input 
              type="file" 
              accept="image/*,application/pdf" 
              multiple 
              className="absolute inset-0 opacity-0 cursor-pointer z-10" 
              onChange={handleFileChange} 
            />
            <div className="relative mb-6 p-4 rounded-full bg-slate-50 border border-slate-100 text-slate-400 group-hover:text-indigo-600 group-hover:bg-indigo-50 group-hover:border-indigo-100 transition-all duration-300 group-hover:scale-110 shadow-sm">
              <Upload className="h-8 w-8" strokeWidth={2} />
            </div>
            <div className="space-y-2 relative z-20">
              <h3 className="text-sm font-bold text-slate-700 tracking-tight group-hover:text-indigo-600">
                Import Document Templates / Multi-Files
              </h3>
              <p className="text-xs text-slate-400 font-medium max-w-sm mx-auto leading-relaxed">
                ลากและวางไฟล์ หรือ <span className="text-indigo-600 font-semibold underline decoration-2 decoration-indigo-200">คลิกเพื่อเปิดไฟล์</span>
              </p>
            </div>
            <div className="mt-8 px-3 py-1 rounded-md bg-slate-100 text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider group-hover:bg-indigo-50 group-hover:text-indigo-500 transition-colors">
              Supports: PDF, JPG, PNG, WEBP
            </div>
          </>
        )}

      </div>
    </div>
  );
}