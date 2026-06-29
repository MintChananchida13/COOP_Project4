"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import AdjustZone from '../components/AdjustZone';
import WorkspaceZone from "../components/WorkspaceZone";
import GroundTruthEditorZone from "../components/GroundTruthEditorZone";
import { ROI, OCRResult } from "../types/ocr";

interface PageConfig {
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
  isCropActive: boolean;
  isCropped: boolean;
  croppedLocalUrl: string | null;
}

const UploadZone = dynamic(() => import("../components/UploadZone"), {
  ssr: false,
  loading: () => (
    <div className="w-full max-w-3xl mx-auto py-12 px-4 text-center text-slate-500 font-medium text-xs">
      กำลังเตรียมส่วนประกอบการอัปโหลด...
    </div>
  ),
});

export default function Home() {
  const [currentStep, setCurrentStep] = useState<"upload" | "adjust" | "studio" | "editor">("upload");

  const [imagesList, setImagesList] = useState<string[]>([]);
  const [originalImagesList, setOriginalImagesList] = useState<string[]>([]);
  
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [pagesConfig, setPagesConfig] = useState<PageConfig[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [image, setImage] = useState<string | null>(null);

  const [rois, setRois] = useState<(ROI & { pageIndex?: number })[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [ocrResults, setOcrResults] = useState<(OCRResult & { pageIndex?: number })[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const handleUploadSuccess = (urls: string[]) => {
    setImagesList(urls);
    setOriginalImagesList([...urls]); 
    setCurrentIndex(0);
    setPreviewUrl(urls[0]);
    setImage(urls[0]);
    
    const initialConfigs = urls.map(() => ({
      rotation: 0,
      brightness: 100,
      contrast: 100,
      sharpness: 0,
      perspectiveV: 0,
      perspectiveH: 0,
      flipH: false,
      flipV: false,
      cropBox: null,
      isCropActive: false,
      isCropped: false,
      croppedLocalUrl: null
    }));
    setPagesConfig(initialConfigs);
    
    setCurrentStep("adjust");
  };

  const handleClearAndUploadNew = () => {
    setImagesList([]);
    setOriginalImagesList([]); 
    setCurrentIndex(0);
    setPagesConfig([]);
    setPreviewUrl("");
    setImage(null);
    setRois([]);
    setSelectedId(null);
    setOcrResults([]);
    setCurrentStep("upload");
  };

  const handleBatchConfirm = (finalProcessedImages: string[]) => {
    setImagesList(finalProcessedImages);
    setPreviewUrl(finalProcessedImages[currentIndex] || "");
    setImage(finalProcessedImages[currentIndex] || null);
    setCurrentStep("studio");
  };

  // 🚀 ฟังก์ชันสั่ง Run OCR รวมทุกหน้า พร้อมระบบคำนวณสเกลภาพแบบ "แยกรายไฟล์" แม่นยำ 100%
  const handleRunOCR = async () => {
    if (rois.length === 0) {
      alert("⚠️ ไม่พบกล่อง ROI ใดๆ ในคลัง กรุณาลากกล่องข้อความอย่างน้อย 1 กล่องก่อนกดรันประมวลผลครับ");
      return;
    }

    setIsLoading(true);
    setOcrResults([]);

    try {
      // ค้นหาดัชนีของหน้าทั้งหมดที่ถูกระบุไว้ในกล่อง ROI
      const activePageIndexes = Array.from(
        new Set(rois.map((roi) => (roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0)))
      );

      const allPagePromises = activePageIndexes.map(async (pageIdx) => {
        const pageRois = rois.filter(
          (roi) => (roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0) === pageIdx
        );

        if (pageRois.length === 0) return [];

        // 🎯 [FIXED] โหลดขนาดจริงของรูปภาพในหน้านั้น ๆ ขึ้นมาเช็ค อัตราส่วนจะไม่เพี้ยนแม้รูปแต่ละหน้าจะกว้างยาวไม่เท่ากัน
        const currentImgUrl = imagesList[pageIdx];
        const dimensions = await new Promise<{ naturalWidth: number; naturalHeight: number }>((resolve) => {
          const img = new Image();
          img.onload = () => {
            resolve({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
          };
          img.src = currentImgUrl;
        });

        // ขนาดกล่องจำลองมาตรฐานบน Canvas Workspace ของเราตั้งค่าคงที่ไว้ที่ความกว้าง 750px
        const renderedWidth = 750; 
        const renderedHeight = (dimensions.naturalHeight / dimensions.naturalWidth) * renderedWidth;

        const scaleX = dimensions.naturalWidth / renderedWidth;
        const scaleY = dimensions.naturalHeight / renderedHeight;

        const response = await fetch("http://localhost:8000/api/ai/process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image: currentImgUrl,
            rois: pageRois.map((roi) => ({
              fieldName: roi.fieldName,
              x: roi.x * scaleX,
              y: roi.y * scaleY,
              width: roi.width * scaleX,
              height: roi.height * scaleY,
            })),
          }),
        });

        const aiData = await response.json();
        if (aiData.success) {
          return aiData.extracted_data.map((resItem: any, idx: number) => ({
            id: Date.now() + pageIdx * 1000 + idx, 
            fieldName: resItem.fieldName,
            bbox: [],
            extractedText: resItem.text,
            confidence: resItem.confidence,
            saved_path: resItem.saved_path || "",
            pageIndex: pageIdx, 
          }));
        }
        return [];
      });

      const resolvedResultsArray = await Promise.all(allPagePromises);
      const combinedResults = resolvedResultsArray.flat();

      if (combinedResults.length > 0) {
        setOcrResults(combinedResults);
        setCurrentStep("editor");
      } else {
        alert("ไม่สามารถดึงข้อมูล OCR ได้ กรุณาตรวจสอบเอนจินระบบ");
      }
    } catch (err) {
      alert("เกิดข้อผิดพลาดในการประมวลผลภาพรวมพร้อมกันทุกหน้า");
    } finally {
      setIsLoading(false);
    }
  };

  const handleApproveAndSave = async () => {
    const currentPageResults = ocrResults.filter(res => {
      const resPage = res.pageIndex !== undefined ? Number(res.pageIndex) : 0;
      return resPage === Number(currentIndex);
    });

    const payload = {
      templateName: `Thai_Legal_Document_Page_${currentIndex + 1}`,
      extracted_data: currentPageResults.map((item) => ({
        fieldName: item.fieldName || "",
        text: item.extractedText || "",
        confidence: item.confidence !== undefined ? item.confidence : 0.9,
        saved_path: item.saved_path || "",
      })),
    };

    try {
      await fetch("http://localhost:8000/api/templates/approve-and-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      alert(`🎉 บันทึกข้อมูลของเอกสารหน้า ${currentIndex + 1} เรียบร้อยแล้ว!`);
    } catch (error) {
      alert("เกิดข้อผิดพลาดในการบันทึกข้อมูล");
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 py-8 select-none">
      <div className="container mx-auto px-6 max-w-7xl space-y-5">
        
        <div className="text-center py-2">
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">
            Intelligent OCR Portal
          </h1>
        </div>

        <div className="bg-white border border-slate-200/80 rounded-2xl px-6 py-4 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-2.5">
            <div className="w-2.5 h-2.5 rounded-full bg-indigo-600 shadow-sm shadow-indigo-600/30 animate-pulse"></div>
            <span className="text-xs font-bold tracking-wide text-slate-700 uppercase">
              Intelligent OCR Studio v1.2 
              {imagesList.length > 0 && ` (Active: หน้า ${currentIndex + 1}/${imagesList.length})`}
            </span>
          </div>
          
          <div className="flex items-center">
            {imagesList.length > 0 && (
              <button
                type="button"
                onClick={handleClearAndUploadNew}
                className="flex items-center gap-1.5 text-xs font-bold px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 hover:text-indigo-600 hover:border-indigo-200 transition-all shadow-sm active:scale-98"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
                เปลี่ยนไฟล์ภาพใหม่
              </button>
            )}
          </div>
        </div>

        {currentStep === "upload" && (
          <UploadZone onUploadSuccess={handleUploadSuccess} /> 
        )}

        {currentStep === "adjust" && (
          <AdjustZone
            imagesList={originalImagesList.length > 0 ? originalImagesList : imagesList}
            currentIndex={currentIndex}
            onIndexChange={(nextIdx) => setCurrentIndex(nextIdx)}
            pagesConfig={pagesConfig}
            setPagesConfig={setPagesConfig}
            onBatchConfirm={handleBatchConfirm}
          />
        )}

        {currentStep === "studio" && (
          <WorkspaceZone
            previewUrl={imagesList[currentIndex] || ""}
            image={imagesList[currentIndex] || null}
            brightness={pagesConfig[currentIndex]?.brightness ?? 100}
            contrast={pagesConfig[currentIndex]?.contrast ?? 100}
            rotation={pagesConfig[currentIndex]?.rotation ?? 0}
            rois={rois}
            setRois={setRois}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            onBackToAdjust={() => setCurrentStep("adjust")}
            deleteROI={(id) => setRois((p) => p.filter((roi) => roi.id !== id))}
            isLoading={isLoading}
            onRunOCR={handleRunOCR} // 🎯 เรียกใช้งานฟังก์ชันหลักแบบไม่ต้องแนบพารามิเตอร์ผิดฝั่งมา
            currentIndex={currentIndex}
            imagesList={imagesList}
            onIndexChange={(nextIdx) => {
              setCurrentIndex(nextIdx);
              setSelectedId(null); 
            }}
          />
        )}

        {currentStep === "editor" && (
          <GroundTruthEditorZone
            previewUrl={imagesList[currentIndex] || ""}
            rois={rois}
            ocrResults={ocrResults}
            setOcrResults={setOcrResults}
            onBackToStudio={() => setCurrentStep("studio")} 
            onApproveAndSave={handleApproveAndSave}
            imageList={imagesList}
            currentImageIndex={currentIndex}
            onImageIndexChange={(nextIdx) => setCurrentIndex(nextIdx)}
          />
        )}
      </div>
    </main>
  );
}