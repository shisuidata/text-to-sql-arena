import { FileSearch, ScrollText } from "lucide-react";
import { useMemo } from "react";
import { latestModelCaseIds } from "../lib/runReview";
import { buildRunTimeline, TIMELINE_STAGES, type TimelineNode } from "../lib/runTimeline";
import type { EvidenceSection, RunReviewState } from "../store";
import type { RunEvent, RunSnapshot } from "../types";
import { displayModelName } from "../lib/modelIdentity";

export type RunTimelineProps = {
  run: RunSnapshot;
  events: RunEvent[];
  focus: RunReviewState;
  onInspect: (caseKey: string, modelId: number, attempt: number, section: EvidenceSection) => void;
  onShowLogs: (modelRunId: number, caseRunId: number, eventTypes: string[]) => void;
};

const sectionByStage = Object.fromEntries(TIMELINE_STAGES.map((stage) => [stage.key, stage.section])) as Record<string, EvidenceSection>;

function duration(node: TimelineNode): string {
  if (node.elapsedMs == null) return "耗时未记录";
  const value = node.elapsedMs < 1000 ? `${Math.round(node.elapsedMs)} ms` : `${(node.elapsedMs / 1000).toFixed(2)} s`;
  return node.elapsedSource === "event-gap" ? `事件间隔 ${value}` : `耗时 ${value}`;
}

function nodeStage(node: TimelineNode): string {
  return node.key.slice(node.key.indexOf(":") + 1);
}

export function RunTimeline({ run, events, focus, onInspect, onShowLogs }: RunTimelineProps) {
  const attempts = useMemo(() => buildRunTimeline(run, events), [events, run]);
  const latest = useMemo(() => latestModelCaseIds(events), [events]);
  const visible = useMemo(() => run.models.flatMap((model) => {
    if (focus.mode === "locked") return attempts.filter((item) => item.modelRunId === model.id && item.caseKey === focus.caseKey && item.attempt === focus.attempt);
    const current = latest.get(model.id);
    const choices = attempts.filter((item) => item.modelRunId === model.id);
    return [choices.find((item) => item.caseRunId === current) ?? choices.filter((item) => item.nodes.some((node) => node.firstSeq != null)).at(-1) ?? choices[0]].filter(Boolean);
  }), [attempts, focus.attempt, focus.caseKey, focus.mode, latest, run.models]);

  const modelById = new Map(run.models.map((model) => [model.id, model]));
  const caseById = new Map(run.models.flatMap((model) => model.cases.map((item) => [item.id, item] as const)));
  const runEvents = events.filter((event) => event.model_run_id == null && ["run.created", "run.started", "run.completed", "run.cancelled", "run.interrupted"].includes(event.event_type));

  return <section className="timeline-panel" aria-label="关键过程">
    {runEvents.length > 0 && <div className="timeline-run-events" aria-label="运行级事件">{runEvents.map((event) => <span key={event.seq}><code>{event.event_type}</code>{event.message || (event.payload.status as string | undefined) || "已记录"}</span>)}</div>}
    {visible.length === 0 && <p className="timeline-empty">当前选择没有作答记录。</p>}
    <div className="timeline-attempts">{visible.map((attempt) => {
      const model = modelById.get(attempt.modelRunId);
      const item = caseById.get(attempt.caseRunId);
      return <article className="timeline-attempt" key={attempt.caseRunId} aria-label={`${model ? displayModelName(model.name) : "模型"} · ${item?.title ?? attempt.caseKey} · 第 ${attempt.attempt} 次`}>
        <header><div><b>{model ? displayModelName(model.name) : `模型 ${attempt.modelRunId}`}</b><span>{item?.title ?? attempt.caseKey} · 第 {attempt.attempt} 次</span></div><small>{item?.status ?? "未知状态"}</small></header>
        <ol className="timeline-nodes">{attempt.nodes.map((node) => <li key={node.key} className={`timeline-node state-${node.state}`}>
          <div className="timeline-node-copy"><b>{node.label}</b><span>{node.state === "waiting" ? "等待真实事件" : node.state === "failed" ? "失败" : node.state === "unknown" ? "未记录" : duration(node)}</span>{node.at && <time dateTime={node.at}>{new Date(node.at).toLocaleTimeString("zh-CN", { hour12: false })}</time>}</div>
          <div className="timeline-actions">
            <button type="button" disabled={node.firstSeq == null} onClick={() => onShowLogs(attempt.modelRunId, attempt.caseRunId, node.eventTypes)}><ScrollText/>查看相关日志</button>
            <button type="button" disabled={node.state === "waiting" || node.firstSeq == null} onClick={() => onInspect(attempt.caseKey, attempt.modelRunId, attempt.attempt, sectionByStage[nodeStage(node)] ?? "result")}><FileSearch/>查看证据</button>
          </div>
        </li>)}</ol>
      </article>;
    })}</div>
  </section>;
}
