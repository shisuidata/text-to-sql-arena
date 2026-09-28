import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Ban, ExternalLink, Filter, Focus, Minimize2, Radio, RotateCcw, Search, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api/client";
import { PageHeader, Scoreboard, StatusPill } from "../components/AppShell";
import { ModelLogo } from "../components/ModelIdentity";
import { PiOutputPanel } from "../components/PiOutputPanel";
import { RunTimeline } from "../components/RunTimeline";
import { SqlWorkspace } from "../components/SqlWorkspace";
import { useRunEvents } from "../hooks/useRunEvents";
import { displayModelName } from "../lib/modelIdentity";
import { latestModelCaseIds, resolveReview, selectModelAttempt } from "../lib/runReview";
import { defaultRunReview, useArenaStore, type EvidenceSection, type RunReviewState } from "../store";
import type { RunEvent } from "../types";

const terminal = new Set(["completed", "completed_with_errors", "cancelled", "failed", "interrupted"]);
const statusTitles: Record<string, string> = {
  cancelling: "正在取消运行", completed: "运行已结束", completed_with_errors: "运行已结束",
  cancelled: "运行已取消", failed: "运行失败", interrupted: "运行被中断",
};
const eventLevelLabel: Record<string, string> = { info: "信息", warning: "警告", error: "错误", debug: "调试" };
const formatLogTime = (value: string) => new Date(value).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 });

function eventSummary(event: RunEvent) {
  if (event.message?.trim()) return event.message;
  const payload = event.payload ?? {};
  const parts: string[] = [];
  if (typeof payload.status === "string") parts.push(`状态 ${payload.status}`);
  if (typeof payload.elapsed_ms === "number") parts.push(`耗时 ${(payload.elapsed_ms / 1000).toFixed(2)}s`);
  if (typeof payload.grain === "string") parts.push(`粒度 ${payload.grain}`);
  if (typeof payload.steps === "number") parts.push(`${payload.steps} 步`);
  if (typeof payload.row_count === "number") parts.push(`${payload.row_count} 行`);
  if (event.event_type === "score.completed" && typeof payload.score === "number") parts.push(`得分 ${payload.score}`);
  if (typeof payload.error_code === "string") parts.push(payload.error_code);
  if (typeof payload.error_message === "string") parts.push(payload.error_message);
  const usage = payload.token_usage as Record<string, unknown> | undefined;
  if (usage) {
    const tokens = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"].reduce((sum, key) => sum + (typeof usage[key] === "number" ? usage[key] as number : 0), 0);
    if (tokens) parts.push(`${tokens} Token`);
  }
  if (parts.length) return parts.join(" · ");
  if (typeof payload.text === "string") return payload.text;
  return event.event_type;
}

function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function RunLivePage() {
  const runId = Number(useParams().id);
  const queryClient = useQueryClient();
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api.run(runId), refetchInterval: (query) => terminal.has(query.state.data?.status ?? "") ? false : 1200 });
  const { events, total: historyTotal, connection, error: historyError, retry: retryHistory } = useRunEvents(runId);
  const savedReview = useArenaStore((state) => state.reviewByRun[runId] ?? defaultRunReview);
  const updateRunReview = useArenaStore((state) => state.updateRunReview);
  const [activeView, setActiveView] = useState<"output" | "timeline" | "events">("output");
  const [focusPanel, setFocusPanel] = useState<"output" | "timeline" | "events" | null>(null);
  const [workspace, setWorkspace] = useState(false);
  const [search, setSearch] = useState("");
  const [levels, setLevels] = useState<string[]>([]);
  const [modelFilters, setModelFilters] = useState<number[]>([]);
  const [eventType, setEventType] = useState("all");
  const [timelineEventTypes, setTimelineEventTypes] = useState<string[]>([]);
  const [timelineCaseRunId, setTimelineCaseRunId] = useState<number | null>(null);
  const [logFollow, setLogFollow] = useState(true);
  const [logPauseSeq, setLogPauseSeq] = useState<number | null>(null);
  const [lockSeq, setLockSeq] = useState<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const focusButton = useRef<HTMLButtonElement>(null);

  const snapshot = run.data;
  const focus = useMemo(() => snapshot ? resolveReview(snapshot, savedReview) : savedReview, [savedReview, snapshot]);
  const latest = useMemo(() => latestModelCaseIds(events), [events]);
  const invalidSaved = Boolean(snapshot && (
    (savedReview.caseKey !== null && !snapshot.selected_case_keys.includes(savedReview.caseKey)) ||
    (savedReview.modelId !== null && !snapshot.models.some((model) => model.id === savedReview.modelId)) ||
    savedReview.attempt < 1 ||
    savedReview.attempt > Math.max(1, snapshot.attempts)
  ));

  useEffect(() => {
    if (!snapshot) return;
    const resolved = resolveReview(snapshot, savedReview);
    if (resolved.caseKey !== savedReview.caseKey || resolved.modelId !== savedReview.modelId || resolved.attempt !== savedReview.attempt || resolved.markedCaseKeys.join("\u0000") !== savedReview.markedCaseKeys.join("\u0000")) updateRunReview(runId, resolved);
  }, [runId, savedReview, snapshot, updateRunReview]);
  useEffect(() => {
    if (!focusPanel || workspace) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setFocusPanel(null);
      requestAnimationFrame(() => focusButton.current?.focus());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusPanel, workspace]);

  const lockFocus = (patch: Partial<RunReviewState> = {}) => {
    if (!snapshot) return;
    const modelId = patch.modelId ?? focus.modelId ?? snapshot.models[0]?.id ?? null;
    const model = snapshot.models.find((item) => item.id === modelId);
    const current = model ? selectModelAttempt(model, focus, latest.get(model.id)) : null;
    const caseKey = patch.caseKey ?? (focus.mode === "follow" ? current?.stable_key : focus.caseKey) ?? snapshot.selected_case_keys[0] ?? null;
    const attempt = patch.attempt ?? (focus.mode === "follow" ? current?.attempt : focus.attempt) ?? 1;
    if (focus.mode === "follow") setLockSeq(events.at(-1)?.seq ?? 0);
    updateRunReview(runId, { ...patch, mode: "locked", modelId, caseKey, attempt });
  };
  const resumeFollowing = () => {
    updateRunReview(runId, { mode: "follow" });
    setLockSeq(null);
  };
  const openEvidence = (caseKey: string, modelId: number, attempt: number, section: EvidenceSection) => {
    lockFocus({ caseKey, modelId, attempt, evidenceSection: section });
    setWorkspace(true);
  };
  const activateView = (view: "output" | "timeline" | "events") => {
    setActiveView(view);
    if (focusPanel) setFocusPanel(view);
  };
  const togglePanelFocus = () => {
    if (focusPanel) {
      setFocusPanel(null);
      requestAnimationFrame(() => focusButton.current?.focus());
    } else setFocusPanel(activeView);
  };

  const caseRunIds = useMemo(() => {
    if (!snapshot || focus.mode !== "locked" || !focus.caseKey) return [];
    return snapshot.models.flatMap((model) => model.cases.filter((item) => item.stable_key === focus.caseKey && item.attempt === focus.attempt).map((item) => item.id));
  }, [focus.attempt, focus.caseKey, focus.mode, snapshot]);
  const availableEventTypes = useMemo(() => [...new Set(events.map((event) => event.event_type))].sort(), [events]);
  const filtered = useMemo(() => {
    const caseIds = new Set(timelineCaseRunId == null ? caseRunIds : [timelineCaseRunId]);
    const scopeByCase = timelineCaseRunId != null || focus.mode === "locked";
    return events.filter((event) => {
      const system = event.model_run_id == null && event.case_run_id == null;
      return (!modelFilters.length || (event.model_run_id != null && modelFilters.includes(event.model_run_id))) &&
        (!scopeByCase || system || (event.case_run_id != null && caseIds.has(event.case_run_id))) &&
        (!levels.length || levels.includes(event.level)) &&
        (!timelineEventTypes.length ? eventType === "all" || event.event_type === eventType : timelineEventTypes.includes(event.event_type)) &&
        (!search || `${eventSummary(event)} ${event.event_type}`.toLowerCase().includes(search.toLowerCase()));
    });
  }, [caseRunIds, eventType, events, focus.mode, levels, modelFilters, search, timelineCaseRunId, timelineEventTypes]);
  const virtualizer = useVirtualizer({ count: filtered.length, getScrollElement: () => logRef.current, estimateSize: () => 38, overscan: 12, enabled: activeView === "events" });
  useEffect(() => {
    if (activeView === "events" && logFollow && filtered.length) virtualizer.scrollToIndex(filtered.length - 1, { align: "end" });
  }, [activeView, filtered.length, logFollow, virtualizer]);

  if (run.error && !snapshot) return <div className="page"><p className="notice error">运行读取失败：{(run.error as Error).message}</p><button className="button" onClick={() => void run.refetch()}>重新读取</button></div>;
  if (!snapshot) return <div className="loading-screen"><Radio className="spin"/>正在读取运行数据…</div>;

  const cases = snapshot.selected_case_keys;
  const finished = terminal.has(snapshot.status);
  const allAttempts = snapshot.models.flatMap((model) => model.cases);
  const settled = allAttempts.filter((item) => ["completed", "failed", "cancelled"].includes(item.status)).length;
  const total = cases.length * snapshot.attempts * snapshot.models.length;
  const focusCase = allAttempts.find((item) => item.stable_key === focus.caseKey && item.attempt === focus.attempt) ?? allAttempts.find((item) => item.stable_key === focus.caseKey);
  const byCaseId = new Map(allAttempts.map((item) => [item.id, item]));
  const byModelId = new Map(snapshot.models.map((item) => [item.id, item]));
  const lockedIds = new Set(caseRunIds);
  const lockedNewEvents = focus.mode === "locked" && lockSeq != null ? events.filter((event) => event.seq > lockSeq && event.case_run_id != null && !lockedIds.has(event.case_run_id)).length : 0;
  const scopedCaseEventCount = focus.mode === "locked" ? events.filter((event) => event.case_run_id != null && lockedIds.has(event.case_run_id)).length : events.length;
  const logUnseen = logPauseSeq == null ? 0 : events.filter((event) => event.seq > logPauseSeq).length;
  const cancel = async () => { try { await api.cancelRun(runId); await queryClient.invalidateQueries({ queryKey: ["run", runId] }); } catch (error) { toast.error((error as Error).message); } };
  const clearFilters = () => { setSearch(""); setLevels([]); setModelFilters([]); setEventType("all"); setTimelineEventTypes([]); setTimelineCaseRunId(null); };
  const showTimelineLogs = (modelRunId: number, caseRunId: number, eventTypes: string[]) => {
    setModelFilters([modelRunId]);
    setTimelineCaseRunId(caseRunId);
    setTimelineEventTypes(eventTypes);
    setEventType("all");
    activateView("events");
  };

  return <div className={`page live-page ${focusPanel ? "focus-panel-active" : ""}`}>
    <PageHeader eyebrow={`运行 #${runId} · ${finished ? "历史记录" : "当前状态"}`} title={finished ? "运行记录" : statusTitles[snapshot.status] ?? "运行中"} description={finished ? "查看已保存的模型作答和运行日志。逐题评分见评测报告。" : "查看模型调用进度、作答结果和运行日志。"} actions={<>{finished && <Link className="button primary" to={`/runs/${runId}/report`}>评测报告<ExternalLink/></Link>}{!finished && <button className="button danger" disabled={snapshot.status === "cancelling"} onClick={cancel}><Ban/>取消运行</button>}</>}/>
    {run.error && <div className="notice error" role="status">运行状态暂时无法更新，已收到的输出仍保留。<button type="button" className="button" onClick={() => void run.refetch()}>重试状态更新</button></div>}
    {invalidSaved && <div className="notice" role="status">原讲解选择不在本次记录中，已重置</div>}
    <details className="live-scoreboard"><summary>辅助综合分</summary><Scoreboard suiteHash={snapshot.suite_content_hash} models={snapshot.models.map((model) => ({ id: model.id, name: model.name, modelId: model.resolved_model_id ?? model.requested_model_id, adapterKind: model.adapter_kind, score: model.official_score, status: model.status }))}/></details>
    <section className="live-control-bar" aria-label="运行讲解控制">
      <div className="live-status-summary"><b>运行 #{runId}</b><StatusPill status={snapshot.status}/><span>{connection === "live" ? "实时连接" : connection === "ended" ? "历史记录" : connectionLabelsForLive(connection)}</span><span>{settled}/{total} 次作答已结束</span></div>
      <div className="live-focus-controls">
        <button type="button" aria-pressed={focus.mode === "follow"} onClick={resumeFollowing}>跟随执行</button>
        <button type="button" aria-pressed={focus.mode === "locked"} onClick={() => lockFocus()}>锁定讲解题</button>
        <label>题目<select aria-label="讲解题目" value={focus.caseKey ?? ""} onChange={(event) => lockFocus({ caseKey: event.target.value })}>{cases.map((key, index) => <option value={key} key={key}>{String(index + 1).padStart(2, "0")} · {allAttempts.find((item) => item.stable_key === key)?.title ?? key}</option>)}</select></label>
        <label>尝试<select aria-label="讲解尝试" value={focus.attempt} onChange={(event) => lockFocus({ attempt: Number(event.target.value) })}>{Array.from({ length: Math.max(1, snapshot.attempts) }, (_, index) => <option key={index + 1} value={index + 1}>A{index + 1}</option>)}</select></label>
        <label>证据主模型<select aria-label="证据主模型" value={focus.modelId ?? ""} onChange={(event) => lockFocus({ modelId: Number(event.target.value) })}>{snapshot.models.map((model) => <option key={model.id} value={model.id}>{displayModelName(model.name)}</option>)}</select></label>
      </div>
      <div className="live-focus-copy"><div><p className="eyebrow">{focus.mode === "follow" ? "各模型独立执行" : "锁定讲解"}</p><h2>{focus.mode === "follow" ? "各模型跟随自己的最新题目" : focusCase?.title ?? "等待题目"}</h2>{focus.mode === "locked" && focusCase?.question && <details><summary>展开题意</summary><p>{focusCase.question}</p></details>}</div>{lockedNewEvents > 0 && <span className="locked-new-events">其他题新增 {lockedNewEvents} 条事件</span>}</div>
    </section>
    <div className="live-workspace">
      <div className="run-output-tabs" role="group" aria-label="运行视图">
        <button type="button" aria-pressed={activeView === "output"} onClick={() => activateView("output")}>模型输出</button>
        <button type="button" aria-pressed={activeView === "timeline"} onClick={() => activateView("timeline")}>关键过程</button>
        <button type="button" aria-pressed={activeView === "events"} onClick={() => activateView("events")}>原始日志 <span>{historyTotal}</span></button>
        <button ref={focusButton} type="button" className="focus-panel-button" aria-pressed={focusPanel !== null} onClick={togglePanelFocus}>{focusPanel ? <><Minimize2/>退出聚焦</> : <><Focus/>聚焦阅读</>}</button>
      </div>
      {historyError && <div className="notice error" role="alert">{historyError} <button type="button" className="button" onClick={retryHistory}>重新连接日志</button></div>}
      <div hidden={activeView !== "output" || (focusPanel !== null && focusPanel !== "output")}><PiOutputPanel run={snapshot} events={events} connection={connection} focus={focus}/></div>
      <div hidden={activeView !== "timeline" || (focusPanel !== null && focusPanel !== "timeline")}><RunTimeline run={snapshot} events={events} focus={focus} onInspect={openEvidence} onShowLogs={showTimelineLogs}/></div>
      <section className="log-panel" hidden={activeView !== "events" || (focusPanel !== null && focusPanel !== "events")}>
        <header><div className="log-title"><TerminalSquare/><div><b>运行日志</b><small>{historyTotal} 条持久化事件 · {filtered.length} 条匹配 {connection === "reconnecting" && "· 正在重连"}</small></div></div>
          <div className="log-filters"><Filter/>
            <details className="multi-filter"><summary>{modelFilters.length ? `日志来源 ${modelFilters.length}` : "全部日志来源"}</summary><div>{snapshot.models.map((model) => <label key={model.id}><input type="checkbox" checked={modelFilters.includes(model.id)} onChange={() => setModelFilters((values) => toggleValue(values, model.id))}/>{displayModelName(model.name)}</label>)}</div></details>
            <select aria-label="题目日志筛选" value={focus.mode === "locked" ? focus.caseKey ?? "all" : "all"} onChange={(event) => { setTimelineCaseRunId(null); setTimelineEventTypes([]); if (event.target.value === "all") resumeFollowing(); else lockFocus({ caseKey: event.target.value }); }}><option value="all">全部题目（跟随）</option>{cases.map((key, index) => <option value={key} key={key}>{String(index + 1).padStart(2,"0")} · {key}</option>)}</select>
            <details className="multi-filter"><summary>{levels.length ? `级别 ${levels.length}` : "全部级别"}</summary><div>{["info","warning","error"].map((value) => <label key={value}><input type="checkbox" checked={levels.includes(value)} onChange={() => setLevels((items) => toggleValue(items, value))}/>{eventLevelLabel[value]}</label>)}</div></details>
            <select aria-label="事件类型筛选" value={eventType} disabled={timelineEventTypes.length > 0} onChange={(event) => setEventType(event.target.value)}><option value="all">全部事件</option>{availableEventTypes.map((value) => <option value={value} key={value}>{value}</option>)}</select>
            <label><Search/><input aria-label="搜索日志" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索日志"/></label>
            <button type="button" onClick={clearFilters}><RotateCcw/>清空</button>
          </div>
          {timelineEventTypes.length > 0 && <div className="log-event-chip">节点事件：{timelineEventTypes.join("、")}<button type="button" onClick={() => { setTimelineEventTypes([]); setTimelineCaseRunId(null); setModelFilters([]); }}>清除节点筛选</button></div>}
          <div className="log-follow-controls">{logFollow ? <button type="button" onClick={() => { setLogFollow(false); setLogPauseSeq(events.at(-1)?.seq ?? 0); }}>暂停跟随滚动</button> : <button type="button" onClick={() => { setLogFollow(true); setLogPauseSeq(null); }}>跟随最新{logUnseen ? `（${logUnseen} 条新增）` : ""}</button>}</div>
        </header>
        {focus.mode === "locked" && scopedCaseEventCount === 0 && <p className="log-empty">此题第 {focus.attempt} 次暂无匹配日志；运行级系统事件仍单独保留。</p>}
        <div className="virtual-log" ref={logRef} onScroll={() => { const node = logRef.current; if (!node) return; const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 32; if (!atBottom && logFollow) { setLogFollow(false); setLogPauseSeq(events.at(-1)?.seq ?? 0); } else if (atBottom && !logFollow) { setLogFollow(true); setLogPauseSeq(null); } }}>
          <div className="log-columns" aria-hidden="true"><span>时间</span><span>级别</span><span>事件</span><span>来源</span><span>消息</span><span>明细</span></div>
          {filtered.length === 0 && <div className="log-empty">{connection === "loading" ? "正在加载日志…" : "暂无匹配日志"}</div>}
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>{virtualizer.getVirtualItems().map((row) => {
            const event = filtered[row.index];
            const model = event.model_run_id == null ? undefined : byModelId.get(event.model_run_id);
            const caseItem = event.case_run_id == null ? undefined : byCaseId.get(event.case_run_id);
            const payload = event.payload ?? {};
            const hasPayload = Object.keys(payload).length > 0;
            const eventGroup = event.event_type.split(".")[0];
            return <article ref={virtualizer.measureElement} data-index={row.index} className={`log-row level-${event.level} event-${eventGroup}`} key={event.seq} style={{ position: "absolute", transform: `translateY(${row.start}px)`, width: "100%" }}>
              <div className="log-row-main"><time>{formatLogTime(event.created_at)}</time><span className="log-level">{eventLevelLabel[event.level] ?? event.level}</span><code className="log-event-type">{event.event_type}</code><b className="log-source">{model ? displayModelName(model.name) : "系统"}</b>{caseItem && <span className="log-case">{caseItem.stable_key}</span>}<p>{eventSummary(event)}</p>{hasPayload && <details className="log-payload"><summary>明细</summary><pre>{JSON.stringify(payload, null, 2)}</pre></details>}</div>
            </article>;
          })}</div>
        </div>
      </section>
      <section className="model-lanes" hidden={focusPanel !== null} aria-label="模型逐题结果">{snapshot.models.map((model) => <article className="model-lane" key={model.id}><header><div><ModelLogo name={model.name} modelId={model.resolved_model_id ?? model.requested_model_id} adapterKind={model.adapter_kind}/><div><h3>{displayModelName(model.name)}</h3><code>{model.resolved_model_id ?? model.requested_model_id}</code></div></div><StatusPill status={model.status}/></header><div className="case-grid">{cases.map((key, index) => {
        const attempts = model.cases.filter((item) => item.stable_key === key);
        const result = attempts.find((item) => item.attempt === focus.attempt) ?? attempts.at(-1);
        const complete = attempts.length === snapshot.attempts && attempts.every((item) => ["completed", "failed", "cancelled"].includes(item.status));
        const score = complete ? attempts.reduce((sum, item) => sum + (item.score?.total ?? 0), 0) / snapshot.attempts : null;
        const selected = focus.mode === "locked" && focus.caseKey === key && focus.modelId === model.id;
        return <button key={key} className={`case-tile ${selected ? "active" : ""} status-${result?.status ?? "queued"}`} aria-pressed={selected} onClick={() => { lockFocus({ caseKey: key, modelId: model.id, attempt: result?.attempt ?? 1, evidenceSection: "result" }); setWorkspace(true); }}><span>{String(index + 1).padStart(2, "0")}</span><div><b>{result?.title ?? key}</b><small>{attempts.some((item) => item.status === "failed") ? "有失败 · 查看原因" : result?.status === "completed" ? "已作答 · 查看证据" : result?.status === "running" ? "正在作答" : result?.status === "cancelled" ? "已取消" : "等待作答"}</small></div><em>{score == null ? "—" : score.toFixed(1)}</em></button>;
      })}</div><footer><span>执行完成，不等于结果正确</span><b>{model.cases.filter((item) => item.status === "completed").length} 次完成</b></footer></article>)}</section>
    </div>
    <SqlWorkspace open={workspace} onOpenChange={setWorkspace} run={snapshot} focus={focus} onFocusChange={(patch) => updateRunReview(runId, patch)}/>
  </div>;
}

function connectionLabelsForLive(connection: string): string {
  if (connection === "loading") return "补齐历史";
  if (connection === "connecting") return "正在连接";
  if (connection === "reconnecting") return "正在重连";
  if (connection === "error") return "日志异常";
  return connection;
}
