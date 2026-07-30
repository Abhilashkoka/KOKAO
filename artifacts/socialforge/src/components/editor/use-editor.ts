/**
 * The editor's state and the operations that change it.
 *
 * One hook rather than a context tree, because every panel needs almost all of
 * it: the layers panel changes the selection, the properties panel changes the
 * document, the canvas changes both, and a shortcut can change any of them.
 * Splitting that into providers would mean each edit crossing two or three of
 * them, which is more indirection than the app has complexity.
 *
 * The document is the only thing in history. Tool, zoom, and the active
 * selection deliberately are not: undoing back past a marquee you drew and
 * finding your zoom level has also changed is the behaviour everyone
 * complains about in editors that snapshot their whole UI.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
  BASE_LAYER_ID,
  cloneLayer,
  findLayer,
  findParent,
  flattenLayers,
  groupLayers as groupLayersInTree,
  insertLayer,
  mapLayer,
  removeLayer,
  reorderLayer,
  ungroupLayer,
  type ImageDoc,
  type Layer,
} from "@/lib/imageEditor/doc";
import {
  alignOffsets,
  distributeOffsets,
  fitZoom,
  layerBounds,
  nextZoom,
  type AlignMode,
  type Box,
  type Point,
} from "@/lib/imageEditor/geometry";
import {
  canRedo as canRedoHistory,
  canUndo as canUndoHistory,
  createHistory,
  historyTimeline,
  jumpTo as jumpToHistory,
  pushHistory,
  redo as redoHistory,
  undo as undoHistory,
  type History,
} from "@/lib/imageEditor/history";
import {
  combineMasks,
  createMask,
  invertMask,
  isEmptyMask,
  type SelectionMask,
  type SelectionMode,
} from "@/lib/imageEditor/selection";
import { RasterStore } from "@/lib/imageEditor/raster";
import type { CommandId, ToolId } from "@/lib/imageEditor/shortcuts";

export interface BrushSettings {
  size: number;
  hardness: number;
  opacity: number;
  color: string;
}

export interface EditorApi {
  doc: ImageDoc;
  raster: RasterStore;
  rasterVersion: number;
  /** Tell React that a paint or mask canvas changed under it. */
  bumpRaster: () => void;

  selectedIds: string[];
  selectedLayer: Layer | null;
  selectLayer: (id: string | null, additive?: boolean) => void;
  setSelectedIds: (ids: string[]) => void;

  tool: ToolId;
  setTool: (tool: ToolId) => void;

  zoom: number;
  offset: Point;
  setZoom: (zoom: number) => void;
  setOffset: (offset: Point) => void;
  zoomBy: (direction: 1 | -1) => void;
  zoomToFit: (viewport: { width: number; height: number }) => void;

  selection: SelectionMask | null;
  selectionVersion: number;
  applySelection: (mask: SelectionMask, mode: SelectionMode) => void;
  clearSelectionMask: () => void;

  brush: BrushSettings;
  setBrush: (patch: Partial<BrushSettings>) => void;

  /** Replace the document and record it in history. */
  commit: (next: ImageDoc, label: string, mergeKey?: string) => void;
  /** Replace the document WITHOUT a history entry — for live drag previews. */
  preview: (next: ImageDoc) => void;
  patchLayer: (id: string, patch: Partial<Layer>, label: string, mergeKey?: string) => void;
  addLayer: (layer: Layer, label?: string) => void;
  replaceDoc: (next: ImageDoc, label: string) => void;

  canUndo: boolean;
  canRedo: boolean;
  timeline: Array<{ label: string; index: number; current: boolean }>;
  runCommand: (command: CommandId) => void;
  jumpToHistoryIndex: (index: number) => void;

  align: (mode: AlignMode) => void;
  distribute: (axis: "x" | "y") => void;
  cropTo: (rect: Box) => void;
  resizeCanvas: (width: number, height: number, anchorX: number, anchorY: number) => void;

  dirty: boolean;
  markSaved: () => void;
}

const NUDGE_SMALL = 1;
const NUDGE_LARGE = 10;

export function useEditor(initialDoc: ImageDoc): EditorApi {
  const [history, setHistory] = useState<History<ImageDoc>>(() => createHistory(initialDoc, "Open"));
  const [selectedIds, setSelectedIdsState] = useState<string[]>([]);
  const [tool, setTool] = useState<ToolId>("move");
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [selection, setSelection] = useState<SelectionMask | null>(null);
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [rasterVersion, setRasterVersion] = useState(0);
  const [savedAt, setSavedAt] = useState(0);
  const [brush, setBrushState] = useState<BrushSettings>({
    size: 48,
    hardness: 0.7,
    opacity: 1,
    color: "#ffffff",
  });

  const rasterRef = useRef<RasterStore | null>(null);
  if (rasterRef.current === null) rasterRef.current = new RasterStore();
  const raster = rasterRef.current;

  const bumpRaster = useCallback(() => setRasterVersion((v) => v + 1), []);

  const doc = history.present.state;

  /* ---------------- document mutation ---------------- */

  const commit = useCallback((next: ImageDoc, label: string, mergeKey?: string) => {
    setHistory((h) => pushHistory(h, next, label, { mergeKey }));
  }, []);

  const preview = useCallback((next: ImageDoc) => {
    // Swaps the present state without touching past/future. Used while a drag
    // is in flight so the canvas tracks the pointer without writing ninety
    // history entries; the drag's end calls commit() once with the final state.
    setHistory((h) => ({ ...h, present: { ...h.present, state: next } }));
  }, []);

  const replaceDoc = useCallback((next: ImageDoc, label: string) => {
    setHistory((h) => pushHistory(h, next, label));
  }, []);

  const patchLayer = useCallback(
    (id: string, patch: Partial<Layer>, label: string, mergeKey?: string) => {
      setHistory((h) => {
        const current = h.present.state;
        const layers = mapLayer(current.layers, id, (layer) => ({ ...layer, ...patch }) as Layer);
        if (layers === current.layers) return h;
        return pushHistory(h, { ...current, layers }, label, { mergeKey });
      });
    },
    [],
  );

  const addLayer = useCallback(
    (layer: Layer, label = "Add layer") => {
      setHistory((h) => {
        const current = h.present.state;
        const anchor = selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null;
        const layers = insertLayer(current.layers, layer, anchor);
        return pushHistory(h, { ...current, layers }, label);
      });
      setSelectedIdsState([layer.id]);
    },
    [selectedIds],
  );

  /* ---------------- selection of layers ---------------- */

  const selectLayer = useCallback((id: string | null, additive = false) => {
    if (id === null) {
      setSelectedIdsState([]);
      return;
    }
    setSelectedIdsState((current) => {
      if (!additive) return [id];
      return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    });
  }, []);

  const setSelectedIds = useCallback((ids: string[]) => setSelectedIdsState(ids), []);

  const selectedLayer = useMemo(
    () => (selectedIds.length === 1 ? findLayer(doc.layers, selectedIds[0]) : null),
    [doc.layers, selectedIds],
  );

  /* ---------------- pixel selection ---------------- */

  const applySelection = useCallback(
    (mask: SelectionMask, mode: SelectionMode) => {
      setSelection((current) => {
        const base = current ?? createMask(doc.width, doc.height);
        const next = combineMasks(base, mask, mode);
        return isEmptyMask(next) ? null : next;
      });
      setSelectionVersion((v) => v + 1);
    },
    [doc.width, doc.height],
  );

  const clearSelectionMask = useCallback(() => {
    setSelection(null);
    setSelectionVersion((v) => v + 1);
  }, []);

  /* ---------------- viewport ---------------- */

  const zoomBy = useCallback((direction: 1 | -1) => {
    setZoom((z) => nextZoom(z, direction));
  }, []);

  const zoomToFit = useCallback(
    (viewport: { width: number; height: number }) => {
      const next = fitZoom({ width: doc.width, height: doc.height }, viewport);
      setZoom(next);
      setOffset({
        x: (viewport.width - doc.width * next) / 2,
        y: (viewport.height - doc.height * next) / 2,
      });
    },
    [doc.width, doc.height],
  );

  const setBrush = useCallback((patch: Partial<BrushSettings>) => {
    setBrushState((b) => ({ ...b, ...patch }));
  }, []);

  /* ---------------- alignment ---------------- */

  const align = useCallback(
    (mode: AlignMode) => {
      const targets = selectedIds
        .map((id) => findLayer(doc.layers, id))
        .filter((l): l is Layer => l !== null);
      if (targets.length === 0) return;
      const offsets = alignOffsets(targets.map(layerBounds), mode, {
        width: doc.width,
        height: doc.height,
      });
      let layers = doc.layers;
      targets.forEach((layer, index) => {
        const { dx, dy } = offsets[index];
        if (dx === 0 && dy === 0) return;
        layers = mapLayer(layers, layer.id, (l) => ({ ...l, x: l.x + dx, y: l.y + dy }));
      });
      if (layers !== doc.layers) commit({ ...doc, layers }, "Align");
    },
    [doc, selectedIds, commit],
  );

  const distribute = useCallback(
    (axis: "x" | "y") => {
      const targets = selectedIds
        .map((id) => findLayer(doc.layers, id))
        .filter((l): l is Layer => l !== null);
      if (targets.length < 3) return;
      const offsets = distributeOffsets(targets.map(layerBounds), axis);
      let layers = doc.layers;
      targets.forEach((layer, index) => {
        const { dx, dy } = offsets[index];
        if (dx === 0 && dy === 0) return;
        layers = mapLayer(layers, layer.id, (l) => ({ ...l, x: l.x + dx, y: l.y + dy }));
      });
      if (layers !== doc.layers) commit({ ...doc, layers }, "Distribute");
    },
    [doc, selectedIds, commit],
  );

  /* ---------------- canvas geometry ---------------- */

  const cropTo = useCallback(
    (rect: Box) => {
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const dx = -Math.round(rect.x);
      const dy = -Math.round(rect.y);
      // Every layer shifts by the crop origin rather than being clipped:
      // pixels outside the new frame stay in the document so the crop can be
      // undone, or widened again later, without having destroyed anything.
      const shift = (list: Layer[]): Layer[] =>
        list.map((layer) => {
          const moved: Layer = { ...layer, x: layer.x + dx, y: layer.y + dy };
          if (moved.type === "group" && layer.type === "group") {
            moved.children = layer.children;
          }
          return moved;
        });
      raster.resizeAll(width, height, dx, dy);
      setRasterVersion((v) => v + 1);
      commit({ ...doc, width, height, layers: shift(doc.layers) }, "Crop");
      clearSelectionMask();
    },
    [doc, commit, raster, clearSelectionMask],
  );

  const resizeCanvas = useCallback(
    (width: number, height: number, anchorX: number, anchorY: number) => {
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      const dx = Math.round((w - doc.width) * anchorX);
      const dy = Math.round((h - doc.height) * anchorY);
      const shift = (list: Layer[]): Layer[] =>
        list.map((layer) => ({ ...layer, x: layer.x + dx, y: layer.y + dy }) as Layer);
      raster.resizeAll(w, h, dx, dy);
      setRasterVersion((v) => v + 1);
      commit({ ...doc, width: w, height: h, layers: shift(doc.layers) }, "Resize canvas");
    },
    [doc, commit, raster],
  );

  /* ---------------- commands ---------------- */

  const nudge = useCallback(
    (dx: number, dy: number) => {
      if (selectedIds.length === 0) return;
      let layers = doc.layers;
      for (const id of selectedIds) {
        layers = mapLayer(layers, id, (l) =>
          l.locked ? l : ({ ...l, x: l.x + dx, y: l.y + dy } as Layer),
        );
      }
      if (layers !== doc.layers) commit({ ...doc, layers }, "Move", `nudge:${selectedIds.join(",")}`);
    },
    [doc, selectedIds, commit],
  );

  const runCommand = useCallback(
    (command: CommandId) => {
      switch (command) {
        case "undo":
          setHistory(undoHistory);
          return;
        case "redo":
          setHistory(redoHistory);
          return;
        case "delete": {
          if (selectedIds.length === 0) return;
          let layers = doc.layers;
          for (const id of selectedIds) {
            // The background is the one layer deleting is a trap for: it is
            // usually the whole picture, and it is a single undo away from an
            // empty canvas the user did not intend. Hiding it is the safe
            // equivalent and is what the delete key does here.
            if (id === BASE_LAYER_ID) {
              layers = mapLayer(layers, id, (l) => ({ ...l, visible: false }));
              continue;
            }
            layers = removeLayer(layers, id);
            raster.dropMask(id);
          }
          setSelectedIdsState([]);
          commit({ ...doc, layers }, "Delete layer");
          return;
        }
        case "duplicate": {
          if (selectedIds.length === 0) return;
          let layers = doc.layers;
          const newIds: string[] = [];
          for (const id of selectedIds) {
            const source = findLayer(doc.layers, id);
            if (!source) continue;
            const copy = cloneLayer({ ...source, name: `${source.name} copy` });
            newIds.push(copy.id);
            layers = insertLayer(layers, copy, id);
          }
          setSelectedIdsState(newIds);
          commit({ ...doc, layers }, "Duplicate layer");
          return;
        }
        case "group": {
          if (selectedIds.length === 0) return;
          const { layers, groupId } = groupLayersInTree(doc.layers, selectedIds);
          if (!groupId) return;
          setSelectedIdsState([groupId]);
          commit({ ...doc, layers }, "Group layers");
          return;
        }
        case "ungroup": {
          const target = selectedIds.find((id) => findLayer(doc.layers, id)?.type === "group");
          if (!target) return;
          commit({ ...doc, layers: ungroupLayer(doc.layers, target) }, "Ungroup");
          setSelectedIdsState([]);
          return;
        }
        case "select-all":
          applySelection(createMask(doc.width, doc.height, 255), "replace");
          return;
        case "deselect":
          clearSelectionMask();
          return;
        case "invert-selection":
          if (selection) {
            setSelection(invertMask(selection));
            setSelectionVersion((v) => v + 1);
          } else {
            applySelection(createMask(doc.width, doc.height, 255), "replace");
          }
          return;
        case "bring-forward":
        case "send-backward": {
          if (selectedIds.length !== 1) return;
          const direction = command === "bring-forward" ? 1 : -1;
          commit(
            { ...doc, layers: reorderLayer(doc.layers, selectedIds[0], direction) },
            command === "bring-forward" ? "Bring forward" : "Send backward",
          );
          return;
        }
        case "bring-to-front":
        case "send-to-back": {
          if (selectedIds.length !== 1) return;
          const id = selectedIds[0];
          const layer = findLayer(doc.layers, id);
          if (!layer) return;
          const parent = findParent(doc.layers, id);
          const siblings = parent ? parent.children : doc.layers;
          const target =
            command === "bring-to-front"
              ? siblings[siblings.length - 1]
              : siblings[0];
          if (!target || target.id === id) return;
          let layers = removeLayer(doc.layers, id);
          layers =
            command === "bring-to-front"
              ? insertLayer(layers, layer, target.id)
              : insertLayer(layers, layer, null).slice();
          if (command === "send-to-back") {
            // insertLayer has no "before" mode; rebuild the sibling list with
            // the layer first rather than adding one for a single caller.
            layers = removeLayer(layers, id);
            const rebuild = (list: Layer[]): Layer[] => {
              if (list.some((l) => l.id === target.id)) return [layer, ...list];
              return list.map((l) =>
                l.type === "group" ? { ...l, children: rebuild(l.children) } : l,
              );
            };
            layers = rebuild(layers);
          }
          commit({ ...doc, layers }, command === "bring-to-front" ? "Bring to front" : "Send to back");
          return;
        }
        case "toggle-visibility": {
          if (selectedIds.length === 0) return;
          let layers = doc.layers;
          for (const id of selectedIds) {
            layers = mapLayer(layers, id, (l) => ({ ...l, visible: !l.visible }));
          }
          commit({ ...doc, layers }, "Toggle visibility");
          return;
        }
        case "flip-horizontal":
        case "flip-vertical": {
          if (selectedIds.length === 0) return;
          let layers = doc.layers;
          for (const id of selectedIds) {
            layers = mapLayer(layers, id, (l) =>
              command === "flip-horizontal"
                ? ({ ...l, scaleX: -l.scaleX } as Layer)
                : ({ ...l, scaleY: -l.scaleY } as Layer),
            );
          }
          commit({ ...doc, layers }, command === "flip-horizontal" ? "Flip horizontal" : "Flip vertical");
          return;
        }
        case "clip-to-below": {
          if (selectedIds.length !== 1) return;
          const layer = findLayer(doc.layers, selectedIds[0]);
          if (!layer) return;
          commit(
            { ...doc, layers: mapLayer(doc.layers, layer.id, (l) => ({ ...l, clipped: !l.clipped })) },
            layer.clipped ? "Release clipping mask" : "Create clipping mask",
          );
          return;
        }
        case "nudge-left":
          nudge(-NUDGE_SMALL, 0);
          return;
        case "nudge-right":
          nudge(NUDGE_SMALL, 0);
          return;
        case "nudge-up":
          nudge(0, -NUDGE_SMALL);
          return;
        case "nudge-down":
          nudge(0, NUDGE_SMALL);
          return;
        case "nudge-left-big":
          nudge(-NUDGE_LARGE, 0);
          return;
        case "nudge-right-big":
          nudge(NUDGE_LARGE, 0);
          return;
        case "nudge-up-big":
          nudge(0, -NUDGE_LARGE);
          return;
        case "nudge-down-big":
          nudge(0, NUDGE_LARGE);
          return;
        case "brush-smaller":
          setBrushState((b) => ({ ...b, size: Math.max(1, Math.round(b.size * 0.8)) }));
          return;
        case "brush-larger":
          setBrushState((b) => ({ ...b, size: Math.min(600, Math.round(b.size * 1.25) + 1) }));
          return;
        case "zoom-in":
          zoomBy(1);
          return;
        case "zoom-out":
          zoomBy(-1);
          return;
        case "zoom-100":
          setZoom(1);
          return;
        default:
          return;
      }
    },
    [doc, selectedIds, selection, commit, applySelection, clearSelectionMask, nudge, zoomBy, raster],
  );

  const timeline = useMemo(() => {
    const { entries, currentIndex } = historyTimeline(history);
    return entries.map((entry, index) => ({
      label: entry.label,
      index,
      current: index === currentIndex,
    }));
  }, [history]);

  const jumpToHistoryIndex = useCallback((index: number) => {
    setHistory((h) => jumpToHistory(h, index));
  }, []);

  const markSaved = useCallback(() => {
    setSavedAt(history.past.length);
  }, [history.past.length]);

  return {
    doc,
    raster,
    rasterVersion,
    bumpRaster,
    selectedIds,
    selectedLayer,
    selectLayer,
    setSelectedIds,
    tool,
    setTool,
    zoom,
    offset,
    setZoom,
    setOffset,
    zoomBy,
    zoomToFit,
    selection,
    selectionVersion,
    applySelection,
    clearSelectionMask,
    brush,
    setBrush,
    commit,
    preview,
    patchLayer,
    addLayer,
    replaceDoc,
    canUndo: canUndoHistory(history),
    canRedo: canRedoHistory(history),
    timeline,
    runCommand,
    jumpToHistoryIndex,
    align,
    distribute,
    cropTo,
    resizeCanvas,
    dirty: history.past.length !== savedAt,
    markSaved,
  };
}

/** Flat list for the layers panel, top layer first — the order people read. */
export function panelLayers(doc: ImageDoc): Array<{ layer: Layer; depth: number }> {
  return flattenLayers(doc.layers)
    .map(({ layer, depth }) => ({ layer, depth }))
    .reverse();
}
