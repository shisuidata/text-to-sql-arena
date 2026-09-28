import type { CaseRun, RunEvent, RunSnapshot } from "../types";

export type TimelineNodeState = "recorded" | "waiting" | "failed" | "unknown";
export type TimelineNode = {
  key: string;
  label: string;
  state: TimelineNodeState;
  firstSeq: number | null;
  lastSeq: number | null;
  at: string | null;
  elapsedMs: number | null;
  eventTypes: string[];
  elapsedSource?: "recorded" | "event-gap";
};
export type TimelineAttempt = {
  modelRunId: number;
  caseRunId: number;
  caseKey: string;
  attempt: number;
  nodes: TimelineNode[];
};

type Stage = { key: string; label: string; types: readonly string[]; section: "plan" | "sql" | "result" };
export const TIMELINE_STAGES: readonly Stage[] = [
  { key: "prepare", label: "准备请求", types: ["case.started", "prompt.built"], section: "plan" },
  { key: "request", label: "请求已发出", types: ["provider.requested"], section: "plan" },
  { key: "receive", label: "接收输出", types: ["provider.delta"], section: "plan" },
  { key: "returned", label: "模型返回完成", types: ["provider.completed"], section: "plan" },
  { key: "plan", label: "查询规划已解析", types: ["plan.completed"], section: "plan" },
  { key: "sql", label: "SQL 已提交评估", types: ["sql.parsed"], section: "sql" },
  { key: "executed-evidence", label: "SQL 执行事件（原始证据）", types: ["sql.executed"], section: "result" },
  { key: "compared-evidence", label: "结果比对事件（原始证据）", types: ["result.compared"], section: "result" },
  { key: "score", label: "执行与比对结束", types: ["score.completed"], section: "result" },
] as const;

const terminalRun = new Set(["completed", "completed_with_errors", "cancelled", "failed", "interrupted"]);
const terminalCase = new Set(["completed", "failed", "cancelled"]);

function validTime(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function groupedEvents(events: readonly RunEvent[]): Map<number, RunEvent[]> {
  const groups = new Map<number, RunEvent[]>();
  for (const event of events) {
    if (event.case_run_id == null) continue;
    const group = groups.get(event.case_run_id);
    if (group) group.push(event); else groups.set(event.case_run_id, [event]);
  }
  return groups;
}

function attemptNodes(run: RunSnapshot, item: CaseRun, events: readonly RunEvent[]): TimelineNode[] {
  const byType = new Map<string, RunEvent[]>();
  let failure: RunEvent | undefined;
  for (const event of events) {
    const group = byType.get(event.event_type);
    if (group) group.push(event); else byType.set(event.event_type, [event]);
    if (event.event_type === "case.failed") failure = event;
  }
  const hasStarted = events.some((event) => event.event_type === "case.started" || event.event_type === "prompt.built" || event.event_type === "provider.requested");
  const ended = terminalRun.has(run.status) || terminalCase.has(item.status);
  let previousRecorded: RunEvent | undefined;
  let waitingAssigned = false;
  const nodes: TimelineNode[] = [];
  for (const stage of TIMELINE_STAGES) {
    const stageEvents = stage.types.flatMap((type) => byType.get(type) ?? []);
    if (!stageEvents.length && (stage.key === "executed-evidence" || stage.key === "compared-evidence")) continue;
    const first = stageEvents[0];
    const last = stageEvents.at(-1);
    let state: TimelineNodeState = stageEvents.length ? "recorded" : "unknown";
    if (!stageEvents.length && !ended && !waitingAssigned && (hasStarted || stage.key === "prepare")) {
      state = "waiting";
      waitingAssigned = true;
    }
    if (stage.key === "score" && failure) state = "failed";
    let elapsedMs: number | null = null;
    let elapsedSource: TimelineNode["elapsedSource"];
    if (stage.key === "returned" && typeof last?.payload?.elapsed_ms === "number" && Number.isFinite(last.payload.elapsed_ms)) {
      elapsedMs = last.payload.elapsed_ms;
      elapsedSource = "recorded";
    } else if (stage.key === "returned" && item.generation_ms != null && Number.isFinite(item.generation_ms)) {
      elapsedMs = item.generation_ms;
      elapsedSource = "recorded";
    } else if (stage.key === "score" && item.execution_ms != null && Number.isFinite(item.execution_ms)) {
      elapsedMs = item.execution_ms;
      elapsedSource = "recorded";
    } else if (first && previousRecorded) {
      const start = validTime(previousRecorded.created_at);
      const finish = validTime(first.created_at);
      if (start != null && finish != null && finish >= start) {
        elapsedMs = finish - start;
        elapsedSource = "event-gap";
      }
    }
    nodes.push({
      key: `${item.id}:${stage.key}`,
      label: stage.label,
      state,
      firstSeq: first?.seq ?? null,
      lastSeq: last?.seq ?? null,
      at: first?.created_at ?? null,
      elapsedMs,
      eventTypes: [...stage.types],
      ...(elapsedSource ? { elapsedSource } : {}),
    });
    if (last) previousRecorded = last;
  }
  if (failure && !nodes.some((node) => node.state === "failed")) {
    nodes.push({ key: `${item.id}:failed`, label: "作答失败", state: "failed", firstSeq: failure.seq, lastSeq: failure.seq, at: failure.created_at, elapsedMs: null, eventTypes: ["case.failed"] });
  }
  if (!events.length && terminalRun.has(run.status)) {
    nodes[0] = { ...nodes[0], label: run.status === "cancelled" ? "运行已取消（无逐题事件）" : run.status === "interrupted" ? "运行已中断（无逐题事件）" : "终态来自运行快照", state: run.status === "failed" ? "failed" : "unknown" };
  }
  return nodes;
}

export function buildRunTimeline(run: RunSnapshot, events: readonly RunEvent[]): TimelineAttempt[] {
  const grouped = groupedEvents(events);
  const attempts: TimelineAttempt[] = [];
  for (const model of run.models) {
    for (const item of model.cases) {
      attempts.push({ modelRunId: model.id, caseRunId: item.id, caseKey: item.stable_key, attempt: item.attempt, nodes: attemptNodes(run, item, grouped.get(item.id) ?? []) });
    }
  }
  return attempts;
}
