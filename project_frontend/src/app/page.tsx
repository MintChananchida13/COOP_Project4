"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import AdjustZone from "../components/AdjustZone";
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
  cropCorners: { x: number; y: number }[] | null;
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

const cropRoiToImage = (
  imgEl: HTMLImageElement,
  roi: { x: number; y: number; width: number; height: number; points?: { x: number; y: number }[] },
  scaleX: number,
  scaleY: number
): string | null => {
  if (!imgEl || !imgEl.complete || imgEl.naturalWidth === 0) return null;

  const realX = roi.x * scaleX;
  const realY = roi.y * scaleY;
  const realW = roi.width * scaleX;
  const realH = roi.height * scaleY;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(realW));
  canvas.height = Math.max(1, Math.round(realH));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  if (roi.points && roi.points.length > 2) {
    ctx.beginPath();
    roi.points.forEach((p, idx) => {
      const px = p.x * scaleX - realX;
      const py = p.y * scaleY - realY;
      if (idx === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    });
    ctx.closePath();
    ctx.clip();
  }

  ctx.drawImage(
    imgEl,
    Math.max(0, realX),
    Math.max(0, realY),
    Math.max(1, realW),
    Math.max(1, realH),
    0,
    0,
    Math.max(1, realW),
    Math.max(1, realH)
  );
  ctx.restore();

  return canvas.toDataURL("image/jpeg", 0.95);
};

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
    setPreviewUrl(urls[0] || "");
    setImage(urls[0] || null);
    setRois([]);
    setSelectedId(null);
    setOcrResults([]);
    setPagesConfig(
      urls.map(() => ({
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
      }))
    );
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
    setPreviewUrl(finalProcessedImages[currentIndex] || finalProcessedImages[0] || "");
    setImage(finalProcessedImages[currentIndex] || finalProcessedImages[0] || null);
    setRois([]);
    setSelectedId(null);
    setOcrResults([]);
    setCurrentStep("studio");
  };

  const handleRunOCR = async () => {
    const activeRois = rois.filter((roi) => roi.enabled !== false);
    if (activeRois.length === 0) {
      alert("กรุณาวาดหรือเปิดใช้งาน ROI อย่างน้อย 1 กล่องก่อนอ่าน OCR");
      return;
    }

    setIsLoading(true);
    setOcrResults([]);

    try {
      const activePageIndexes = Array.from(
        new Set(activeRois.map((roi) => (roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0)))
      );

      const allPagePromises = activePageIndexes.map(async (pageIdx) => {
        const pageRois = rois.filter(
          (roi) => (roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0) === pageIdx
        );

        if (pageRois.length === 0) return [];

        const currentImgUrl = imagesList[pageIdx];
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const imageObj = new Image();
          imageObj.onload = () => resolve(imageObj);
          imageObj.onerror = (err) => reject(err);
          imageObj.src = currentImgUrl;
        });

        const renderedWidth = 750;
        const renderedHeight = (img.naturalHeight / img.naturalWidth) * renderedWidth;

        const scaleX = img.naturalWidth / renderedWidth;
        const scaleY = img.naturalHeight / renderedHeight;

        const roiPromises = pageRois.map(async (roi, rIdx) => {
          const croppedBase64 = cropRoiToImage(img, roi, scaleX, scaleY);
          if (!croppedBase64) return null;

          try {
            const response = await fetch("http://localhost:8000/api/ai/process", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                image: croppedBase64,
                rois: [
                  {
                    fieldName: roi.fieldName,
                    x: 0,
                    y: 0,
                    width: roi.width * scaleX,
                    height: roi.height * scaleY,
                  },
                ],
              }),
            });

            const aiData = await response.json();
            if (aiData.success && aiData.extracted_data.length > 0) {
              const resItem = aiData.extracted_data[0];
              return {
                id: Date.now() + pageIdx * 100000 + rIdx + Math.floor(Math.random() * 1000000),
                fieldName: resItem.fieldName,
                bbox: [],
                extractedText: resItem.text,
                originalText: resItem.text,
                confidence: resItem.confidence,
                saved_path: resItem.saved_path || "",
                pageIndex: pageIdx,
                type: roi.type || "text",
                dataType: roi.dataType || "string",
                role: roi.role || "data_extraction",
                weight: roi.weight !== undefined ? roi.weight : 1.0,
                points: roi.points,
              };
            }
          } catch (innerErr) {
            console.error(`Error processing ROI ${roi.fieldName}:`, innerErr);
          }
          return null;
        });

        const roiResults = await Promise.all(roiPromises);
        return roiResults.filter((r) => r !== null) as (OCRResult & { pageIndex?: number })[];
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
      console.error(err);
      alert("เกิดข้อผิดพลาดในการประมวลผลภาพรวมพร้อมกันทุกหน้า");
    } finally {
      setIsLoading(false);
    }
  };

  const handleRunFullPageOCR = async () => {
    setIsLoading(true);
    setOcrResults([]);

    try {
      const currentImgUrl = imagesList[currentIndex];
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const imageObj = new Image();
        imageObj.onload = () => resolve(imageObj);
        imageObj.onerror = (err) => reject(err);
        imageObj.src = currentImgUrl;
      });

      const renderedWidth = 750;
      const renderedHeight = (img.naturalHeight / img.naturalWidth) * renderedWidth;
      const scaleX = img.naturalWidth / renderedWidth;
      const scaleY = img.naturalHeight / renderedHeight;

      const response = await fetch("http://localhost:8000/api/ai/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: currentImgUrl,
          rois: [],
        }),
      });

      const aiData = await response.json();
      if (aiData.success && aiData.extracted_data.length > 0) {
        const newRoisFromOcr: (ROI & { pageIndex?: number })[] = aiData.extracted_data.map((item: any, idx: number) => {
          const rx = item.x / scaleX;
          const ry = item.y / scaleY;
          const rw = item.width / scaleX;
          const rh = item.height / scaleY;

          const pts = item.bbox
            ? item.bbox.map((pt: any) => ({
                x: pt[0] / scaleX,
                y: pt[1] / scaleY,
              }))
            : undefined;

          return {
            id: Date.now() + idx + Math.floor(Math.random() * 1000000),
            fieldName: item.fieldName || `line_${idx + 1}`,
            x: rx,
            y: ry,
            width: rw,
            height: rh,
            pageIndex: currentIndex,
            type: "text",
            dataType: "string",
            role: "data_extraction",
            points: pts,
          };
        });

        setRois((prev) => {
          const otherPagesRois = prev.filter(
            (r) => (r.pageIndex !== undefined ? Number(r.pageIndex) : 0) !== currentIndex
          );
          return [...otherPagesRois, ...newRoisFromOcr];
        });

        const newOcrResults: (OCRResult & { pageIndex?: number })[] = aiData.extracted_data.map((item: any, idx: number) => {
          const pts = item.bbox
            ? item.bbox.map((pt: any) => ({
                x: pt[0] / scaleX,
                y: pt[1] / scaleY,
              }))
            : undefined;

          return {
            id: Date.now() + idx + 1000000 + Math.floor(Math.random() * 1000000),
            fieldName: item.fieldName || `line_${idx + 1}`,
            bbox: [],
            extractedText: item.text,
            originalText: item.text,
            confidence: item.confidence,
            saved_path: item.saved_path || "",
            pageIndex: currentIndex,
            type: "text",
            dataType: "string",
            role: "data_extraction",
            points: pts,
          };
        });

        setOcrResults(newOcrResults);
        setCurrentStep("editor");
      } else {
        alert("ไม่พบข้อความใดๆ บนหน้ากระดาษใบนี้จากการสแกนด้วย AI Engine");
      }
    } catch (err) {
      console.error(err);
      alert("เกิดข้อผิดพลาดในการรัน OCR อัตโนมัติทั้งหน้ากระดาษ");
    } finally {
      setIsLoading(false);
    }
  };

  const handleApproveAndSave = async () => {
    const currentPageResults = ocrResults.filter((res) => {
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
      alert(`บันทึกข้อมูลของเอกสารหน้า ${currentIndex + 1} เรียบร้อยแล้ว!`);
    } catch (error) {
      console.error(error);
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
            previewUrl={imagesList[currentIndex] || previewUrl}
            image={imagesList[currentIndex] || image}
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
            onRunOCR={handleRunOCR}
            onRunFullPageOCR={handleRunFullPageOCR}
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
            previewUrl={imagesList[currentIndex] || previewUrl}
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
