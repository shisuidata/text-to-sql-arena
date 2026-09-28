import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const repoRoot = resolve(process.cwd(), "..");
export const evidenceRoot = resolve(repoRoot, "evidence");
export const githubEvidenceRoot = "https://github.com/shisuidata/text-to-sql-arena/blob/main/evidence";

export interface EvidenceIndexRun {
  bundle_sha256: string;
  path: string;
  run_id: number;
  status: string;
  suite_content_hash: string;
}

export interface EvidenceIndexSuite {
  bundle_sha256: string;
  content_hash: string;
  path: string;
  suite_version_id: number;
  version: number;
}

export interface EvidenceIndex {
  exported_at: string;
  run_count: number;
  runs: EvidenceIndexRun[];
  schema_version: string;
  scope: string;
  suite_count: number;
  suites: EvidenceIndexSuite[];
}

export interface CaseScore {
  total?: number;
  [key: string]: unknown;
}

export interface EfficiencyMetrics {
  metric_schema_version: string;
  attempted_cases: number;
  correct_case_equivalents?: number;
  correct_cases?: number;
  coverage: Record<string, { measured: number; total: number }>;
  tokens: { input: number; cached_input: number; cache_write_input: number; output: number; reasoning_output: number; total: number } | null;
  estimated_cost_usd: number | null;
  generation_ms: { total: number | null; mean: number | null; p50: number | null; p95: number | null };
  execution_ms: { total: number | null; mean: number | null };
  per_correct_case_equivalent?: { tokens: number | null; estimated_cost_usd: number | null; generation_ms: number | null };
  per_correct_case?: { tokens: number | null; estimated_cost_usd: number | null; generation_ms: number | null };
  pricing: Record<string, unknown> | null;
  cost_basis: string;
}

export interface CaseReport {
  attempt: number;
  case_id: number;
  category: string;
  error_code: string | null;
  error_message: string | null;
  execution_ms: number | null;
  formatted_sql: string | null;
  generation_ms: number | null;
  id: number;
  provider_request_id: string | null;
  radar_dimension: string;
  score: CaseScore | null;
  stable_key: string;
  status: string;
  title: string;
  token_usage: Record<string, unknown> | null;
  efficiency?: { tokens: EfficiencyMetrics["tokens"]; estimated_cost_usd: number | null; generation_ms: number | null; execution_ms: number | null };
  visible_summary: string | null;
}

export interface ModelReport {
  adapter_kind: string;
  attempt_statistics: Record<string, { mean: number; stddev: number; success_rate: number }>;
  cases: CaseReport[];
  categories: Record<string, number>;
  cli_version: string | null;
  failure_count: number;
  efficiency?: EfficiencyMetrics;
  id: number;
  name: string;
  official_score: number | null;
  requested_model_id: string;
  resolved_model_id: string | null;
  response_mode: string;
  status: string;
}

export interface RunReport {
  app_version: string;
  attempts: number;
  conclusion: { champions?: string[]; status?: string };
  created_at: string;
  fairness: { comparison_mode: string; pure_model_comparison: boolean; differences: string[] };
  finished_at: string | null;
  id: number;
  models: ModelReport[];
  protocol: Record<string, string | number | null>;
  report_schema_version: string;
  quality_schema_version?: string;
  selected_case_keys: string[];
  source_run_id: number | null;
  started_at: string | null;
  status: string;
  suite_content_hash: string;
  suite_version_id: number;
}

export interface SuiteReport extends EvidenceIndexSuite {
  name: string;
  description: string;
  dialect: string;
  published_at: string | null;
  status: string;
  gold_count: number;
  row_count: number;
  duckdb_version: string;
  scorer_version: string;
  sqlglot_version: string;
}

export interface EvidenceEvent {
  seq: number;
  event_type: string;
  level: string;
  created_at: string;
  model_run_id: number | null;
  case_run_id: number | null;
  message: string;
  payload: Record<string, unknown>;
}

export interface CaseEvidenceDocument {
  id: number;
  run_id: number;
  model_run_id: number;
  stable_key: string;
  title: string;
  question: string;
  model_name: string;
  requested_model_id: string;
  resolved_model_id: string | null;
  status: string;
  prompt: string | null;
  raw_output: string | null;
  generated_sql: string | null;
  formatted_sql: string | null;
  reference_sql: string | null;
  provider_request_id: string | null;
  token_usage: Record<string, unknown> | null;
  efficiency?: { tokens: EfficiencyMetrics["tokens"]; estimated_cost_usd: number | null; generation_ms: number | null; execution_ms: number | null };
  score: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface CaseEvidencePage {
  index: EvidenceIndexRun;
  report: RunReport;
  model: ModelReport;
  evidence: CaseEvidenceDocument;
  events: EvidenceEvent[];
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function getEvidenceIndex(): Promise<EvidenceIndex> {
  return readJson<EvidenceIndex>(resolve(evidenceRoot, "index.json"));
}

export async function getRuns(): Promise<Array<{ index: EvidenceIndexRun; report: RunReport }>> {
  const index = await getEvidenceIndex();
  const runs = await Promise.all(index.runs.map(async (entry) => ({
    index: entry,
    report: await readJson<RunReport>(resolve(evidenceRoot, entry.path, "report.json"))
  })));
  return runs.sort((a, b) => b.report.id - a.report.id);
}

export async function getCaseEvidencePages(): Promise<CaseEvidencePage[]> {
  const runs = await getRuns();
  const pages = await Promise.all(runs.map(async ({ index, report }) => {
    const eventText = await readFile(resolve(evidenceRoot, index.path, "events.jsonl"), "utf8");
    const events = eventText.trim()
      ? eventText.trim().split("\n").map((line) => JSON.parse(line) as EvidenceEvent)
      : [];
    const records = report.models.flatMap((model) => model.cases.map(async (caseReport) => {
      const evidence = await readJson<CaseEvidenceDocument>(
        resolve(evidenceRoot, index.path, "cases", `case-run-${String(caseReport.id).padStart(5, "0")}.json`)
      );
      return {
        index,
        report,
        model,
        evidence,
        events: events.filter((event) => event.case_run_id === caseReport.id)
      };
    }));
    return Promise.all(records);
  }));
  return pages.flat();
}

export function caseRunSlug(id: number): string {
  return `case-run-${String(id).padStart(5, "0")}`;
}

export async function getSuites(): Promise<SuiteReport[]> {
  const index = await getEvidenceIndex();
  return Promise.all(index.suites.map(async (entry) => {
    const suite = await readJson<Record<string, unknown>>(resolve(evidenceRoot, entry.path, "suite.json"));
    const artifact = await readJson<{
      duckdb_version: string;
      scorer_version: string;
      sqlglot_version: string;
      gold: Record<string, { row_count: number }>;
    }>(resolve(evidenceRoot, entry.path, "artifact-manifest.json"));
    return {
      ...entry,
      name: String(suite.name),
      description: String(suite.description),
      dialect: String(suite.dialect),
      published_at: suite.published_at ? String(suite.published_at) : null,
      status: String(suite.status),
      gold_count: Object.keys(artifact.gold).length,
      row_count: Object.values(artifact.gold).reduce((sum, item) => sum + item.row_count, 0),
      duckdb_version: artifact.duckdb_version,
      scorer_version: artifact.scorer_version,
      sqlglot_version: artifact.sqlglot_version
    };
  }));
}

export function formatDate(value: string | null): string {
  if (!value) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai"
  }).format(new Date(value));
}

export function statusLabel(status: string): string {
  return ({
    completed: "完成",
    completed_with_errors: "完成但有错误",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "被中断",
    running: "运行中"
  } as Record<string, string>)[status] ?? status;
}

export function scoreText(score: number | null): string {
  return score == null ? "—" : score.toFixed(2);
}
export function getCaseRounds(report: RunReport) {
  const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
  return report.selected_case_keys.map((stableKey) => {
    const models = report.models.map((model) => {
      const results = model.cases.filter((item) => item.stable_key === stableKey).sort((a, b) => a.attempt - b.attempt);
      const complete = report.attempts > 0 && results.length === report.attempts
        && new Set(results.map((item) => item.attempt)).size === report.attempts
        && results.every((item) => item.attempt >= 1 && item.attempt <= report.attempts && terminal.has(item.status));
      const mean = complete ? results.reduce((sum, item) => sum + (item.score?.total ?? 0), 0) / report.attempts : null;
      const verdicts = results.map((item) => deriveResultVerdict(item.score, report.quality_schema_version === "result-quality-v2"));
      const verdict: DerivedResultVerdict = !complete || verdicts.includes("unknown") ? "unknown" : verdicts.every((value) => value === "correct") ? "correct" : "incorrect";
      return { model, results, mean, verdict };
    });
    const means = models.map((item) => item.mean);
    const spread = means.length > 1 && means.every((mean) => mean !== null) ? Math.max(...means as number[]) - Math.min(...means as number[]) : 0;
    return { stableKey, title: models.flatMap((item) => item.results)[0]?.title ?? stableKey, models, spread };
  });
}

export type DerivedResultVerdict = "correct" | "incorrect" | "unknown";

/** Derive from deterministic result-comparison fields only; never from AST points. */
export function deriveResultVerdict(score: CaseScore | Record<string, unknown> | null, businessOnly = false): DerivedResultVerdict {
  if (!score) return "unknown";
  const components = [
    ["execution", 10],
    ["row_f1", 45],
    ["column_count", 5],
    ["column_names", 5],
    ["ordering", 10],
  ] as const;
  const required = businessOnly ? components.filter(([key]) => key !== "column_names") : components;
  const present = required.filter(([key]) => typeof score[key] === "number");
  if (present.length !== required.length || (businessOnly && Number(score.execution) < 10)) return "unknown";
  return present.every(([key, maximum]) => Number(score[key]) >= maximum) ? "correct" : "incorrect";
}

export function resultVerdictLabel(verdict: DerivedResultVerdict): string {
  return ({ correct: "结果正确（页面派生）", incorrect: "结果未完全正确（页面派生）", unknown: "结果正确性未知" })[verdict];
}
const usageValue = (usage: Record<string, unknown> | null, keys: string[]) => {
  for (const key of keys) { const value = usage?.[key]; if (typeof value === "number" && value >= 0) return value; }
  return 0;
};

export function modelEfficiency(model: ModelReport): EfficiencyMetrics {
  if (model.efficiency) return model.efficiency;
  const totals = { input: 0, cached_input: 0, cache_write_input: 0, output: 0, reasoning_output: 0, total: 0 };
  const generation = model.cases.flatMap((item) => typeof item.generation_ms === "number" ? [item.generation_ms] : []);
  let measured = 0;
  for (const item of model.cases) {
    const input = usageValue(item.token_usage, ["input_tokens", "prompt_tokens"]);
    const cached = usageValue(item.token_usage, ["cached_input_tokens", "cache_read_input_tokens", "cache_read_tokens"]);
    const cacheWrite = usageValue(item.token_usage, ["cache_write_input_tokens", "cache_creation_input_tokens"]);
    const output = usageValue(item.token_usage, ["output_tokens", "completion_tokens"]);
    if (input || cached || cacheWrite || output) measured += 1;
    totals.input += model.adapter_kind === "claude_cli" ? input : Math.max(input - cached, 0);
    totals.cached_input += cached; totals.cache_write_input += cacheWrite; totals.output += output;
    totals.reasoning_output += usageValue(item.token_usage, ["reasoning_output_tokens", "reasoning_tokens"]);
  }
  totals.total = totals.input + totals.cached_input + totals.cache_write_input + totals.output;
  const equivalent = model.cases.reduce((sum, item) => sum + (typeof item.score?.total === "number" ? Math.max(item.score.total, 0) / 100 : 0), 0);
  const ordered = [...generation].sort((a, b) => a - b);
  const p95Index = ordered.length ? Math.ceil(ordered.length * .95) - 1 : -1;
  const generationTotal = generation.length ? generation.reduce((sum, value) => sum + value, 0) : null;
  return {
    metric_schema_version: "efficiency-v1-derived", attempted_cases: model.cases.length, correct_case_equivalents: equivalent,
    coverage: { tokens: { measured, total: model.cases.length }, cost: { measured: 0, total: model.cases.length }, generation_time: { measured: generation.length, total: model.cases.length } },
    tokens: measured ? totals : null, estimated_cost_usd: null,
    generation_ms: { total: generationTotal, mean: generationTotal == null ? null : generationTotal / generation.length, p50: ordered.length ? ordered[Math.floor((ordered.length - 1) / 2)] : null, p95: p95Index >= 0 ? ordered[p95Index] : null },
    execution_ms: { total: null, mean: null },
    per_correct_case_equivalent: { tokens: measured && equivalent > 0 ? totals.total / equivalent : null, estimated_cost_usd: null, generation_ms: generationTotal != null && equivalent > 0 ? generationTotal / equivalent : null },
    pricing: null, cost_basis: "unavailable",
  };
}

export function runSlug(id: number): string {
  return `run-${String(id).padStart(4, "0")}`;
}

export function displayModelName(name: string): string {
  return name.replace(/\s*本机实测\s*$/, "");
}
