"use client";

import { ChangeEvent, useEffect, useState } from "react";
import { DetectionDevResult, detectTemplateDev } from "./adminApi";

const formatScore = (score?: number) => (typeof score === "number" ? score.toFixed(4) : "N/A");

export default function AdminDetectionLabPage() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [result, setResult] = useState<DetectionDevResult | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!file || file.type === "application/pdf") {
      setPreviewUrl("");
      return;
    }
    const nextUrl = URL.createObjectURL(file);
    setPreviewUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  const pages = result?.pages || [];
  const currentPage = pages[pageIndex] || pages[0] || null;
  const bestCandidate = result?.bestCandidate || null;
  const visibleCandidates = currentPage?.candidates.length ? currentPage.candidates : result?.candidates || [];

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] || null;
    setError("");
    setResult(null);
    setPageIndex(0);
    if (!nextFile) {
      setFile(null);
      return;
    }
    const isSupported =
      nextFile.type === "application/pdf" ||
      nextFile.type === "image/png" ||
      nextFile.type === "image/jpeg" ||
      nextFile.type === "image/webp";
    if (!isSupported) {
      setFile(null);
      setError("Please choose a PNG, JPEG, WebP, or PDF file.");
      return;
    }
    setFile(nextFile);
  };

  const runDetection = async () => {
    if (!file) {
      setError("Please select an image or PDF first.");
      return;
    }
    setIsRunning(true);
    setError("");
    setResult(null);
    setPageIndex(0);
    try {
      setResult(await detectTemplateDev(file));
    } catch (err) {
      console.warn("Detection lab failed.", err);
      setError(err instanceof Error ? err.message : "Detection failed.");
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-black text-slate-900">Detection Lab</h2>
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-black uppercase text-amber-700">DEV STUB</span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">Local vector store</span>
            </div>
            <p className="mt-2 text-sm font-semibold text-slate-500">
              Upload image/PDF to test template matching against active embedded templates.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Test Document</h3>
          <label className="mt-3 flex cursor-pointer flex-col rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-xs font-bold text-slate-600 hover:bg-white">
            <input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={handleFileChange} className="sr-only" />
            <span className="text-sm font-black text-slate-800">Choose PNG, JPEG, WebP, or PDF</span>
            <span className="mt-1">{file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : "No file selected"}</span>
          </label>

          <button
            type="button"
            onClick={runDetection}
            disabled={!file || isRunning}
            className="mt-4 w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-black text-white disabled:bg-slate-300 disabled:text-slate-500"
          >
            {isRunning ? "Running Detection..." : "Run Detection"}
          </button>
          {error && <p className="mt-3 rounded-xl bg-red-50 p-3 text-xs font-bold text-red-700">{error}</p>}

          <div className="mt-4">
            {previewUrl ? (
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                <img src={previewUrl} alt="Detection lab upload preview" className="max-h-[380px] w-full object-contain" />
              </div>
            ) : file?.type === "application/pdf" ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs font-semibold text-slate-500">
                PDF selected. Page previews will appear after detection runs.
              </div>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs font-semibold text-slate-500">No preview yet.</div>
            )}
          </div>
        </section>

        <section className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Detection Result</h3>
            {!result ? (
              <p className="mt-3 rounded-xl bg-slate-50 p-4 text-xs font-semibold text-slate-500">Run detection to see matching candidates.</p>
            ) : (
              <div className="mt-3 space-y-3 text-xs font-semibold text-slate-700">
                <div className="flex flex-wrap gap-2 text-[10px] font-black uppercase">
                  <span className={`rounded-full px-2.5 py-1 ${result.matched ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                    Matched {result.matched ? "YES" : "NO"}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">Threshold {result.threshold}</span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">Pages {result.pages.length || 1}</span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">{result.version}</span>
                </div>

                {bestCandidate ? (
                  <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-3 text-indigo-900">
                    <div className="text-[10px] font-black uppercase tracking-wider text-indigo-700">Best Candidate</div>
                    <div className="mt-2 grid gap-1 sm:grid-cols-2">
                      <p>Template: {bestCandidate.templateName || "N/A"}</p>
                      <p>Template ID: {bestCandidate.templateId || "N/A"}</p>
                      <p>Score: {formatScore(bestCandidate.score)}</p>
                      <p>Status: {bestCandidate.templateStatus || "N/A"}</p>
                      <p>Vector ID: {bestCandidate.vectorId || "N/A"}</p>
                      <p>Pages: {bestCandidate.pageCount ?? "N/A"}</p>
                      <p>Fields: {bestCandidate.fieldCount ?? "N/A"}</p>
                      <p>Model: {bestCandidate.modelName || "N/A"}</p>
                      <p>Vector Store: {bestCandidate.vectorStoreEngine || "N/A"}</p>
                    </div>
                  </div>
                ) : result.message ? (
                  <p className="rounded-xl bg-amber-50 p-3 font-bold text-amber-700">{result.message}</p>
                ) : (
                  <p className="rounded-xl bg-amber-50 p-3 font-bold text-amber-700">No template matched the threshold.</p>
                )}

                {!result.matched && result.candidates.length > 0 && (
                  <p className="rounded-xl bg-amber-50 p-3 font-bold text-amber-700">No template matched the threshold.</p>
                )}
                {result.candidates.length === 0 && (
                  <p className="rounded-xl bg-amber-50 p-3 font-bold text-amber-700">
                    No embedded active templates found. Please validate and run embedding for at least one template first.
                  </p>
                )}
              </div>
            )}
          </div>

          {pages.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap gap-2">
                {pages.map((page, index) => (
                  <button
                    key={`detection-lab-page-${page.pageIndex}`}
                    type="button"
                    onClick={() => setPageIndex(index)}
                    className={`rounded-lg px-3 py-1.5 text-[10px] font-black ${
                      pageIndex === index ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-600"
                    }`}
                  >
                    Page {page.pageIndex}
                  </button>
                ))}
              </div>
              {currentPage?.imagePreviewDataUrl && (
                <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                  <img src={currentPage.imagePreviewDataUrl} alt={`Detection page ${currentPage.pageIndex}`} className="max-h-[360px] w-full object-contain" />
                </div>
              )}
              {currentPage && (
                <div className="mt-3 rounded-xl border border-slate-200 p-3 text-xs font-semibold text-slate-700">
                  Page {currentPage.pageIndex}: {currentPage.matched ? "Matched" : "No match"}
                  {currentPage.bestCandidate ? `, score ${formatScore(currentPage.bestCandidate.score)}` : ""}
                </div>
              )}
            </section>
          )}

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-700">Candidates</h3>
            <div className="mt-3 overflow-hidden rounded-xl border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Rank</th>
                    <th className="px-3 py-2">Template Name</th>
                    <th className="px-3 py-2">Score</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Vector ID</th>
                    <th className="px-3 py-2">Pages</th>
                    <th className="px-3 py-2">Fields</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                  {visibleCandidates.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-4 text-center text-slate-500">
                        No candidates to display.
                      </td>
                    </tr>
                  ) : (
                    visibleCandidates.map((candidate, index) => (
                      <tr key={`${candidate.vectorId || "candidate"}-${index}`}>
                        <td className="px-3 py-2">{index + 1}</td>
                        <td className="px-3 py-2">{candidate.templateName || "N/A"}</td>
                        <td className="px-3 py-2">{formatScore(candidate.score)}</td>
                        <td className="px-3 py-2">{candidate.templateStatus || "N/A"}</td>
                        <td className="px-3 py-2">{candidate.vectorId || "N/A"}</td>
                        <td className="px-3 py-2">{candidate.pageCount ?? "N/A"}</td>
                        <td className="px-3 py-2">{candidate.fieldCount ?? "N/A"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </section>
      </div>
    </section>
  );
}
