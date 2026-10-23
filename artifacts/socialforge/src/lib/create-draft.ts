import { useSyncExternalStore } from "react";
import type { BeatInfo } from "./beat";

/**
 * Everything on the Create page lives here, outside the page component, so
 * moving to another menu item (or refreshing) never throws away uploads,
 * dressed looks, music or a request that is still running. Requests write
 * their results into this store, not into component state, so they land even
 * if the page is closed while they run.
 *
 * Kept in memory for the session and mirrored to localStorage (best-effort)
 * for refreshes. Blob previews are dropped on save; restored files are shown
 * from storage instead.
 */
export type Uploaded = { objectPath: string; name: string; previewUrl?: string };

export type ReelLook = {
  id: string;
  outfit: Uploaded;
  dressed: Uploaded | null;
  pending: boolean;
};

export type SingleDraft = {
  vertical: string;
  presetId: string | null;
  description: string;
  photo: Uploaded | null;
  photoRole: "model" | "as_is";
  /** Who models the outfit when the photo is put on a model. */
  gender: "woman" | "man";
  /** The model already dressed in `photo` (reused on retry, so it is not paid twice). */
  dressed: { forPhoto: string; image: Uploaded } | null;
  durationSec: number;
  aspect: "9:16" | "1:1" | "16:9";
  language: string;
  musicPrompt: string;
  /** What Generate is doing right now. */
  stage: "idle" | "dressing" | "starting";
};

export type ReelDraft = {
  model: Uploaded | null;
  /** Who models the looks: the AI model's gender and the move set. */
  gender: "woman" | "man";
  looks: ReelLook[];
  music: (Uploaded & { beat: BeatInfo | null }) | null;
  style: "video" | "photo";
  bars: number;
  shape: "9:16" | "1:1" | "16:9";
  motion: string;
  starting: boolean;
};

export type CreateDraft = {
  tenantId: number | null;
  mode: "single" | "reel";
  single: SingleDraft;
  reel: ReelDraft;
};

const STORAGE_KEY = "kokao-create-draft-v1";

export function emptyDraft(): CreateDraft {
  return {
    tenantId: null,
    mode: "single",
    single: {
      vertical: "fashion",
      presetId: null,
      description: "",
      photo: null,
      photoRole: "model",
      gender: "woman",
      dressed: null,
      durationSec: 10,
      aspect: "9:16",
      language: "None",
      musicPrompt: "",
      stage: "idle",
    },
    reel: {
      model: null,
      gender: "woman",
      looks: [],
      music: null,
      style: "video",
      bars: 2,
      shape: "9:16",
      motion:
        "The model moves gracefully to the music like a fashion showcase, smiling and confident",
      starting: false,
    },
  };
}

const stripPreview = (u: Uploaded | null): Uploaded | null =>
  u ? { objectPath: u.objectPath, name: u.name } : null;

/** What goes to localStorage: no blob URLs, no in-flight flags. */
function toStored(d: CreateDraft): CreateDraft {
  return {
    ...d,
    single: {
      ...d.single,
      photo: stripPreview(d.single.photo),
      dressed: d.single.dressed
        ? { forPhoto: d.single.dressed.forPhoto, image: stripPreview(d.single.dressed.image)! }
        : null,
      stage: "idle",
    },
    reel: {
      ...d.reel,
      model: stripPreview(d.reel.model),
      music: d.reel.music ? { ...stripPreview(d.reel.music)!, beat: d.reel.music.beat } : null,
      looks: d.reel.looks.map((l) => ({
        ...l,
        outfit: stripPreview(l.outfit)!,
        dressed: stripPreview(l.dressed),
        pending: false,
      })),
      starting: false,
    },
  };
}

function load(): CreateDraft {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyDraft();
    const parsed = JSON.parse(raw) as Partial<CreateDraft>;
    const base = emptyDraft();
    return {
      tenantId: parsed.tenantId ?? null,
      mode: parsed.mode === "reel" ? "reel" : "single",
      single: { ...base.single, ...parsed.single, stage: "idle" },
      reel: { ...base.reel, ...parsed.reel, starting: false },
    };
  } catch {
    return emptyDraft();
  }
}

let state: CreateDraft | null = null;
const listeners = new Set<() => void>();

function current(): CreateDraft {
  if (!state) state = load();
  return state;
}

/** The live draft, for async work that must read the latest state. */
export const getDraft = (): CreateDraft => current();

export function updateDraft(change: (draft: CreateDraft) => CreateDraft): void {
  state = change(current());
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toStored(state)));
  } catch {
    // Storage full or blocked: the in-memory draft still survives navigation.
  }
  listeners.forEach((l) => l());
}

export const updateSingle = (patch: Partial<SingleDraft>) =>
  updateDraft((d) => ({ ...d, single: { ...d.single, ...patch } }));

export const updateReel = (change: Partial<ReelDraft> | ((r: ReelDraft) => Partial<ReelDraft>)) =>
  updateDraft((d) => ({
    ...d,
    reel: { ...d.reel, ...(typeof change === "function" ? change(d.reel) : change) },
  }));

/**
 * "Bring it to life": put a finished Photo reel's dressed photos back on the
 * Showcase reel as a Video reel, keeping the current music if there is one.
 */
export function loadReelFromPhotos(paths: string[], aspect: string): void {
  const shape = aspect === "1:1" || aspect === "16:9" ? aspect : "9:16";
  updateDraft((d) => ({
    ...d,
    mode: "reel",
    reel: {
      ...d.reel,
      model: null,
      style: "video",
      shape,
      looks: paths.slice(0, 6).map((path, i) => {
        const photo = { objectPath: path, name: `Look ${i + 1}` };
        return { id: `reel-${Date.now()}-${i}`, outfit: photo, dressed: photo, pending: false };
      }),
    },
  }));
}

/** Start over (used after a video is started, and when the workspace changes). */
export function resetDraft(keep: Partial<Pick<CreateDraft, "tenantId" | "mode">> = {}): void {
  updateDraft(() => ({ ...emptyDraft(), ...keep }));
}

export function useCreateDraft(): CreateDraft {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current,
    current,
  );
}

/** A preview for an uploaded/generated file: the local blob while fresh, else storage. */
export const previewOf = (u: Uploaded): string => u.previewUrl ?? `/api/storage${u.objectPath}`;

/** Test hook: forget the in-memory draft so the next read reloads storage. */
export function __resetDraftStoreForTests(): void {
  state = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
