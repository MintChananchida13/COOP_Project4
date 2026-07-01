"use client";

import React from "react";

interface WorkspaceCanvasProps {
  imageSrc: string;
  children?: React.ReactNode;
  imageRef?: React.RefObject<HTMLImageElement | null>;
  width?: number;
  zoom?: number;
  onMouseDown?: React.MouseEventHandler<HTMLDivElement>;
  onMouseMove?: React.MouseEventHandler<HTMLDivElement>;
  onMouseUp?: React.MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLDivElement>;
  onDoubleClick?: React.MouseEventHandler<HTMLDivElement>;
  className?: string;
}

export default function WorkspaceCanvas({
  imageSrc,
  children,
  imageRef,
  width = 750,
  zoom = 1,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  onMouseLeave,
  onDoubleClick,
  className = "",
}: WorkspaceCanvasProps) {
  return (
    <div className={`flex-1 min-w-0 bg-[#edf2f7] border border-slate-200 rounded-xl overflow-auto p-6 shadow-inner ${className}`}>
      <div
        className="relative inline-block"
        style={{
          transform: `scale(${zoom})`,
          transformOrigin: "top left",
          transition: "transform 0.1s ease-out",
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onDoubleClick={onDoubleClick}
      >
        <div className="relative bg-transparent" style={{ width }}>
          {imageSrc && (
            <img
              ref={imageRef}
              src={imageSrc}
              alt="Workspace page"
              draggable="false"
              className="w-full h-auto block select-none pointer-events-none border border-slate-300 shadow-xl rounded bg-white"
            />
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
