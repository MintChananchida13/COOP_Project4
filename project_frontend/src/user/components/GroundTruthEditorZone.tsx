"use client";

import React, { useState, useRef, useMemo, useEffect } from 'react';
import { ArrowLeft, Save, ZoomIn, ZoomOut, Maximize2, CheckCircle, Edit3, ChevronLeft, ChevronRight, Table, Image as ImageIcon, FileText, Eye, EyeOff, Undo2, Redo2 } from 'lucide-react';
import { ROI, OCRResult, TableMergedCell } from '../../types/ocr';

const renderTypeIcon = (type?: 'text' | 'table' | 'image', size = 11) => {
  if (type === 'table') return <Table size={size} className="shrink-0 text-slate-400" />;
  if (type === 'image') return <ImageIcon size={size} className="shrink-0 text-slate-400" />;
  return <FileText size={size} className="shrink-0 text-slate-400" />;
};

type DisplayFieldType = 'text' | 'table' | 'image';

const getFieldTypeLabel = (type: DisplayFieldType) => {
  if (type === "table") return "ตาราง";
  if (type === "image") return "รูปภาพ";
  return "ข้อความ";
};

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Unable to read image blob"));
    reader.readAsDataURL(blob);
  });

const imageUrlToCanvasSafeSrc = async (src: string) => {
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return src;
  const response = await fetch(src, { mode: "cors" });
  if (!response.ok) throw new Error(`Unable to load preview image: ${response.status}`);
  return blobToDataUrl(await response.blob());
};

const loadCanvasSafeImage = async (src: string) =>
  new Promise<HTMLImageElement>(async (resolve, reject) => {
    try {
      const safeSrc = await imageUrlToCanvasSafeSrc(src);
      const img = new Image();
      if (!safeSrc.startsWith("data:") && !safeSrc.startsWith("blob:")) {
        img.crossOrigin = "anonymous";
      }
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = safeSrc;
    } catch (error) {
      reject(error);
    }
  });

const getRawOcrText = (result: OCRResult & { pageIndex?: number }) =>
  result.originalText !== undefined ? result.originalText : result.extractedText;

const parseMarkdownTable = (value: string): string[][] | null => {
  const rows = value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.includes("|"))
    .map(line => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim()));

  if (rows.length < 2) return null;
  const withoutSeparator = rows.filter(row => !row.every(cell => /^:?-{3,}:?$/.test(cell)));
  return withoutSeparator.length >= 2 ? withoutSeparator : null;
};

const parsePlainTextTable = (value: string): string[][] | null => {
  const lines = value
    .split(/\r?\n/)
    .map(line => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);

  if (lines.length === 0) return null;

  const rows = lines.map(line => {
    const spacedColumns = line.split(/\s{2,}/).map(cell => cell.trim()).filter(Boolean);
    if (spacedColumns.length > 1) return spacedColumns;
    return line.split(/\s+/).map(cell => cell.trim()).filter(Boolean);
  });

  const maxColumns = Math.min(8, Math.max(...rows.map(row => row.length), 1));
  return rows.map(row => {
    if (row.length <= maxColumns) return [...row, ...Array(maxColumns - row.length).fill("")];
    return [...row.slice(0, maxColumns - 1), row.slice(maxColumns - 1).join(" ")];
  });
};

const parseJsonTable = (value: string): string[][] | null => {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every(row => Array.isArray(row))) {
      return parsed.map(row => row.map(cell => String(cell ?? "")));
    }
    if (Array.isArray(parsed) && parsed.every(row => row && typeof row === "object" && !Array.isArray(row))) {
      const keys = Array.from(new Set(parsed.flatMap(row => Object.keys(row))));
      return [keys, ...parsed.map(row => keys.map(key => String(row[key] ?? "")))];
    }
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.rows)) {
      const rows = parsed.rows;
      if (rows.every((row: unknown) => Array.isArray(row))) {
        return rows.map((row: unknown[]) => row.map(cell => String(cell ?? "")));
      }
    }
  } catch {
    return null;
  }
  return null;
};

const parseTableText = (value: string): string[][] | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\(?no\s+text\s+found\s+in\s+roi\)?$/i.test(trimmed)) return null;
  return parseJsonTable(trimmed) || parseMarkdownTable(trimmed) || parsePlainTextTable(trimmed);
};

const parseHtmlTable = (value?: string): string[][] | null => {
  if (!value || !value.toLowerCase().includes("<table")) return null;
  try {
    const doc = new DOMParser().parseFromString(value, "text/html");
    const rows = Array.from(doc.querySelectorAll("tr")).map((row) => {
      const cells: string[] = [];
      Array.from(row.querySelectorAll("th,td")).forEach((cell) => {
        const text = (cell.textContent || "").replace(/\s+/g, " ").trim();
        const span = Math.max(1, Number(cell.getAttribute("colspan") || 1));
        cells.push(text);
        for (let index = 1; index < span; index += 1) cells.push("");
      });
      return cells;
    });
    const usefulRows = rows.filter((row) => row.some((cell) => cell.trim()));
    return usefulRows.length > 0 ? usefulRows : rows.filter((row) => row.length > 0);
  } catch {
    return null;
  }
};

const normalizeTableRows = (rows?: unknown): string[][] | null => {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const normalized = rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => String(cell ?? "")));
  return normalized.length > 0 ? normalized : null;
};

const tableRowsToMarkdown = (rows: string[][]): string => {
  const cleanedRows = rows.map(row => row.map(cell => cell.trimEnd()));
  const maxColumns = Math.max(...cleanedRows.map(row => row.length), 1);
  const normalizedRows = cleanedRows.map(row => [...row, ...Array(maxColumns - row.length).fill("")]);
  const [header = [], ...bodyRows] = normalizedRows;
  const safeHeader = header.map((cell, index) => cell || `Column ${index + 1}`);
  const formatRow = (row: string[]) => `| ${row.map(cell => cell.replace(/\|/g, "/")).join(" | ")} |`;
  return [
    formatRow(safeHeader),
    formatRow(Array(maxColumns).fill("---")),
    ...bodyRows.map(formatRow),
  ].join("\n");
};

const tableRowsFromResult = (result: OCRResult & { pageIndex?: number }, value?: string): string[][] | null =>
  normalizeTableRows(result.tableRows) || parseHtmlTable(result.tableHtml) || parseTableText(value ?? result.extractedText ?? getRawOcrText(result));

type TableSelection = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};

type TableEditorSnapshot = {
  rows: string[][];
  mergedCells: TableMergedCell[];
};

type TableContextMenuState = {
  x: number;
  y: number;
};

const normalizeEditableRows = (rows?: string[][] | null): string[][] => {
  const usefulRows = rows && rows.length > 0 ? rows : [["Column 1"], [""]];
  const maxColumns = Math.max(...usefulRows.map(row => row.length), 1);
  return usefulRows.map(row => [...row.map(cell => String(cell ?? "")), ...Array(maxColumns - row.length).fill("")]);
};

const cloneMergedCells = (cells?: TableMergedCell[]): TableMergedCell[] =>
  (cells || []).map(cell => ({
    ...cell,
    originalCells: cell.originalCells?.map(row => [...row]),
  }));

const tableCellKey = (row: number, col: number) => `${row}:${col}`;

const getSelectionBounds = (selection: TableSelection | null) => {
  if (!selection) return null;
  return {
    top: Math.min(selection.startRow, selection.endRow),
    bottom: Math.max(selection.startRow, selection.endRow),
    left: Math.min(selection.startCol, selection.endCol),
    right: Math.max(selection.startCol, selection.endCol),
  };
};

const isCellInSelection = (row: number, col: number, selection: TableSelection | null) => {
  const bounds = getSelectionBounds(selection);
  if (!bounds) return false;
  return row >= bounds.top && row <= bounds.bottom && col >= bounds.left && col <= bounds.right;
};

const getMergeAtAnchor = (mergedCells: TableMergedCell[], row: number, col: number) =>
  mergedCells.find(cell => cell.row === row && cell.col === col);

const getMergeContainingCell = (mergedCells: TableMergedCell[], row: number, col: number) =>
  mergedCells.find(cell =>
    row >= cell.row &&
    row < cell.row + cell.rowSpan &&
    col >= cell.col &&
    col < cell.col + cell.colSpan
  );

const isCoveredByMergedCell = (mergedCells: TableMergedCell[], row: number, col: number) => {
  const merge = getMergeContainingCell(mergedCells, row, col);
  return Boolean(merge && (merge.row !== row || merge.col !== col));
};

const mergeIntersectsBounds = (merge: TableMergedCell, bounds: NonNullable<ReturnType<typeof getSelectionBounds>>) =>
  merge.row <= bounds.bottom &&
  merge.row + merge.rowSpan - 1 >= bounds.top &&
  merge.col <= bounds.right &&
  merge.col + merge.colSpan - 1 >= bounds.left;

const sanitizeTableSnapshot = (snapshot: TableEditorSnapshot): TableEditorSnapshot => {
  const rows = normalizeEditableRows(snapshot.rows);
  const rowCount = rows.length;
  const colCount = rows[0]?.length || 1;
  const occupied = new Set<string>();
  const mergedCells: TableMergedCell[] = [];

  cloneMergedCells(snapshot.mergedCells).forEach(cell => {
    const row = Math.max(0, Math.min(cell.row, rowCount - 1));
    const col = Math.max(0, Math.min(cell.col, colCount - 1));
    const rowSpan = Math.max(1, Math.min(cell.rowSpan, rowCount - row));
    const colSpan = Math.max(1, Math.min(cell.colSpan, colCount - col));
    if (rowSpan === 1 && colSpan === 1) return;

    const keys: string[] = [];
    for (let r = row; r < row + rowSpan; r += 1) {
      for (let c = col; c < col + colSpan; c += 1) {
        keys.push(tableCellKey(r, c));
      }
    }
    if (keys.some(key => occupied.has(key))) return;
    keys.forEach(key => occupied.add(key));
    mergedCells.push({
      ...cell,
      row,
      col,
      rowSpan,
      colSpan,
      originalCells: cell.originalCells?.slice(0, rowSpan).map(sourceRow => [
        ...sourceRow.slice(0, colSpan),
        ...Array(Math.max(0, colSpan - sourceRow.length)).fill(""),
      ]),
    });
  });

  return { rows, mergedCells };
};

const snapshotToKey = (snapshot: TableEditorSnapshot) => JSON.stringify(snapshot);

const getSpreadsheetColumnLabel = (index: number) => {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
};

const EditableTableResult = ({
  value,
  rows: sourceRows,
  mergedCells,
  onChange,
}: {
  value: string;
  rows?: string[][] | null;
  mergedCells?: TableMergedCell[];
  onChange: (nextValue: string, nextRows: string[][], nextMergedCells: TableMergedCell[]) => void;
}) => {
  const sourceSnapshot = useMemo(
    () => sanitizeTableSnapshot({
      rows: normalizeEditableRows(sourceRows || parseTableText(value)),
      mergedCells: cloneMergedCells(mergedCells),
    }),
    [sourceRows, value, mergedCells]
  );
  const sourceKey = snapshotToKey(sourceSnapshot);
  const [snapshot, setSnapshot] = useState<TableEditorSnapshot>(sourceSnapshot);
  const [history, setHistory] = useState<TableEditorSnapshot[]>([sourceSnapshot]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [selection, setSelection] = useState<TableSelection | null>(null);
  const [contextMenu, setContextMenu] = useState<TableContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (sourceKey === snapshotToKey(snapshot)) return;
    setSnapshot(sourceSnapshot);
    setHistory([sourceSnapshot]);
    setHistoryIndex(0);
    setSelection(null);
  }, [sourceKey]);

  const commitSnapshot = (nextSnapshot: TableEditorSnapshot) => {
    const sanitized = sanitizeTableSnapshot(nextSnapshot);
    const nextHistory = [...history.slice(0, historyIndex + 1), sanitized];
    setSnapshot(sanitized);
    setHistory(nextHistory);
    setHistoryIndex(nextHistory.length - 1);
    onChange(tableRowsToMarkdown(sanitized.rows), sanitized.rows, sanitized.mergedCells);
  };

  const restoreSnapshot = (nextIndex: number) => {
    const nextSnapshot = history[nextIndex];
    if (!nextSnapshot) return;
    setSnapshot(nextSnapshot);
    setHistoryIndex(nextIndex);
    onChange(tableRowsToMarkdown(nextSnapshot.rows), nextSnapshot.rows, nextSnapshot.mergedCells);
  };

  const handleKeyboardShortcuts = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const key = event.key.toLowerCase();
    const isUndo = (event.ctrlKey || event.metaKey) && !event.shiftKey && key === "z";
    const isRedo =
      ((event.ctrlKey || event.metaKey) && event.shiftKey && key === "z") ||
      (event.ctrlKey && !event.shiftKey && key === "y");

    if (isUndo && historyIndex > 0) {
      event.preventDefault();
      restoreSnapshot(historyIndex - 1);
      return;
    }

    if (isRedo && historyIndex < history.length - 1) {
      event.preventDefault();
      restoreSnapshot(historyIndex + 1);
    }
  };

  useEffect(() => {
    if (!contextMenu) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  const selectCell = (row: number, col: number, extend: boolean) => {
    setSelection(prev =>
      extend && prev
        ? { ...prev, endRow: row, endCol: col }
        : { startRow: row, startCol: col, endRow: row, endCol: col }
    );
  };

  const rows = snapshot.rows;
  const merged = snapshot.mergedCells;
  const maxColumns = rows[0]?.length || 1;
  const bounds = getSelectionBounds(selection);
  const selectedMerge = bounds ? getMergeContainingCell(merged, bounds.top, bounds.left) : null;
  const hasRangeSelection = Boolean(bounds && (bounds.top !== bounds.bottom || bounds.left !== bounds.right));
  const canMergeSelection = Boolean(
    bounds &&
    hasRangeSelection &&
    !merged.some(cell => mergeIntersectsBounds(cell, bounds))
  );

  const selectRow = (rowIndex: number) => {
    setSelection({ startRow: rowIndex, endRow: rowIndex, startCol: 0, endCol: maxColumns - 1 });
  };

  const selectColumn = (cellIndex: number) => {
    setSelection({ startRow: 0, endRow: rows.length - 1, startCol: cellIndex, endCol: cellIndex });
  };

  const selectAllTable = () => {
    setSelection({ startRow: 0, endRow: rows.length - 1, startCol: 0, endCol: maxColumns - 1 });
  };

  const openContextMenu = (event: React.MouseEvent, rowIndex: number, cellIndex: number) => {
    event.preventDefault();
    event.stopPropagation();
    selectCell(rowIndex, cellIndex, false);
    const menuWidth = 224;
    const menuHeight = 250;
    const padding = 8;
    const x = Math.max(padding, Math.min(event.clientX, window.innerWidth - menuWidth - padding));
    const y = Math.max(padding, Math.min(event.clientY, window.innerHeight - menuHeight - padding));
    setContextMenu({ x, y });
  };

  const runContextAction = (action: () => void) => {
    action();
    setContextMenu(null);
  };

  const updateCell = (rowIndex: number, cellIndex: number, nextValue: string) => {
    const nextRows = rows.map(row => [...row]);
    nextRows[rowIndex][cellIndex] = nextValue;
    commitSnapshot({ rows: nextRows, mergedCells: merged });
  };

  const insertRow = (where: "above" | "below") => {
    if (!bounds) return;
    const insertIndex = where === "above" ? bounds.top : bounds.bottom + 1;
    const nextRows = rows.map(row => [...row]);
    nextRows.splice(insertIndex, 0, Array(maxColumns).fill(""));
    const nextMerged = cloneMergedCells(merged).map(cell => {
      if (insertIndex <= cell.row) return { ...cell, row: cell.row + 1 };
      if (insertIndex > cell.row && insertIndex < cell.row + cell.rowSpan) {
        const originalCells = cell.originalCells?.map(row => [...row]) || [];
        originalCells.splice(insertIndex - cell.row, 0, Array(cell.colSpan).fill(""));
        return { ...cell, rowSpan: cell.rowSpan + 1, originalCells };
      }
      return cell;
    });
    commitSnapshot({ rows: nextRows, mergedCells: nextMerged });
    setSelection({ startRow: insertIndex, endRow: insertIndex, startCol: 0, endCol: 0 });
  };

  const deleteRows = () => {
    if (!bounds || rows.length <= 1) return;
    const deleteTop = bounds.top;
    const deleteBottom = Math.min(bounds.bottom, rows.length - 1);
    const nextRows = rows.filter((_, index) => index < deleteTop || index > deleteBottom);
    const deletedCount = deleteBottom - deleteTop + 1;
    const nextMerged = cloneMergedCells(merged).flatMap(cell => {
      const cellBottom = cell.row + cell.rowSpan - 1;
      if (cellBottom < deleteTop) return [cell];
      if (cell.row > deleteBottom) return [{ ...cell, row: cell.row - deletedCount }];

      const overlapTop = Math.max(cell.row, deleteTop);
      const overlapBottom = Math.min(cellBottom, deleteBottom);
      const overlapCount = overlapBottom - overlapTop + 1;
      const nextRowSpan = cell.rowSpan - overlapCount;
      if (nextRowSpan <= 0 || (nextRowSpan === 1 && cell.colSpan === 1)) return [];

      const originalCells = cell.originalCells?.map(row => [...row]) || [];
      if (originalCells.length > 0) {
        originalCells.splice(overlapTop - cell.row, overlapCount);
      }
      return [{
        ...cell,
        row: cell.row >= deleteTop ? deleteTop : cell.row,
        rowSpan: nextRowSpan,
        originalCells,
      }];
    });
    commitSnapshot({ rows: nextRows.length > 0 ? nextRows : [["Column 1"]], mergedCells: nextMerged });
    setSelection({ startRow: Math.min(deleteTop, Math.max(0, nextRows.length - 1)), endRow: Math.min(deleteTop, Math.max(0, nextRows.length - 1)), startCol: 0, endCol: 0 });
  };

  const insertColumn = (where: "left" | "right") => {
    if (!bounds) return;
    const insertIndex = where === "left" ? bounds.left : bounds.right + 1;
    const nextRows = rows.map((row, rowIndex) => {
      const nextRow = [...row];
      nextRow.splice(insertIndex, 0, rowIndex === 0 ? `Column ${insertIndex + 1}` : "");
      return nextRow;
    });
    const nextMerged = cloneMergedCells(merged).map(cell => {
      if (insertIndex <= cell.col) return { ...cell, col: cell.col + 1 };
      if (insertIndex > cell.col && insertIndex < cell.col + cell.colSpan) {
        const originalCells = cell.originalCells?.map(row => {
          const nextRow = [...row];
          nextRow.splice(insertIndex - cell.col, 0, "");
          return nextRow;
        });
        return { ...cell, colSpan: cell.colSpan + 1, originalCells };
      }
      return cell;
    });
    commitSnapshot({ rows: nextRows, mergedCells: nextMerged });
    setSelection({ startRow: 0, endRow: 0, startCol: insertIndex, endCol: insertIndex });
  };

  const deleteColumns = () => {
    if (!bounds || maxColumns <= 1) return;
    const deleteLeft = bounds.left;
    const deleteRight = Math.min(bounds.right, maxColumns - 1);
    const deletedCount = deleteRight - deleteLeft + 1;
    const nextRows = rows.map(row => row.filter((_, index) => index < deleteLeft || index > deleteRight));
    const nextMerged = cloneMergedCells(merged).flatMap(cell => {
      const cellRight = cell.col + cell.colSpan - 1;
      if (cellRight < deleteLeft) return [cell];
      if (cell.col > deleteRight) return [{ ...cell, col: cell.col - deletedCount }];

      const overlapLeft = Math.max(cell.col, deleteLeft);
      const overlapRight = Math.min(cellRight, deleteRight);
      const overlapCount = overlapRight - overlapLeft + 1;
      const nextColSpan = cell.colSpan - overlapCount;
      if (nextColSpan <= 0 || (cell.rowSpan === 1 && nextColSpan === 1)) return [];

      const originalCells = cell.originalCells?.map(row => {
        const nextRow = [...row];
        nextRow.splice(overlapLeft - cell.col, overlapCount);
        return nextRow;
      });
      return [{
        ...cell,
        col: cell.col >= deleteLeft ? deleteLeft : cell.col,
        colSpan: nextColSpan,
        originalCells,
      }];
    });
    commitSnapshot({ rows: nextRows, mergedCells: nextMerged });
    setSelection({ startRow: 0, endRow: 0, startCol: Math.min(deleteLeft, Math.max(0, maxColumns - deletedCount - 1)), endCol: Math.min(deleteLeft, Math.max(0, maxColumns - deletedCount - 1)) });
  };

  const mergeSelection = () => {
    if (!bounds || !canMergeSelection) return;
    const originalCells = rows
      .slice(bounds.top, bounds.bottom + 1)
      .map(row => row.slice(bounds.left, bounds.right + 1));
    const nextRows = rows.map(row => [...row]);
    const mergedText = originalCells.flat().map(cell => cell.trim()).filter(Boolean).join(" ");
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      for (let col = bounds.left; col <= bounds.right; col += 1) {
        nextRows[row][col] = row === bounds.top && col === bounds.left ? mergedText : "";
      }
    }
    commitSnapshot({
      rows: nextRows,
      mergedCells: [
        ...merged,
        {
          id: `merged_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          row: bounds.top,
          col: bounds.left,
          rowSpan: bounds.bottom - bounds.top + 1,
          colSpan: bounds.right - bounds.left + 1,
          originalCells,
        },
      ],
    });
    setSelection({ startRow: bounds.top, startCol: bounds.left, endRow: bounds.top, endCol: bounds.left });
  };

  const splitSelectedCell = () => {
    if (!selectedMerge) return;
    const nextRows = rows.map(row => [...row]);
    selectedMerge.originalCells?.forEach((sourceRow, rowOffset) => {
      sourceRow.forEach((cellValue, colOffset) => {
        const rowIndex = selectedMerge.row + rowOffset;
        const colIndex = selectedMerge.col + colOffset;
        if (nextRows[rowIndex] && colIndex < nextRows[rowIndex].length) {
          nextRows[rowIndex][colIndex] = cellValue;
        }
      });
    });
    commitSnapshot({
      rows: nextRows,
      mergedCells: merged.filter(cell => cell.id !== selectedMerge.id),
    });
    setSelection({ startRow: selectedMerge.row, startCol: selectedMerge.col, endRow: selectedMerge.row, endCol: selectedMerge.col });
  };

  const renderEditableCell = (rowIndex: number, cellIndex: number) => {
    if (isCoveredByMergedCell(merged, rowIndex, cellIndex)) return null;
    const merge = getMergeAtAnchor(merged, rowIndex, cellIndex);
    const selected = isCellInSelection(rowIndex, cellIndex, selection);
    const Tag = rowIndex === 0 ? "th" : "td";
    return (
      <Tag
        key={`${rowIndex}-${cellIndex}`}
        rowSpan={merge?.rowSpan}
        colSpan={merge?.colSpan}
        className={`min-w-32 border p-1.5 align-top ${
          selected ? "border-indigo-500 bg-indigo-50 ring-1 ring-inset ring-indigo-400" : rowIndex === 0 ? "border-slate-300 bg-slate-100" : "border-slate-300 bg-white"
        }`}
        onClick={(event) => selectCell(rowIndex, cellIndex, event.shiftKey)}
        onContextMenu={(event) => openContextMenu(event, rowIndex, cellIndex)}
      >
        <textarea
          value={rows[rowIndex]?.[cellIndex] ?? ""}
          onFocus={() =>
            setSelection(prev => prev ?? { startRow: rowIndex, startCol: cellIndex, endRow: rowIndex, endCol: cellIndex })
          }
          onClick={(event) => selectCell(rowIndex, cellIndex, event.shiftKey)}
          onChange={(event) => updateCell(rowIndex, cellIndex, event.target.value)}
          className={`min-h-9 w-full resize-y rounded-md border border-transparent px-2 py-1 text-xs leading-5 text-slate-800 outline-none focus:border-indigo-400 focus:bg-white ${
            rowIndex === 0 ? "bg-white/80 font-black" : "bg-transparent font-medium"
          }`}
          rows={merge ? Math.max(1, merge.rowSpan) : 1}
          placeholder={rowIndex === 0 ? `Column ${cellIndex + 1}` : ""}
          spellCheck={false}
          translate="no"
        />
      </Tag>
    );
  };

  const toolbarButtonClass = "inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-[10px] font-bold text-slate-600 hover:border-indigo-200 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-40";
  const rowHeaderClass = "sticky left-0 z-20 w-12 min-w-12 border border-slate-300 bg-slate-100 px-2 py-2 text-center text-[10px] font-black text-slate-500";
  const isFullRowSelected = (rowIndex: number) =>
    Boolean(bounds && bounds.top <= rowIndex && bounds.bottom >= rowIndex && bounds.left === 0 && bounds.right === maxColumns - 1);
  const isFullColumnSelected = (cellIndex: number) =>
    Boolean(bounds && bounds.left <= cellIndex && bounds.right >= cellIndex && bounds.top === 0 && bounds.bottom === rows.length - 1);
  const allSelected = Boolean(bounds && bounds.top === 0 && bounds.left === 0 && bounds.bottom === rows.length - 1 && bounds.right === maxColumns - 1);

  return (
    <div
      className="overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm"
      onKeyDown={handleKeyboardShortcuts}
      tabIndex={0}
    >
      <div className="space-y-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">ตารางที่แก้ไขได้</p>
            <p className="mt-0.5 text-[10px] font-medium text-slate-400">คลิกขวาที่เซลล์เพื่อจัดการแถว/คอลัมน์ คลิกหัวแถวหรือหัวคอลัมน์เพื่อเลือกทั้งแถว/คอลัมน์</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => restoreSnapshot(historyIndex - 1)} disabled={historyIndex <= 0} className={toolbarButtonClass}>
              <Undo2 size={12} /> Undo
            </button>
            <button type="button" onClick={() => restoreSnapshot(historyIndex + 1)} disabled={historyIndex >= history.length - 1} className={toolbarButtonClass}>
              <Redo2 size={12} /> Redo
            </button>
            <button type="button" onClick={mergeSelection} disabled={!canMergeSelection} className={toolbarButtonClass}>
              รวมเซลล์
            </button>
            <button type="button" onClick={splitSelectedCell} disabled={!selectedMerge} className={toolbarButtonClass}>
              แยกเซลล์
            </button>
          </div>
        </div>
      </div>

      <div className="max-h-[420px] overflow-auto">
        <table className="min-w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 z-30">
            <tr>
              <th
                className={`${rowHeaderClass} ${allSelected ? "border-indigo-500 bg-indigo-100 text-indigo-700" : ""}`}
                onClick={selectAllTable}
                title="เลือกทั้งตาราง"
              >
                ทั้งหมด
              </th>
              {Array.from({ length: maxColumns }).map((_, cellIndex) => (
                <th
                  key={cellIndex}
                  className={`min-w-32 border border-slate-300 bg-slate-100 px-2 py-2 text-left text-[10px] font-black text-slate-600 ${
                    isFullColumnSelected(cellIndex) ? "border-indigo-500 bg-indigo-100 text-indigo-700" : ""
                  }`}
                  onClick={() => selectColumn(cellIndex)}
                  title="เลือกทั้งคอลัมน์"
                >
                  {getSpreadsheetColumnLabel(cellIndex)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="odd:bg-white even:bg-slate-50/60">
                <th
                  className={`${rowHeaderClass} ${isFullRowSelected(rowIndex) ? "border-indigo-500 bg-indigo-100 text-indigo-700" : ""}`}
                  onClick={() => selectRow(rowIndex)}
                  title="เลือกทั้งแถว"
                >
                  {rowIndex + 1}
                </th>
                {row.map((_, cellIndex) => renderEditableCell(rowIndex, cellIndex))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[9999] w-56 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-xs font-semibold text-slate-700 shadow-2xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          <button type="button" className="block w-full px-3 py-2 text-left hover:bg-indigo-50" onClick={() => runContextAction(() => insertRow("above"))}>
            แทรกแถวด้านบน
          </button>
          <button type="button" className="block w-full px-3 py-2 text-left hover:bg-indigo-50" onClick={() => runContextAction(() => insertRow("below"))}>
            แทรกแถวด้านล่าง
          </button>
          <button
            type="button"
            disabled={rows.length <= 1}
            className="block w-full px-3 py-2 text-left hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-white"
            onClick={() => runContextAction(deleteRows)}
          >
            ลบแถว
          </button>
          <div className="my-1 border-t border-slate-100" />
          <button type="button" className="block w-full px-3 py-2 text-left hover:bg-indigo-50" onClick={() => runContextAction(() => insertColumn("left"))}>
            แทรกคอลัมน์ด้านซ้าย
          </button>
          <button type="button" className="block w-full px-3 py-2 text-left hover:bg-indigo-50" onClick={() => runContextAction(() => insertColumn("right"))}>
            แทรกคอลัมน์ด้านขวา
          </button>
          <button
            type="button"
            disabled={maxColumns <= 1}
            className="block w-full px-3 py-2 text-left hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-white"
            onClick={() => runContextAction(deleteColumns)}
          >
            ลบคอลัมน์
          </button>
        </div>
      )}
    </div>
  );
};


const CroppedRoiPreview = ({
  previewUrl,
  roi,
  maxWidth = 140
}: {
  previewUrl: string;
  roi: ROI;
  maxWidth?: number;
}) => {
  const [cropSrc, setCropSrc] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    const renderCrop = async () => {
      const img = await loadCanvasSafeImage(previewUrl);
      if (cancelled) return;

      const scaleX = img.naturalWidth / 750;
      const scaleY = img.naturalHeight / ((img.naturalHeight / img.naturalWidth) * 750);
      
      const realX = roi.x * scaleX;
      const realY = roi.y * scaleY;
      const realW = roi.width * scaleX;
      const realH = roi.height * scaleY;

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(realW));
      canvas.height = Math.max(1, Math.round(realH));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

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
        img,
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

      if (!cancelled) {
        setCropSrc(canvas.toDataURL("image/jpeg", 0.9));
      }
    };

    renderCrop().catch((error) => {
      console.warn("Unable to render ROI preview crop.", error);
      if (!cancelled) setCropSrc("");
    });

    return () => {
      cancelled = true;
    };
  }, [previewUrl, roi]);

  if (!cropSrc) {
    return <div className="animate-pulse bg-slate-100 rounded-lg" style={{ width: `${maxWidth}px`, height: `${maxWidth * 0.7}px` }} />;
  }

  const displayScale = roi.width > maxWidth ? maxWidth / roi.width : 1;
  const displayW = roi.width * displayScale;
  const displayH = roi.height * displayScale;

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden bg-white shadow-inner" style={{ width: `${displayW}px`, height: `${displayH}px` }}>
      <img src={cropSrc} alt="Cropped segment" className="w-full h-full object-contain" />
    </div>
  );
};

interface GroundTruthEditorZoneProps {
  previewUrl: string;
  rois: (ROI & { pageIndex?: number })[]; 
  ocrResults: (OCRResult & { pageIndex?: number })[];
  setOcrResults: React.Dispatch<React.SetStateAction<(OCRResult & { pageIndex?: number })[]>>;
  onBackToStudio: () => void;
  onApproveAndSave: () => Promise<void>;
  
  imageList?: string[];              
  currentImageIndex?: number;         
  onImageIndexChange?: (index: number) => void; 
}

export default function GroundTruthEditorZone({
  previewUrl,
  rois,
  ocrResults,
  setOcrResults,
  onBackToStudio,
  onApproveAndSave,
  imageList = [previewUrl], 
  currentImageIndex = 0,
  onImageIndexChange,
}: GroundTruthEditorZoneProps) {
  
  const [activeFieldId, setActiveFieldId] = useState<number | null>(null);
  const [showLabels, setShowLabels] = useState<boolean>(true);

  // Keep the original OCR text for comparison while edits change extractedText.
  useEffect(() => {
    let changed = false;
    const updated = ocrResults.map(item => {
      const rows = normalizeTableRows(item.tableRows);
      const tableMarkdown = rows ? tableRowsToMarkdown(rows) : "";
      const shouldUseTableMarkdown =
        tableMarkdown && (!item.extractedText.trim() || /^\(?no\s+text\s+found\s+in\s+roi\)?$/i.test(item.extractedText.trim()));

      if (item.originalText === undefined || shouldUseTableMarkdown) {
        changed = true;
        return {
          ...item,
          originalText: item.originalText ?? (tableMarkdown || item.extractedText),
          extractedText: shouldUseTableMarkdown ? tableMarkdown : item.extractedText,
          tableRows: rows || item.tableRows,
        };
      }
      return item;
    });
    if (changed) {
      setOcrResults(updated);
    }
  }, [ocrResults, setOcrResults]);
  const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
  const [zoomIndex, setZoomIndex] = useState<number>(2); 
  const currentZoom = ZOOM_STEPS[zoomIndex];
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const resultsPanelRef = useRef<HTMLDivElement | null>(null);
  const textSectionRef = useRef<HTMLElement | null>(null);
  const tableSectionRef = useRef<HTMLElement | null>(null);
  const imageSectionRef = useRef<HTMLElement | null>(null);
  const fieldResultRefs = useRef<Map<number, HTMLDivElement | HTMLElement>>(new Map());
  const pendingScrollResultIdRef = useRef<number | null>(null);


  const currentPageRois = useMemo(() => {
    return rois.filter(roi => (roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0) === currentImageIndex);
  }, [rois, currentImageIndex]);


  const currentPageOcrResults = useMemo(() => {
    return ocrResults.filter(res => (res.pageIndex !== undefined ? Number(res.pageIndex) : 0) === currentImageIndex);
  }, [ocrResults, currentImageIndex]);

  const getRoiForResult = (result: OCRResult & { pageIndex?: number }) => {
    return currentPageRois.find(roi => roi.id === result.roiId) || currentPageRois.find(roi => roi.fieldName === result.fieldName);
  };

  const getAnyPageRoiForResult = (result: OCRResult & { pageIndex?: number }) => {
    const resultPageIndex = result.pageIndex !== undefined ? Number(result.pageIndex) : 0;
    return rois.find(roi => (roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0) === resultPageIndex && roi.id === result.roiId)
      || rois.find(roi => (roi.pageIndex !== undefined ? Number(roi.pageIndex) : 0) === resultPageIndex && roi.fieldName === result.fieldName);
  };

  const currentPageResultGroups = useMemo(() => {
    const typedResults = currentPageOcrResults.map((res) => {
      const matchedRoi = currentPageRois.find(roi => roi.id === res.roiId) || currentPageRois.find(roi => roi.fieldName === res.fieldName);
      const fieldType = (matchedRoi?.type || res.type || "text") as DisplayFieldType;
      return { res, matchedRoi, fieldType };
    });

    return {
      text: typedResults.filter(item => item.fieldType === "text"),
      table: typedResults.filter(item => item.fieldType === "table"),
      image: typedResults.filter(item => item.fieldType === "image"),
    };
  }, [currentPageOcrResults, currentPageRois]);

  const allPageResultGroups = useMemo(() => {
    const typedResults = ocrResults.map((res) => {
      const matchedRoi = getAnyPageRoiForResult(res);
      const fieldType = (matchedRoi?.type || res.type || "text") as DisplayFieldType;
      const pageIndex = res.pageIndex !== undefined ? Number(res.pageIndex) : matchedRoi?.pageIndex !== undefined ? Number(matchedRoi.pageIndex) : 0;
      return { res, matchedRoi, fieldType, pageIndex };
    });

    return {
      all: typedResults,
      text: typedResults.filter(item => item.fieldType === "text"),
      table: typedResults.filter(item => item.fieldType === "table"),
      image: typedResults.filter(item => item.fieldType === "image"),
      edited: typedResults.filter(item => getRawOcrText(item.res) !== item.res.extractedText),
    };
  }, [ocrResults, rois]);

  const currentPageEditedFieldCount = useMemo(() => {
    return currentPageOcrResults.filter((res) => getRawOcrText(res) !== res.extractedText).length;
  }, [currentPageOcrResults]);

  const scrollInsideResultsPanel = (target: HTMLElement | null, block: "start" | "center" = "start") => {
    const container = resultsPanelRef.current;
    if (!container || !target) return;

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const relativeTop = targetRect.top - containerRect.top + container.scrollTop;
    const top =
      block === "center"
        ? relativeTop - Math.max(0, (container.clientHeight - targetRect.height) / 2)
        : relativeTop - 12;

    container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  };

  const scrollToResult = (resultId: number, pageIndex = currentImageIndex) => {
    setActiveFieldId(resultId);
    if (pageIndex !== currentImageIndex && onImageIndexChange) {
      pendingScrollResultIdRef.current = resultId;
      onImageIndexChange(pageIndex);
      return;
    }
    window.setTimeout(() => {
      scrollInsideResultsPanel(fieldResultRefs.current.get(resultId) || null, "center");
    }, 0);
  };

  useEffect(() => {
    const pendingResultId = pendingScrollResultIdRef.current;
    if (pendingResultId === null) return;
    if (!currentPageOcrResults.some(result => result.id === pendingResultId)) return;
    pendingScrollResultIdRef.current = null;
    window.setTimeout(() => {
      scrollInsideResultsPanel(fieldResultRefs.current.get(pendingResultId) || null, "center");
    }, 0);
  }, [currentImageIndex, currentPageOcrResults]);

  const scrollToSection = (type: "all" | DisplayFieldType | "edited") => {
    if (type === "all") {
      const firstResult = allPageResultGroups.all[0];
      if (firstResult) scrollToResult(firstResult.res.id, firstResult.pageIndex);
      return;
    }

    if (type === "edited") {
      const firstEdited = currentPageOcrResults.find((res) => getRawOcrText(res) !== res.extractedText);
      if (firstEdited) scrollToResult(firstEdited.id, currentImageIndex);
      return;
    }

    const firstResult = currentPageResultGroups[type][0];
    if (firstResult) scrollToResult(firstResult.res.id, currentImageIndex);
  };

  const handlePrevImage = () => {
    if (onImageIndexChange && currentImageIndex > 0) {
      onImageIndexChange(currentImageIndex - 1);
      setActiveFieldId(null); // Clear the selected field when changing pages.
    }
  };

  const handleNextImage = () => {
    if (onImageIndexChange && currentImageIndex < imageList.length - 1) {
      onImageIndexChange(currentImageIndex + 1);
      setActiveFieldId(null); // Clear the selected field when changing pages.
    }
  };

  const autoResizeTextarea = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    target.style.height = "auto";
    target.style.height = `${target.scrollHeight}px`;
  };

  return (
    <div className="max-w-7xl mx-auto space-y-4 pb-4 animate-fade-in">
      
      {/* Step progress bar */}
      <div className="w-full bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3 w-full max-w-3xl mx-auto justify-between relative">
          <div className="flex items-center gap-2.5 bg-white pr-4 z-10">
            <div className="w-6 h-6 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-600 font-bold text-xs flex items-center justify-center">✓</div>
            <p className="text-xs font-semibold text-slate-400">เตรียมภาพ</p>
          </div>
          <div className="flex items-center gap-2.5 bg-white px-4 z-10">
            <div className="w-6 h-6 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-600 font-bold text-xs flex items-center justify-center">✓</div>
            <p className="text-xs font-semibold text-slate-400">กำหนด ROI</p>
          </div>
          <div className="flex items-center gap-2.5 bg-white pl-4 z-10">
            <div className="w-6 h-6 rounded-full bg-indigo-600 text-white font-bold text-xs flex items-center justify-center ring-4 ring-indigo-100">3</div>
            <p className="text-xs font-bold text-slate-800">ตรวจและแก้ไขผล OCR</p>
          </div>
        </div>
      </div>

      {/* Main editor layout */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 xl:h-[720px] items-stretch">
        

        <div className="xl:col-span-5 bg-[#edf2f7] border border-slate-200 rounded-xl overflow-hidden flex flex-col min-h-[620px] xl:min-h-0 xl:h-full relative shadow-md">
          {/* Header controls for left canvas */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-white border-b border-slate-200">
            <span className="text-xs font-black text-slate-600 uppercase tracking-wider">ภาพเอกสาร</span>
            <button
              type="button"
              onClick={() => setShowLabels(prev => !prev)}
              className={`p-1.5 rounded-lg border transition-all flex items-center gap-1.5 text-[10px] font-bold cursor-pointer ${
                !showLabels 
                  ? 'bg-amber-50 text-amber-600 border-amber-250 shadow-sm' 
                  : 'bg-slate-50 text-slate-500 hover:bg-slate-100 border-slate-200'
              }`}
              title={showLabels ? "ซ่อนชื่อ Field" : "แสดงชื่อ Field"}
            >
              {showLabels ? <Eye size={12} /> : <EyeOff size={12} />}
              <span>{showLabels ? "ซ่อนชื่อ" : "แสดงชื่อ"}</span>
            </button>
          </div>

          <div 
            ref={viewportRef}
            className="w-full flex-1 overflow-auto p-4 flex items-start justify-start shadow-inner relative"
          >
            <div 
              className="relative inline-block"
              style={{ 
                transform: `scale(${currentZoom * 0.6})`, 
                transformOrigin: "top left",
                transition: "transform 0.1s ease-out"
              }}
            >
              <div className="relative w-[750px] h-auto bg-transparent">
                <img 
                  src={previewUrl} 
                  alt="Review Target" 
                  className="w-full h-auto block select-none rounded bg-white border border-slate-700 shadow-sm"
                />

        {/* OCR results table */}
                <div className="absolute inset-0 top-0 left-0 w-full h-full pointer-events-none">
                  {currentPageOcrResults.map((res) => {
                    const matchedRoi = getRoiForResult(res);
                    if (!matchedRoi) return null;
                    const isCurrentActive = activeFieldId === res.id;
                    const hasPoints = matchedRoi.points && matchedRoi.points.length > 0;

                    return (
                      <div
                        key={res.id}
                        onClick={() => scrollToResult(res.id)}
                        className={`absolute border cursor-pointer transition-all duration-300 pointer-events-auto ${
                          hasPoints 
                            ? 'border-transparent bg-transparent shadow-none' 
                            : (isCurrentActive 
                                ? "border-orange-500 bg-orange-500/15 ring-4 ring-orange-500/20 z-30 shadow-lg" 
                                : "border-slate-300 bg-slate-100/5 hover:border-slate-400 hover:bg-slate-100/10 z-10")
                        }`}
                        style={{
                          left: matchedRoi.x,
                          top: matchedRoi.y,
                          width: matchedRoi.width,
                          height: matchedRoi.height,
                        }}
                      >
                        {/* SVG Polygon overlay for Quad/Polygon ROIs */}
                        {matchedRoi.points && matchedRoi.points.length > 0 && (
                          <svg className="absolute inset-0 w-full h-full pointer-events-none z-10 overflow-visible">
                            <polygon
                              points={matchedRoi.points.map(p => `${p.x - matchedRoi.x},${p.y - matchedRoi.y}`).join(' ')}
                              fill={isCurrentActive ? "rgba(249, 115, 22, 0.16)" : "rgba(148, 163, 184, 0.05)"}
                              stroke={isCurrentActive ? "#f97316" : "#94a3b8"}
                              strokeWidth="2"
                              strokeDasharray={isCurrentActive ? "0" : "3,3"}
                            />
                          </svg>
                        )}

                        {showLabels && (
                          <span className={`absolute -top-5 left-0 px-1.5 py-0.5 text-[9px] font-sans rounded shadow font-bold border transition-all ${
                            isCurrentActive 
                              ? "bg-orange-600 border-orange-600 text-white font-extrabold z-40" 
                              : "bg-white border-slate-300 text-slate-500 font-semibold"
                          }`}>
                            {res.fieldName}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>


          <div className="absolute bottom-24 right-4 bg-white border border-slate-200 rounded-lg p-1 flex items-center gap-2 shadow-md z-20 text-slate-700">
            <button type="button" onClick={() => zoomIndex > 0 && setZoomIndex(prev => prev - 1)} className="p-1 hover:bg-slate-100 rounded text-slate-500"><ZoomOut size={12} /></button>
            <span className="text-[10px] font-mono font-bold w-10 text-center text-slate-650">{Math.round(currentZoom * 100)}%</span>
            <button type="button" onClick={() => zoomIndex < ZOOM_STEPS.length - 1 && setZoomIndex(prev => prev + 1)} className="p-1 hover:bg-slate-100 rounded text-slate-500"><ZoomIn size={12} /></button>
            <button type="button" onClick={() => setZoomIndex(2)} className="p-1 hover:bg-slate-100 rounded text-slate-400"><Maximize2 size={10} /></button>
          </div>

          {/* Page carousel */}
          <div className="bg-[#edf2f7] border-t border-slate-200 p-3 flex flex-col gap-2 select-none">
            <div className="flex items-center justify-between px-1">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Documents ({imageList.length} files)</span>
              <span className="text-[10px] font-mono bg-white text-slate-700 border border-slate-200 px-1.5 py-0.5 rounded font-bold">
                หน้า {currentImageIndex + 1} / {imageList.length}
              </span>
            </div>
            
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePrevImage}
                disabled={currentImageIndex === 0}
                className="p-1.5 rounded-lg bg-white border border-slate-250 text-slate-650 hover:bg-slate-50 disabled:opacity-30 transition-all flex items-center justify-center"
              >
                <ChevronLeft size={16} />
              </button>

              <div className="flex-1 flex gap-2 overflow-x-auto py-1 scrollbar-thin scrollbar-thumb-slate-300">
                {imageList.map((imgUrl, idx) => {
                  const isCurrent = idx === currentImageIndex;
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        if (onImageIndexChange) onImageIndexChange(idx);
                        setActiveFieldId(null);
                      }}
                      className={`relative flex-shrink-0 w-12 h-14 rounded border-2 transition-all overflow-hidden bg-white ${
                        isCurrent ? 'border-indigo-500 ring-2 ring-indigo-500/30' : 'border-slate-250 opacity-60 hover:opacity-100'
                      }`}
                    >
                      <img src={imgUrl} alt={`Page ${idx + 1}`} className="w-full h-full object-cover" />
                      <div className="absolute bottom-0 inset-x-0 bg-slate-200/90 text-[8px] text-slate-700 text-center py-0.5 font-mono">
                        #{idx + 1}
                      </div>
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={handleNextImage}
                disabled={currentImageIndex === imageList.length - 1}
                className="p-1.5 rounded-lg bg-white border border-slate-250 text-slate-650 hover:bg-slate-50 disabled:opacity-30 transition-all flex items-center justify-center"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </div>

        {/* OCR results table */}
        <div className="xl:col-span-7 bg-white border border-slate-200 rounded-xl shadow-sm flex flex-col min-h-[620px] xl:min-h-0 xl:h-full overflow-hidden">
          <div className="p-4 border-b flex flex-col gap-3 bg-slate-50/50">
            <div className="flex justify-between items-center">
            <button
              type="button"
              onClick={onBackToStudio}
              className="py-1.5 px-3 hover:bg-slate-200/70 text-slate-600 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all"
            >
              <ArrowLeft size={14} /> กลับไปหน้า ROI
            </button>
            <h3 className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
              <CheckCircle size={15} className="text-indigo-600" /> ตรวจสอบและแก้ไขผล OCR
            </h3>
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                ผลลัพธ์ของหน้านี้
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handlePrevImage}
                  disabled={currentImageIndex === 0}
                  className="h-8 w-8 rounded-lg border border-slate-200 bg-white text-slate-600 disabled:opacity-30 hover:bg-slate-50 flex items-center justify-center"
                  aria-label="Previous page"
                >
                  <ChevronLeft size={15} />
                </button>
                {imageList.map((_, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      if (onImageIndexChange) onImageIndexChange(idx);
                      setActiveFieldId(null);
                    }}
                    className={`h-8 min-w-8 rounded-lg border px-2 text-xs font-black transition-all ${
                      currentImageIndex === idx
                        ? "border-indigo-500 bg-indigo-600 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {idx + 1}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={handleNextImage}
                  disabled={currentImageIndex === imageList.length - 1}
                  className="h-8 w-8 rounded-lg border border-slate-200 bg-white text-slate-600 disabled:opacity-30 hover:bg-slate-50 flex items-center justify-center"
                  aria-label="Next page"
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          </div>

          <div ref={resultsPanelRef} className="overflow-y-auto flex-1 min-h-0 bg-slate-50/40 p-4">
            {ocrResults.length > 0 && (
              <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-5">
                <button
                  type="button"
                  onClick={() => scrollToSection("all")}
                  className="rounded-xl border border-slate-200 bg-white p-2.5 text-left transition-all hover:border-indigo-200 hover:bg-indigo-50/40 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                >
                  <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">ทั้งหมด</p>
                  <p className="mt-0.5 text-base font-black tabular-nums text-slate-900">{allPageResultGroups.all.length}</p>
                  <p className="mt-0.5 text-[9px] font-bold text-slate-400">ทุกหน้า</p>
                </button>
                <button
                  type="button"
                  onClick={() => scrollToSection("text")}
                  disabled={currentPageResultGroups.text.length === 0}
                  className="rounded-xl border border-slate-200 bg-white p-2.5 text-left transition-all hover:border-indigo-200 hover:bg-indigo-50/40 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">ข้อความ</p>
                  <p className="mt-0.5 text-base font-black tabular-nums text-slate-900">{currentPageResultGroups.text.length}</p>
                  <p className="mt-0.5 text-[9px] font-bold text-slate-400">หน้า {currentImageIndex + 1}/{imageList.length}</p>
                </button>
                <button
                  type="button"
                  onClick={() => scrollToSection("table")}
                  disabled={currentPageResultGroups.table.length === 0}
                  className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-2.5 text-left transition-all hover:border-indigo-300 hover:bg-indigo-100/60 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <p className="text-[10px] font-black uppercase tracking-wider text-indigo-500">ตาราง</p>
                  <p className="mt-0.5 text-base font-black tabular-nums text-indigo-900">{currentPageResultGroups.table.length}</p>
                  <p className="mt-0.5 text-[9px] font-bold text-indigo-400">หน้า {currentImageIndex + 1}/{imageList.length}</p>
                </button>
                <button
                  type="button"
                  onClick={() => scrollToSection("image")}
                  disabled={currentPageResultGroups.image.length === 0}
                  className="rounded-xl border border-sky-100 bg-sky-50/70 p-2.5 text-left transition-all hover:border-sky-300 hover:bg-sky-100/70 focus:outline-none focus:ring-2 focus:ring-sky-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <p className="text-[10px] font-black uppercase tracking-wider text-sky-600">รูปภาพ</p>
                  <p className="mt-0.5 text-base font-black tabular-nums text-sky-900">{currentPageResultGroups.image.length}</p>
                  <p className="mt-0.5 text-[9px] font-bold text-sky-500">หน้า {currentImageIndex + 1}/{imageList.length}</p>
                </button>
                <button
                  type="button"
                  onClick={() => scrollToSection("edited")}
                  disabled={currentPageEditedFieldCount === 0}
                  className="rounded-xl border border-amber-100 bg-amber-50/70 p-2.5 text-left transition-all hover:border-amber-300 hover:bg-amber-100/70 focus:outline-none focus:ring-2 focus:ring-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <p className="text-[10px] font-black uppercase tracking-wider text-amber-600">แก้ไขแล้ว</p>
                  <p className="mt-0.5 text-base font-black tabular-nums text-amber-900">{currentPageEditedFieldCount}</p>
                  <p className="mt-0.5 text-[9px] font-bold text-amber-500">หน้า {currentImageIndex + 1}/{imageList.length}</p>
                </button>
              </div>
            )}
            {currentPageOcrResults.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-white py-20 text-center text-slate-400 font-medium">
                ยังไม่มีผล OCR ในหน้านี้ <br />
                <span className="text-[11px] font-normal text-slate-400">กลับไปหน้า ROI แล้วเริ่มอ่านข้อมูลก่อน</span>
              </div>
            ) : (
              <div className="space-y-5">
                {currentPageResultGroups.text.length > 0 && (
                  <section ref={textSectionRef} className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden scroll-mt-4">
                    <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-white px-3.5 py-2.5">
                      <div className="flex items-center gap-2">
                        <FileText size={15} className="text-slate-500" />
                        <h4 className="text-xs font-black text-slate-800">ข้อความ</h4>
                      </div>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-500">
                        {currentPageResultGroups.text.length} รายการ
                      </span>
                    </div>

                    <div className="divide-y divide-slate-100">
                      {currentPageResultGroups.text.map(({ res, matchedRoi, fieldType }) => {
                        const isSelected = activeFieldId === res.id;
                        return (
                          <div
                            key={res.id}
                            ref={(el) => {
                              if (el) fieldResultRefs.current.set(res.id, el);
                              else fieldResultRefs.current.delete(res.id);
                            }}
                            onClick={() => setActiveFieldId(res.id)}
                            className={`grid min-w-0 grid-cols-1 gap-3 p-3 transition-colors xl:grid-cols-[minmax(125px,0.55fr)_minmax(0,1fr)_minmax(0,1fr)] ${
                              isSelected ? "bg-indigo-50/50 ring-1 ring-inset ring-indigo-100" : "hover:bg-slate-50"
                            }`}
                          >
                            <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
                              <div className="flex items-center gap-1 rounded border border-transparent px-1 transition-all focus-within:border-indigo-400 focus-within:bg-white">
                                <input
                                  type="text"
                                  value={res.fieldName}
                                  onFocus={() => setActiveFieldId(res.id)}
                                  onChange={(e) => setOcrResults(p => p.map(item => item.id === res.id ? { ...item, fieldName: e.target.value } : item))}
                                  className="w-full bg-transparent py-1 text-xs font-bold text-slate-800 focus:outline-none"
                                  placeholder="ชื่อข้อมูล..."
                                />
                                <Edit3 size={12} className="shrink-0 text-slate-300" />
                              </div>
                              <div className="mt-1.5 flex items-center gap-1.5 px-1 text-[9px] font-bold uppercase text-slate-400">
                                {renderTypeIcon(fieldType, 10)}
                                <span>ประเภท: {getFieldTypeLabel(fieldType)}</span>
                              </div>
                              <span className={`mt-2 inline-flex w-fit rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${res.confidence >= 0.8 ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                                ความมั่นใจ: {(res.confidence * 100).toFixed(1)}%
                              </span>
                            </div>

                            <div className="min-w-0">
                              <p className="mb-1.5 text-[10px] font-black uppercase tracking-wider text-slate-400">ข้อความจาก OCR</p>
                              <div
                                className="min-h-10 w-full max-w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium leading-relaxed text-slate-700 shadow-sm normal-case break-all"
                                style={{ textTransform: "none", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                                translate="no"
                              >
                                {getRawOcrText(res) !== "" ? getRawOcrText(res) : <span className="text-slate-400 italic">(ไม่พบข้อความ)</span>}
                              </div>
                            </div>

                            <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
                              <p className="mb-1.5 text-[10px] font-black uppercase tracking-wider text-slate-400">ข้อความที่แก้ไขได้</p>
                              <textarea
                                value={res.extractedText}
                                onFocus={() => setActiveFieldId(res.id)}
                                onInput={autoResizeTextarea}
                                autoCapitalize="off"
                                autoComplete="off"
                                autoCorrect="off"
                                spellCheck={false}
                                translate="no"
                                data-gramm="false"
                                data-gramm_editor="false"
                                data-enable-grammarly="false"
                                ref={(el) => {
                                  if (el) {
                                    el.style.height = "auto";
                                    el.style.height = `${el.scrollHeight}px`;
                                  }
                                }}
                                onChange={(e) => setOcrResults(p => p.map(item => item.id === res.id ? { ...item, extractedText: e.target.value } : item))}
                                className="min-h-10 w-full max-w-full resize-y overflow-auto rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium leading-relaxed text-slate-800 shadow-inner transition-all focus:border-indigo-500 focus:outline-none normal-case break-all"
                                style={{ textTransform: "none", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                                placeholder="แก้ไขข้อความ OCR..."
                                rows={1}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                {currentPageResultGroups.table.length > 0 && (
                  <section ref={tableSectionRef} className="rounded-2xl border border-indigo-200 bg-white shadow-sm overflow-hidden scroll-mt-4">
                    <div className="flex items-center justify-between gap-3 border-b border-indigo-100 bg-indigo-50/60 px-3.5 py-2.5">
                      <div className="flex items-center gap-2">
                        <Table size={15} className="text-indigo-600" />
                        <h4 className="text-xs font-black text-slate-900">ตาราง</h4>
                      </div>
                      <span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-bold text-indigo-600 ring-1 ring-indigo-100">
                        {currentPageResultGroups.table.length} รายการ
                      </span>
                    </div>

                    <div className="space-y-3 p-3">
                      {currentPageResultGroups.table.map(({ res, matchedRoi, fieldType }) => {
                        const isSelected = activeFieldId === res.id;
                        const rawTableRows = tableRowsFromResult(res, getRawOcrText(res));
                        const editedTableRows = normalizeTableRows(res.tableRows) || parseTableText(res.extractedText) || rawTableRows;
                        const editedTableValue = res.extractedText || (editedTableRows ? tableRowsToMarkdown(editedTableRows) : getRawOcrText(res));
                        return (
                          <article
                            key={res.id}
                            ref={(el) => {
                              if (el) fieldResultRefs.current.set(res.id, el);
                              else fieldResultRefs.current.delete(res.id);
                            }}
                            onClick={() => setActiveFieldId(res.id)}
                            className={`rounded-xl border bg-white p-3 transition-colors ${
                              isSelected ? "border-indigo-300 bg-indigo-50/30 shadow-sm" : "border-slate-200 hover:border-indigo-200"
                            }`}
                          >
                            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                              <div onClick={(e) => e.stopPropagation()} className="min-w-0 flex-1">
                                <div className="flex max-w-sm items-center gap-1 rounded border border-transparent px-1 transition-all focus-within:border-indigo-400 focus-within:bg-white">
                                  <input
                                    type="text"
                                    value={res.fieldName}
                                    onFocus={() => setActiveFieldId(res.id)}
                                    onChange={(e) => setOcrResults(p => p.map(item => item.id === res.id ? { ...item, fieldName: e.target.value } : item))}
                                    className="w-full bg-transparent py-1 text-sm font-black text-slate-800 focus:outline-none"
                                    placeholder="ชื่อข้อมูล..."
                                  />
                                  <Edit3 size={12} className="shrink-0 text-slate-300" />
                                </div>
                                <div className="mt-1 flex items-center gap-1.5 px-1 text-[9px] font-bold uppercase text-slate-400">
                                  {renderTypeIcon(fieldType, 10)}
                                  <span>ประเภท: {getFieldTypeLabel(fieldType)}</span>
                                </div>
                              </div>
                              <span className={`inline-flex w-fit rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${res.confidence >= 0.8 ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                                ความมั่นใจ: {(res.confidence * 100).toFixed(1)}%
                              </span>
                            </div>

                            <div onClick={(e) => e.stopPropagation()}>
                              <EditableTableResult
                                value={editedTableValue}
                                rows={editedTableRows}
                                mergedCells={res.tableMergedCells}
                                onChange={(nextValue, nextRows, nextMergedCells) =>
                                  setOcrResults(p => p.map(item => item.id === res.id ? { ...item, extractedText: nextValue, tableRows: nextRows, tableMergedCells: nextMergedCells } : item))
                                }
                              />
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                )}

                {currentPageResultGroups.image.length > 0 && (
                  <section ref={imageSectionRef} className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden scroll-mt-4">
                    <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-white px-3.5 py-2.5">
                      <div className="flex items-center gap-2">
                        <ImageIcon size={15} className="text-slate-500" />
                        <h4 className="text-xs font-black text-slate-800">รูปภาพ</h4>
                      </div>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-500">
                        {currentPageResultGroups.image.length} รายการ
                      </span>
                    </div>

                    <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2">
                      {currentPageResultGroups.image.map(({ res, matchedRoi, fieldType }) => {
                        const isSelected = activeFieldId === res.id;
                        return (
                          <article
                            key={res.id}
                            ref={(el) => {
                              if (el) fieldResultRefs.current.set(res.id, el);
                              else fieldResultRefs.current.delete(res.id);
                            }}
                            onClick={() => setActiveFieldId(res.id)}
                            className={`rounded-xl border p-3 transition-colors ${
                              isSelected ? "border-indigo-300 bg-indigo-50/40" : "border-slate-200 bg-white hover:bg-slate-50"
                            }`}
                          >
                            <div onClick={(e) => e.stopPropagation()} className="mb-3">
                              <div className="flex items-center gap-1 rounded border border-transparent px-1 transition-all focus-within:border-indigo-400 focus-within:bg-white">
                                <input
                                  type="text"
                                  value={res.fieldName}
                                  onFocus={() => setActiveFieldId(res.id)}
                                  onChange={(e) => setOcrResults(p => p.map(item => item.id === res.id ? { ...item, fieldName: e.target.value } : item))}
                                  className="w-full bg-transparent py-1 text-xs font-bold text-slate-800 focus:outline-none"
                                  placeholder="ชื่อข้อมูล..."
                                />
                                <Edit3 size={12} className="shrink-0 text-slate-300" />
                              </div>
                              <div className="mt-1 flex items-center gap-1.5 px-1 text-[9px] font-bold uppercase text-slate-400">
                                {renderTypeIcon(fieldType, 10)}
                                <span>ประเภท: {getFieldTypeLabel(fieldType)}</span>
                              </div>
                            </div>

                            {matchedRoi ? (
                              <div className="w-fit rounded-xl border border-slate-200 bg-white p-2 shadow-inner">
                                <CroppedRoiPreview previewUrl={previewUrl} roi={matchedRoi} maxWidth={220} />
                              </div>
                            ) : (
                              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-xs font-bold text-slate-400">
                                ไม่มีภาพตัวอย่าง ROI
                              </div>
                            )}
                            <p className="mt-2 text-[10px] font-semibold text-slate-400">Field รูปภาพใช้สำหรับตัดภาพเท่านั้น ไม่มีข้อความ OCR</p>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>

          <div className="p-4 border-t bg-slate-50/50 flex gap-3 relative">
            <button 
              type="button"
              onClick={onApproveAndSave} 
              disabled={ocrResults.length === 0}
              className="flex-grow py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-indigo-600/10 flex items-center justify-center gap-2 disabled:bg-slate-300 disabled:text-slate-500 disabled:shadow-none"
            >
              <Save size={15} /> {ocrResults.length === 0 ? "ยังไม่มีผล OCR ให้บันทึก" : "บันทึกการเปลี่ยนแปลง"}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

