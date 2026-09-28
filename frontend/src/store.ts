import { create } from "zustand";

export type EvidenceSection = "plan" | "sql" | "result";
export type RunReviewState = {
  mode: "follow" | "locked";
  caseKey: string | null;
  modelId: number | null;
  attempt: number;
  reportLayer: "watch" | "inspect" | "verify";
  evidenceSection: EvidenceSection;
  markedCaseKeys: string[];
};
export const defaultRunReview: RunReviewState = { mode: "follow", caseKey: null, modelId: null, attempt: 1, reportLayer: "watch", evidenceSection: "result", markedCaseKeys: [] };

function readSession(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function writeSession(key: string, value: string) {
  try { sessionStorage.setItem(key, value); } catch { /* Preferences must never block a run. */ }
}
function sanitizeReview(value: unknown): RunReviewState {
  const item = value && typeof value === "object" ? value as Partial<RunReviewState> : {};
  return {
    mode: item.mode === "locked" ? "locked" : "follow",
    caseKey: typeof item.caseKey === "string" ? item.caseKey : null,
    modelId: typeof item.modelId === "number" && Number.isSafeInteger(item.modelId) && item.modelId > 0 ? item.modelId : null,
    attempt: typeof item.attempt === "number" && Number.isSafeInteger(item.attempt) && item.attempt >= 1 ? item.attempt : 1,
    reportLayer: item.reportLayer === "inspect" || item.reportLayer === "verify" ? item.reportLayer : "watch",
    evidenceSection: item.evidenceSection === "plan" || item.evidenceSection === "sql" ? item.evidenceSection : "result",
    markedCaseKeys: Array.isArray(item.markedCaseKeys) ? [...new Set(item.markedCaseKeys.filter((key): key is string => typeof key === "string"))] : [],
  };
}
function readReviews(): Record<number, RunReviewState> {
  try {
    const value: unknown = JSON.parse(readSession("arena-run-review-v1") ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key]) => Number.isSafeInteger(Number(key)) && Number(key) > 0).map(([key, review]) => [key, sanitizeReview(review)]));
  } catch { return {}; }
}
type ArenaState = {
  demoMode: boolean;
  recordingSize: "standard" | "large";
  reviewByRun: Record<number, RunReviewState>;
  setDemoMode: (value: boolean) => void;
  setRecordingSize: (value: "standard" | "large") => void;
  updateRunReview: (runId: number, patch: Partial<RunReviewState>) => void;
};
export const useArenaStore = create<ArenaState>((set) => ({
  demoMode: readSession("arena-demo") === "1",
  recordingSize: readSession("arena-recording-size") === "large" ? "large" : "standard",
  reviewByRun: readReviews(),
  setDemoMode: (value) => { writeSession("arena-demo", value ? "1" : "0"); set({ demoMode: value }); },
  setRecordingSize: (value) => { writeSession("arena-recording-size", value); set({ recordingSize: value }); },
  updateRunReview: (runId, patch) => set((state) => {
    const reviewByRun = { ...state.reviewByRun, [runId]: sanitizeReview({ ...(state.reviewByRun[runId] ?? defaultRunReview), ...patch }) };
    writeSession("arena-run-review-v1", JSON.stringify(reviewByRun));
    return { reviewByRun };
  }),
}));
