import type { CaseRun, ModelRun, RunSnapshot } from "../types";

export type ReportModel = ModelRun;
export type ReportSnapshot = RunSnapshot;

export const terminalRunStatuses: Record<string, true> = { completed: true, completed_with_errors: true, failed: true, interrupted: true, cancelled: true };
const settledCaseStatuses: Record<string, true> = { completed: true, failed: true, cancelled: true };
const reasonLabels: Record<string, string> = {
  "quality evidence unavailable": "缺少质量证据，无法判断",
  "quality evidence incomplete": "分项证据不完整，无法判断",
  "result matches the reference contract": "结果满足列、行与排序合同",
  "query did not execute successfully": "查询未成功执行",
  "result differs from the reference contract": "结果与金标合同不一致",
};

export type CaseRound = {
  key: string;
  title: string;
  question: string | null;
  category: string;
  weight: number;
  models: Array<{
    model: ReportModel;
    score: number | null;
    contribution: number | null;
    attempts: number;
    resultCorrect: number | null;
    executionOk: number | null;
    protocolOk: number | null;
    reason: string | null;
  }>;
  spread: number | null;
};

export function anonymousName(index: number) {
  return `模型 ${index < 26 ? String.fromCharCode(65 + index) : index + 1}`;
}

export function buildCaseRounds(report: ReportSnapshot): CaseRound[] {
  const keys = report.selected_case_keys;
  const byModel = report.models.map((model) => {
    const grouped = new Map<string, CaseRun[]>();
    for (const attempt of model.cases) {
      const group = grouped.get(attempt.stable_key);
      if (group) group.push(attempt);
      else grouped.set(attempt.stable_key, [attempt]);
    }
    return grouped;
  });
  const metadata = keys.map((key) => byModel.map((group) => group.get(key)?.[0]).find(Boolean));
  const totalWeight = metadata.reduce((sum, item) => sum + (item?.weight ?? 1), 0);
  return keys.map((key, index) => {
    const first = metadata[index];
    const weight = first?.weight ?? 1;
    const modelRows = report.models.map((model, modelIndex) => {
      const attempts = byModel[modelIndex].get(key) ?? [];
      const complete = attempts.length === report.attempts && new Set(attempts.map((item) => item.attempt)).size === report.attempts && attempts.every((item) => settledCaseStatuses[item.status]);
      // A failed attempt with no score contributes zero; pending or absent evidence is not a finished round.
      const averageScore = complete ? attempts.reduce((sum, item) => sum + (item.score?.total ?? 0), 0) / report.attempts : null;
      const qualityRates = (["result_correct", "execution_ok", "protocol_ok"] as const).map((field) => complete && attempts.every((item) => typeof item.quality?.[field] === "boolean") ? attempts.filter((item) => item.quality?.[field] === true).length / report.attempts : null);
      const reasons = [...new Set(attempts.map((item) => item.quality?.reason).filter((item): item is string => Boolean(item)))];
      return {
        model, score: averageScore,
        contribution: averageScore == null || totalWeight === 0 ? null : averageScore * weight / totalWeight,
        attempts: attempts.length,
        resultCorrect: qualityRates[0], executionOk: qualityRates[1], protocolOk: qualityRates[2],
        reason: reasons.length ? reasons.map((reason) => reasonLabels[reason] ?? reason).join("；") : null,
      };
    });
    const contributions = modelRows.flatMap((row) => row.contribution == null ? [] : [row.contribution]);
    return {
      key, title: first?.title ?? key, question: first?.question ?? null,
      category: first?.radar_dimension ?? first?.category ?? "未分类", weight, models: modelRows,
      spread: contributions.length === report.models.length && contributions.length > 1 ? Math.max(...contributions) - Math.min(...contributions) : null,
    };
  });
}

export function keyRounds(rounds: CaseRound[], limit = 3) {
  return rounds.filter((round) => round.spread != null && round.spread > 0).sort((a, b) => (b.spread ?? 0) - (a.spread ?? 0)).slice(0, limit);
}

export type ComparisonEvidence = { differentiating: string[]; sharedMisses: string[]; unknown: string[] };
export function buildComparisonEvidence(rounds: CaseRound[]): ComparisonEvidence {
  const evidence: ComparisonEvidence = { differentiating: [], sharedMisses: [], unknown: [] };
  for (const round of rounds) {
    const rates = round.models.map((row) => row.resultCorrect);
    if (rates.length < 2) continue;
    if (rates.some((rate) => rate === null)) evidence.unknown.push(round.title);
    else if (Math.max(...rates as number[]) !== Math.min(...rates as number[])) evidence.differentiating.push(round.title);
    else if (rates[0]! < 1) evidence.sharedMisses.push(round.title);
  }
  return evidence;
}

export type ReportVerdict = { kind: "winner" | "tie" | "single" | "provisional" | "unknown" | "legacy"; text: string };
export function buildReportVerdict(report: ReportSnapshot, nameFor: (model: ReportModel) => string): ReportVerdict {
  if (!["completed", "completed_with_errors"].includes(report.status)) return { kind: "provisional", text: "本次运行未完整结束，仅展示已保存结果，不作胜负结论" };
  if (report.quality_schema_version !== "result-quality-v2") return { kind: "legacy", text: "历史评分口径，不据此判断业务正确率" };
  if (!report.models.length || report.models.some(({ quality: q }) => !q || q.total <= 0 || q.evaluated !== q.total || !Number.isFinite(q.correct_rate))) return { kind: "unknown", text: "本次运行的结果证据覆盖不足，不作胜负结论" };
  const highest = Math.max(...report.models.map((model) => model.quality!.correct_rate!));
  const leaders = report.models.filter((model) => model.quality!.correct_rate === highest);
  const facts = leaders.map((model) => nameFor(model) + " 正确 " + model.quality!.result_correct + "/" + model.quality!.total + " 次计划尝试").join("；");
  const kind = report.models.length === 1 ? "single" : leaders.length > 1 ? "tie" : "winner";
  return { kind, text: "本次运行中，" + facts + (kind === "tie" ? "，结果正确率并列。" : kind === "winner" ? "，结果正确率领先。" : "。") };
}

export type RoundFilter = "all" | "business-difference" | "business-failure" | "format-failure" | "capability-failure" | "unknown" | "marked";
export type RoundSignals = { businessDifference: boolean; businessFailure: boolean; formatFailure: boolean; capabilityFailure: boolean; unknown: boolean; failureKinds: string[] };
export function buildRoundSignals(report: ReportSnapshot, rounds: CaseRound[]): Map<string, RoundSignals> {
  const attempts = new Map<string, CaseRun[]>();
  for (const model of report.models) for (const item of model.cases) {
    const group = attempts.get(item.stable_key);
    if (group) group.push(item); else attempts.set(item.stable_key, [item]);
  }
  return new Map(rounds.map((round) => {
    const cases = attempts.get(round.key) ?? [];
    const rates = round.models.map((row) => row.resultCorrect);
    return [round.key, {
      businessDifference: rates.length >= 2 && rates.every((rate) => rate !== null) && Math.max(...rates as number[]) > Math.min(...rates as number[]),
      businessFailure: cases.some((item) => item.quality?.result_correct === false),
      formatFailure: cases.some((item) => item.quality?.format_ok === false),
      capabilityFailure: cases.some((item) => Array.isArray(item.score?.ast_rules) && item.score.ast_rules.some((rule: { passed: boolean }) => rule.passed === false)),
      unknown: rates.some((rate) => rate === null),
      failureKinds: [...new Set(cases.flatMap((item) => item.quality?.failure_kind ? [item.quality.failure_kind] : []))],
    }];
  }));
}
export function selectKeyRounds(rounds: CaseRound[], signals: Map<string, RoundSignals>, limit = 3): CaseRound[] {
  const differences = rounds.filter((round) => signals.get(round.key)?.businessDifference).map((round) => {
    const rates = round.models.map((row) => row.resultCorrect!);
    return { round, gap: Math.max(...rates) - Math.min(...rates) };
  }).sort((a, b) => b.gap - a.gap).map(({ round }) => round);
  const selected = new Map<string, CaseRound>();
  for (const round of differences) selected.set(round.key, round);
  for (const kind of ["businessFailure", "formatFailure", "capabilityFailure", "unknown"] as const) {
    for (const round of rounds) if (signals.get(round.key)?.[kind] && !selected.has(round.key)) selected.set(round.key, round);
  }
  return [...selected.values()].slice(0, Math.max(0, limit));
}
export type ModelEvidenceSummary = {
  planned: number;
  judged: number;
  correct: number;
  mismatched: number;
  unjudged: number;
  weakAreas: Array<{ area: string; titles: string[] }>;
  constraintCases: string[];
  failureKinds: Record<string, number>;
};

export function summarizeModelEvidence(report: ReportSnapshot, model: ReportModel): ModelEvidenceSummary {
  const planned = report.selected_case_keys.length * report.attempts;
  const selected = new Set(report.selected_case_keys);
  const cases = model.cases.filter((item) => selected.has(item.stable_key));
  const judged = cases.filter((item) => item.quality?.result_correct !== null && item.quality?.result_correct !== undefined).length;
  const correct = cases.filter((item) => item.quality?.result_correct === true).length;
  const weakAreas = new Map<string, Set<string>>();
  const constraintCases = new Set<string>();
  const failureKinds: Record<string, number> = {};
  for (const item of cases) {
    if (item.quality?.result_correct === false && item.quality.execution_ok === true) {
      const area = item.radar_dimension || item.category || "未分类";
      const titles = weakAreas.get(area) ?? new Set<string>();
      titles.add(item.title);
      weakAreas.set(area, titles);
    }
    if (item.score?.ast_rules?.some((rule) => !rule.passed)) constraintCases.add(item.title);
    const kind = item.quality?.failure_kind;
    if (kind && kind !== "result_mismatch" && kind !== "format_mismatch") failureKinds[kind] = (failureKinds[kind] ?? 0) + 1;
  }
  return {
    planned, judged, correct,
    mismatched: cases.filter((item) => item.quality?.result_correct === false && item.quality.execution_ok === true).length,
    unjudged: Math.max(0, planned - judged),
    weakAreas: [...weakAreas].map(([area, titles]) => ({ area, titles: [...titles] })),
    constraintCases: [...constraintCases], failureKinds,
  };
}

export function filterRounds(rounds: CaseRound[], signals: Map<string, RoundSignals>, filter: RoundFilter, markedKeys: readonly string[]): CaseRound[] {
  if (filter === "all") return rounds;
  if (filter === "marked") { const marked = new Set(markedKeys); return rounds.filter((round) => marked.has(round.key)); }
  const field = { "business-difference": "businessDifference", "business-failure": "businessFailure", "format-failure": "formatFailure", "capability-failure": "capabilityFailure", unknown: "unknown" } as const;
  return rounds.filter((round) => signals.get(round.key)?.[field[filter]]);
}
export function adjacentRoundKey(rounds: CaseRound[], currentKey: string | null, delta: -1 | 1): string | null {
  if (!rounds.length) return null;
  const index = rounds.findIndex((round) => round.key === currentKey);
  return rounds[Math.max(0, Math.min(rounds.length - 1, index < 0 ? 0 : index + delta))].key;
}


export type ControlCheck = { label: string; left: string; right: string; same: boolean };
const stableJson = (value: unknown) => JSON.stringify(value, (_key, nested) => {
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
  return Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
});

const disclosedParameterKeys = new Set(["provider", "auth_mode", "timeout_seconds", "temperature", "max_tokens", "reasoning_effort"]);
const disclosedIsolationKeys = new Set(["harness", "harness_version", "policy_version", "tools_enabled", "tool_count", "generation_attempts", "generation_attempt_limit", "context_isolated", "system_prompt_sha256", "model_identity_source", "effective_parameters"]);
const disclosed = (source: Record<string, unknown>, keys: Set<string>) => Object.fromEntries(Object.entries(source).filter(([key]) => keys.has(key)));
const disclosedIsolation = (source: Record<string, unknown>) => Object.fromEntries(Object.entries(disclosed(source, disclosedIsolationKeys)).map(([key, value]) => [key, key === "effective_parameters" && value && typeof value === "object" && !Array.isArray(value) ? disclosed(value as Record<string, unknown>, disclosedParameterKeys) : value]));

const actualControlKeys = new Set(["harness", "harness_version", "bridge_sha256", "dependency_lock_sha256", "policy_version", "system_prompt_sha256", "provider", "auth_mode", "api", "model_identity_source", "effective_parameters", "generation_attempts", "tools_enabled", "tool_calls_observed"]);
function safeControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeControl);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/secret|credential|api.?key|authorization|access_token|refresh_token/i.test(key)).map(([key, nested]) => [key, safeControl(nested)]));
  return value;
}
export function disclosedActualControls(source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => actualControlKeys.has(key)).map(([key, value]) => [key, safeControl(value)]));
}
export function actualControlVariants(model: ReportModel): string[] {
  return [...new Set(model.cases.flatMap((item) => item.invocation ? [stableJson(disclosedActualControls(item.invocation))] : []))].sort();
}

export function comparisonControls(left: ReportSnapshot, right: ReportSnapshot, leftModel: ReportModel, rightModel: ReportModel): ControlCheck[] {
  const parameters = [leftModel, rightModel].map((model) => disclosed(model.parameters, disclosedParameterKeys));
  const controls = [leftModel, rightModel].map((model) => disclosedIsolation(model.isolation));
  const checks: Array<[string, unknown, unknown]> = [
    ["题库内容哈希", left.suite_content_hash, right.suite_content_hash],
    ["案例集合", [...left.selected_case_keys].sort(), [...right.selected_case_keys].sort()],
    ["尝试次数", left.attempts, right.attempts],
    ["评分器", left.protocol.scorer_version, right.protocol.scorer_version],
    ["结果判定合同", left.quality_schema_version, right.quality_schema_version],
    ["输出合同", left.protocol.output_contract, right.protocol.output_contract],
    ["应用版本", left.protocol.app_version, right.protocol.app_version],
    ["执行引擎", left.protocol.duckdb_version, right.protocol.duckdb_version],
    ["SQL 解析器", left.protocol.sqlglot_version, right.protocol.sqlglot_version],
    ["CLI 版本", leftModel.cli_version, rightModel.cli_version],
    ["接入适配器", leftModel.adapter_kind, rightModel.adapter_kind],
    ["接入地址指纹", leftModel.endpoint_fingerprint, rightModel.endpoint_fingerprint],
    ["响应模式", leftModel.response_mode, rightModel.response_mode],
    ["适配器参数", parameters[0], parameters[1]],
    ["隔离控制", controls[0], controls[1]],
  ];
  const actualChecks: ControlCheck[] = leftModel.adapter_kind === "pi" || rightModel.adapter_kind === "pi" ? [
    { label: "实际请求证据完整", left: `${leftModel.cases.filter(c => c.invocation?.status === "completed").length}/${leftModel.cases.length}`, right: `${rightModel.cases.filter(c => c.invocation?.status === "completed").length}/${rightModel.cases.length}`, same: [leftModel, rightModel].every(m => m.cases.length > 0 && m.cases.every(c => c.invocation?.status === "completed")) },
    { label: "实际调用控制项", left: stableJson(actualControlVariants(leftModel)), right: stableJson(actualControlVariants(rightModel)), same: actualControlVariants(leftModel).length > 0 && stableJson(actualControlVariants(leftModel)) === stableJson(actualControlVariants(rightModel)) },
  ] : [];
  return [{ label: "两侧运行均已结束", left: left.status, right: right.status, same: Boolean(terminalRunStatuses[left.status] && terminalRunStatuses[right.status]) }, ...actualChecks, ...checks.map(([label, a, b]) => ({ label, left: typeof a === "string" ? a : stableJson(a) ?? "未记录", right: typeof b === "string" ? b : stableJson(b) ?? "未记录", same: a !== undefined && b !== undefined && stableJson(a) === stableJson(b) }))];
}

export function isRepeatPair(left: ReportSnapshot, right: ReportSnapshot, leftModel: ReportModel, rightModel: ReportModel): boolean {
  return left.id !== right.id && left.quality_schema_version === "result-quality-v2" && right.quality_schema_version === "result-quality-v2"
    && Boolean(leftModel.requested_model_id) && leftModel.requested_model_id === rightModel.requested_model_id
    && leftModel.resolved_model_id === rightModel.resolved_model_id;
}

export type CaseChange = { key: string; title: string; left: number | null; right: number | null; state: "右侧更高" | "右侧更低" | "持平" | "复测上浮" | "复测下浮" | "复测持平" | "无法判断" };

export function compareResultCorrect(left: ReportSnapshot, right: ReportSnapshot, leftModel: ReportModel, rightModel: ReportModel): CaseChange[] {
  const comparable = comparisonControls(left, right, leftModel, rightModel).every((control) => control.same);
  const repeat = isRepeatPair(left, right, leftModel, rightModel);
  const leftRounds = new Map(buildCaseRounds({ ...left, models: [leftModel] }).map((round) => [round.key, round]));
  const rightRounds = new Map(buildCaseRounds({ ...right, models: [rightModel] }).map((round) => [round.key, round]));
  const keys = [...new Set([...leftRounds.keys(), ...rightRounds.keys()])].sort();
  return keys.map((key) => {
    const l = leftRounds.get(key)?.models[0]?.resultCorrect ?? null;
    const r = rightRounds.get(key)?.models[0]?.resultCorrect ?? null;
    const state = !comparable || l == null || r == null ? "无法判断" : r > l ? repeat ? "复测上浮" : "右侧更高" : r < l ? repeat ? "复测下浮" : "右侧更低" : repeat ? "复测持平" : "持平";
    return { key, title: rightRounds.get(key)?.title ?? leftRounds.get(key)?.title ?? key, left: l, right: r, state };
  });
}
