import { ArrowDown, Pause, Radio } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RunConnection } from "../hooks/useRunEvents";
import { displayModelName } from "../lib/modelIdentity";
import { presentModelOutput } from "../lib/modelOutput";
import { latestModelCaseIds, selectModelAttempt } from "../lib/runReview";
import type { RunReviewState } from "../store";
import type { CaseRun, ModelRun, RunEvent, RunSnapshot } from "../types";
import { ModelLogo } from "./ModelIdentity";

const connectionLabels: Record<RunConnection, string> = {
  loading: "补齐历史输出", connecting: "正在连接", live: "实时连接",
  reconnecting: "正在重连 · 输出将自动补齐", ended: "已保存的输出", error: "日志读取失败",
};
const finishedRuns = new Set(["completed", "completed_with_errors", "failed", "cancelled", "interrupted"]);
const emptyEvents: RunEvent[] = [];
const timestamp = (value: string) => new Date(value).toLocaleTimeString("zh-CN", { hour12: false });

function AttemptOutput({ attempt, events, runStatus, modelName, loading, endedAt, hidden }: {
  attempt: CaseRun; events: RunEvent[]; runStatus: string; modelName: string; loading: boolean; endedAt: string | undefined; hidden: boolean;
}) {
  const output = useMemo(() => {
    const chunks: string[] = [];
    let requested: RunEvent | undefined;
    let completed: RunEvent | undefined;
    let failure: RunEvent | undefined;
    for (const event of events) {
      if (event.event_type === "provider.requested") requested = event;
      if (event.event_type === "provider.delta" && typeof event.payload?.text === "string") chunks.push(event.payload.text);
      if (event.event_type === "provider.completed") completed = event;
      if (event.event_type === "case.failed") failure = event;
    }
    return { text: chunks.join(""), requested, completed, failure };
  }, [events]);
  const [view, setView] = useState<"readable" | "raw">("readable");
  const visibleText = useMemo(() => view === "raw" ? output.text : presentModelOutput(output.text).text, [output.text, view]);
  const stopped = finishedRuns.has(runStatus) || ["completed", "failed", "cancelled"].includes(attempt.status);
  const active = !stopped && !output.completed && !output.failure && Boolean(output.requested || output.text);
  const [now, setNow] = useState(() => Date.now());
  const [follow, setFollow] = useState(true);
  const [details, setDetails] = useState(false);
  const [pausedAtSeq, setPausedAtSeq] = useState<number | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const previousTop = useRef(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  useLayoutEffect(() => {
    if (hidden || !following.current || !viewport.current) return;
    viewport.current.scrollTop = viewport.current.scrollHeight;
    previousTop.current = viewport.current.scrollTop;
  }, [hidden, visibleText]);

  const failure = (output.failure?.message || attempt.error_message || output.failure?.payload?.error_code) as string | null | undefined;
  const cancelled = attempt.status === "cancelled" || runStatus === "cancelled";
  const interrupted = runStatus === "interrupted";
  const status = loading ? "读取中" : output.failure || attempt.status === "failed" ? "失败"
    : output.completed ? "输出完成" : cancelled ? "已取消" : interrupted ? "已中断"
      : output.text && active ? "正在输出" : output.requested && active ? "等待首段输出"
        : stopped ? "无输出记录" : attempt.status === "queued" ? "等待调用" : "准备请求";
  const endTime = output.failure?.created_at ?? (stopped ? endedAt : undefined);
  const elapsed = typeof output.completed?.payload?.elapsed_ms === "number" ? output.completed.payload.elapsed_ms
    : attempt.generation_ms ?? (output.requested && (active || endTime) ? Math.max(0, (endTime ? Date.parse(endTime) : now) - Date.parse(output.requested.created_at)) : null);
  const settled = stopped || Boolean(output.completed || output.failure);
  const usage = (output.completed?.payload?.token_usage ?? attempt.token_usage) as Record<string, unknown> | null | undefined;
  const tokenTotal = usage ? ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"].reduce((sum, key) => sum + (typeof usage[key] === "number" ? usage[key] as number : 0), 0) : null;
  const emptyMessage = loading ? "正在补齐已保存的输出片段…" : active ? "请求已发出，等待模型返回第一段文本。"
    : stopped ? "这次调用没有保存文本输出片段。" : "等待这道题开始调用模型。";
  const unseen = pausedAtSeq == null ? 0 : events.filter((event) => event.seq > pausedAtSeq).length;
  const resume = () => {
    following.current = true;
    setFollow(true);
    setPausedAtSeq(null);
    requestAnimationFrame(() => {
      if (!viewport.current) return;
      viewport.current.scrollTop = viewport.current.scrollHeight;
      previousTop.current = viewport.current.scrollTop;
    });
  };
  const pause = () => {
    following.current = false;
    setFollow(false);
    setPausedAtSeq(events.at(-1)?.seq ?? 0);
  };

  return <div hidden={hidden} className="pi-attempt-output">
    <div className="pi-attempt-heading"><div><h3>{attempt.title}</h3>{attempt.question && <details><summary>展开题意</summary><p>{attempt.question}</p></details>}</div><span>第 {attempt.attempt} 次作答</span></div>
    <div className="pi-output-meta">
      <b role="status" aria-live="polite" className={status === "失败" ? "pi-failed" : active ? "pi-generating" : ""}>{active && <Radio aria-hidden="true"/>}{status}</b>
      <span>{elapsed == null ? settled ? "耗时未记录" : "耗时待返回" : `${(elapsed / 1000).toFixed(1)} 秒`}</span>
      <span>{tokenTotal == null ? settled ? "Token 未返回" : "Token 待返回" : `${tokenTotal.toLocaleString("zh-CN")} Token`}</span>
    </div>
    {failure && <p className="pi-output-error" role="alert">{String(failure)}</p>}
    <div className="pi-output-view" role="group" aria-label={`${modelName} 文本显示方式`}>
      <button type="button" aria-pressed={view === "readable"} onClick={() => setView("readable")}>阅读视图</button>
      <button type="button" aria-pressed={view === "raw"} onClick={() => setView("raw")}>原始文本</button>
      {follow ? <button type="button" onClick={pause}><Pause/>暂停跟随滚动</button> : <button type="button" onClick={resume}><ArrowDown/>跟随最新{unseen ? `（${unseen} 条新增）` : ""}</button>}
    </div>
    <div className="pi-output-body">
      <div className="pi-output-scroll" ref={viewport} tabIndex={0} role="region" aria-label={`${modelName} · ${attempt.title} · 连续输出`} onScroll={() => {
        const node = viewport.current;
        if (!node) return;
        const bottom = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
        if (node.scrollTop < previousTop.current && !bottom && following.current) pause();
        else if (bottom && !following.current) resume();
        previousTop.current = node.scrollTop;
      }}>
        {output.text ? <pre className="pi-output-text">{visibleText}</pre> : <p className="pi-output-empty">{emptyMessage}</p>}
      </div>
    </div>
    <footer className="pi-output-footer"><span>{output.requested ? `请求 ${timestamp(output.requested.created_at)}` : "请求尚未记录"}</span><span>{output.completed ? `完成 ${timestamp(output.completed.created_at)}` : follow ? "自动跟随输出" : "已暂停滚动 · 仍在接收"}</span></footer>
    {(output.requested || output.completed || output.failure) && <details className="pi-output-details" onToggle={(event) => setDetails(event.currentTarget.open)}><summary>调用参数与诊断明细</summary>{details && <pre>{JSON.stringify({ request: output.requested?.payload, completed: output.completed?.payload, failure: output.failure ? { message: output.failure.message, ...output.failure.payload } : undefined }, null, 2)}</pre>}</details>}
  </div>;
}

function ModelOutput({ model, groups, latest, focus, runStatus, loading, endedAt }: {
  model: ModelRun; groups: Map<number, RunEvent[]>; latest: number | undefined; focus: RunReviewState; runStatus: string; loading: boolean; endedAt: string | undefined;
}) {
  const current = selectModelAttempt(model, focus, latest);
  const name = displayModelName(model.name);
  return <article className="pi-model-output" aria-label={`${name} 输出`}>
    <header><div className="pi-model-identity"><ModelLogo name={model.name} modelId={model.resolved_model_id ?? model.requested_model_id} adapterKind={model.adapter_kind}/><div><h3>{name}</h3><code>{model.resolved_model_id ?? model.requested_model_id}</code></div></div>
      <span className="pi-current-case">{current ? `${current.stable_key} · A${current.attempt}` : focus.mode === "locked" ? `${focus.caseKey ?? "未选题"} · A${focus.attempt}` : "等待题目"}</span>
    </header>
    {model.cases.map((attempt) => <AttemptOutput key={attempt.id} hidden={attempt.id !== current?.id} attempt={attempt} events={groups.get(attempt.id) ?? emptyEvents} runStatus={runStatus} modelName={name} loading={loading} endedAt={endedAt}/>)}
    {!current && <p className="pi-output-empty">{focus.mode === "locked" ? `此题第 ${focus.attempt} 次暂无作答` : "尚无题目记录。"}</p>}
  </article>;
}

export function PiOutputPanel({ run, events, connection, focus }: { run: RunSnapshot; events: RunEvent[]; connection: RunConnection; focus: RunReviewState }) {
  const groups = useMemo(() => {
    const value = new Map<number, RunEvent[]>();
    for (const event of events) {
      if (event.case_run_id == null) continue;
      const group = value.get(event.case_run_id);
      if (group) group.push(event); else value.set(event.case_run_id, [event]);
    }
    return value;
  }, [events]);
  const latest = useMemo(() => latestModelCaseIds(events), [events]);
  const terminalEvent = connection === "ended" ? events.at(-1) : undefined;
  const status = typeof terminalEvent?.payload?.status === "string" ? terminalEvent.payload.status : terminalEvent?.event_type === "run.cancelled" ? "cancelled" : terminalEvent?.event_type === "run.interrupted" ? "interrupted" : run.status;
  const endedAt = terminalEvent?.created_at ?? run.finished_at ?? undefined;
  return <section className="pi-output-panel" aria-label="模型连续输出">
    <header className="pi-output-intro"><p>按模型与题目实时追加 · 阅读视图展开换行，原始文本保留原样</p><span className={`pi-connection connection-${connection}`} role="status"><i aria-hidden="true"/>{connectionLabels[connection]}</span></header>
    <div className="pi-output-grid">{run.models.map((model) => <ModelOutput key={model.id} model={model} groups={groups} latest={latest.get(model.id)} focus={focus} runStatus={status} loading={connection === "loading"} endedAt={endedAt}/>)}</div>
  </section>;
}
