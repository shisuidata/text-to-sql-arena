import type { RunReviewState } from "../store";
import type { CaseRun, ModelRun, RunEvent, RunSnapshot } from "../types";

export function resolveReview(run: RunSnapshot, saved: RunReviewState): RunReviewState {
  const keys = new Set(run.selected_case_keys);
  return {
    ...saved,
    caseKey: saved.caseKey !== null && keys.has(saved.caseKey) ? saved.caseKey : run.selected_case_keys[0] ?? null,
    modelId: run.models.some((model) => model.id === saved.modelId) ? saved.modelId : run.models[0]?.id ?? null,
    attempt: Number.isInteger(saved.attempt) && saved.attempt >= 1 && saved.attempt <= Math.max(1, run.attempts) ? saved.attempt : 1,
    markedCaseKeys: [...new Set(saved.markedCaseKeys.filter((key) => keys.has(key)))],
  };
}

export function selectModelAttempt(model: ModelRun, focus: RunReviewState, latestCaseRunId?: number): CaseRun | null {
  if (focus.mode === "locked") return model.cases.find((item) => item.stable_key === focus.caseKey && item.attempt === focus.attempt) ?? null;
  return model.cases.find((item) => item.id === latestCaseRunId)
    ?? model.cases.find((item) => ["running", "generating", "validating"].includes(item.status))
    ?? model.cases.filter((item) => item.status !== "queued").at(-1)
    ?? model.cases[0] ?? null;
}

/** Started/requested events outrank late completion events from previous questions. */
export function latestModelCaseIds(events: readonly RunEvent[]): Map<number, number> {
  const started = new Map<number, RunEvent>();
  const fallback = new Map<number, RunEvent>();
  for (const event of events) {
    if (event.model_run_id === null || event.case_run_id === null) continue;
    if (event.seq > (fallback.get(event.model_run_id)?.seq ?? -1)) fallback.set(event.model_run_id, event);
    if ((event.event_type === "case.started" || event.event_type === "provider.requested") && event.seq > (started.get(event.model_run_id)?.seq ?? -1)) started.set(event.model_run_id, event);
  }
  return new Map([...fallback].map(([id, event]) => [id, (started.get(id) ?? event).case_run_id!]));
}
