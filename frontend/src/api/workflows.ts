import { request, requestBlob } from "./client";

export type WorkflowIssueSeverity = "error" | "warning";

export interface WorkflowIssue {
  code: string;
  severity: WorkflowIssueSeverity;
  message: string;
  entity_type: "suite" | "model" | "case" | "attempts" | "estimate";
  entity_id: number | null;
}

export interface PreflightModel {
  id: number;
  name: string;
  health_status: string;
  health_current: boolean;
  health_expires_at: string | null;
  pricing_available: boolean;
  historical_calls: number;
}

export interface PreflightEstimate {
  basis: "matching_completed_calls";
  sample_calls: number;
  estimated_duration_seconds: number | null;
  estimated_cost_usd: number | null;
}

export interface PreflightRequest {
  suite_version_id: number;
  model_profile_ids: number[];
  case_ids: number[] | null;
  attempts: number;
}

export interface PreflightResponse {
  ready: boolean;
  total_calls: number;
  selected_case_count: number;
  issues: WorkflowIssue[];
  models: PreflightModel[];
  estimate: PreflightEstimate;
}

export interface RunCreated {
  id: number;
  mode: "single" | "comparison";
  status: string;
}

export interface PublicationManifestSummary {
  schema_version: string;
  suite_content_hash: string;
  event_count: number;
  case_run_count: number;
  file_count: number;
}

export interface PublicationPreview {
  run_id: number;
  status: string;
  eligible: boolean;
  summary_digest: string;
  preview: Record<string, unknown>;
  manifest_summary: PublicationManifestSummary;
  warnings: string[];
}


export function preflightRun(payload: PreflightRequest): Promise<PreflightResponse> {
  return request<PreflightResponse>("/api/runs/preflight", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function rerunRun(
  runId: number,
  options: { mode: "exact" | "current"; scope: "all" | "failed" },
): Promise<RunCreated> {
  const params = new URLSearchParams(options);
  return request<RunCreated>(`/api/runs/${runId}/rerun?${params}`, { method: "POST" });
}

export function getPublicationPreview(runId: number): Promise<PublicationPreview> {
  return request<PublicationPreview>(`/api/runs/${runId}/publication-preview`);
}

export function exportPublicationPackage(
  runId: number,
  previewDigest: string,
): Promise<{ blob: Blob; filename: string }> {
  return requestBlob(`/api/runs/${runId}/publication-export`, {
    method: "POST",
    body: JSON.stringify({ preview_digest: previewDigest }),
  });
}
