"use client";

import { ROI } from "../../types/ocr";

export type RoiBoxMode = "readonly" | "editable";

export interface WorkspaceRoi extends ROI {
  pageIndex?: number;
  checked?: boolean;
  dimmed?: boolean;
}

interface RoiBoxProps {
  roi: WorkspaceRoi;
  selected?: boolean;
  checked?: boolean;
  dimmed?: boolean;
  readonly?: boolean;
  editable?: boolean;
  showLabel?: boolean;
  onSelect?: (id: number) => void;
}

export default function RoiBox({
  roi,
  selected = false,
  checked = true,
  dimmed = false,
  readonly = true,
  editable = false,
  showLabel = true,
  onSelect,
}: RoiBoxProps) {
  const hasPoints = roi.points && roi.points.length > 0;
  const isDimmed = dimmed || !checked;

  return (
    <button
      type="button"
      onClick={() => onSelect?.(roi.id)}
      className={`absolute text-left transition-all ${readonly && !editable ? "cursor-default" : "cursor-pointer"} ${
        isDimmed ? "opacity-25" : "opacity-100"
      } ${selected || checked ? "z-30" : "z-20"}`}
      style={{
        left: roi.x,
        top: roi.y,
        width: roi.width,
        height: roi.height,
      }}
      aria-label={roi.fieldName}
    >
      <div
        className={`relative w-full h-full border ${
          selected || checked
            ? "border-indigo-600 bg-indigo-500/15 ring-2 ring-indigo-500/20"
            : "border-slate-400 bg-slate-400/5"
        } ${readonly ? "border-dashed" : "border-solid"}`}
      >
        {hasPoints && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
            <polygon
              points={roi.points?.map((p) => `${p.x - roi.x},${p.y - roi.y}`).join(" ")}
              fill={selected || checked ? "rgba(79, 70, 229, 0.18)" : "rgba(100, 116, 139, 0.08)"}
              stroke={selected || checked ? "#4f46e5" : "#64748b"}
              strokeWidth="2"
              strokeDasharray={readonly ? "4,3" : "0"}
            />
          </svg>
        )}
        {showLabel && (
          <span
            className={`absolute -top-5 left-0 max-w-[220px] truncate px-1.5 py-0.5 text-[9px] font-bold rounded border shadow-sm ${
              selected || checked
                ? "bg-indigo-600 border-indigo-600 text-white"
                : "bg-white border-slate-200 text-slate-500"
            }`}
          >
            {roi.fieldName || "Unnamed"}
          </span>
        )}
      </div>
    </button>
  );
}
