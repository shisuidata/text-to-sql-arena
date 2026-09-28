import * as Dialog from "@radix-ui/react-dialog";
import { DiffEditor, Editor } from "@monaco-editor/react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Eye, EyeOff, ListTree, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { displayModelName } from "../lib/modelIdentity";
import { configureShisuiMonaco, resolveShisuiTheme, SHISUI_MONACO_THEME } from "../lib/shisui";
import { useArenaStore, type EvidenceSection, type RunReviewState } from "../store";
import type { CaseRun, CaseRunDetail, ModelRun, QueryPlan, ResultPreview, RunSnapshot, ScoreBreakdown } from "../types";

type EligibleRun = { model: ModelRun; run: CaseRun };
type ComparisonMode = "reference" | "model";
type ResultMode = "differences" | "all";
const terminalCaseStatuses: Record<string, true> = { completed: true, failed: true, cancelled: true, interrupted: true };
const scoreOrder: Array<[keyof ScoreBreakdown, string]> = [
  ["protocol", "协议"], ["read_only_ast", "只读安全"], ["execution", "执行"],
  ["column_count", "列数"], ["column_names", "列名"], ["row_f1", "行匹配"],
  ["ordering", "顺序/一致性"], ["sql_capability", "能力约束"], ["total", "综合分"],
];

function formatCell(value: unknown) {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function validRows(value: unknown): value is unknown[][] {
  return Array.isArray(value) && value.every(Array.isArray);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "证据请求失败";
}

function resultColumns(preview: ResultPreview | null | undefined, rows: unknown[][]) {
  if (Array.isArray(preview?.columns)) return preview.columns;
  return rows[0]?.map((_, index) => ({ name: `列 ${index + 1}`, type: "" })) ?? [];
}

function DataTable({ preview, label, error }: { preview?: ResultPreview | null; label: string; error?: string | null }) {
  const rows = validRows(preview?.rows) ? preview.rows : [];
  const columns = resultColumns(preview, rows);
  const total = typeof preview?.row_count === "number" ? preview.row_count : rows.length;
  return <article className="result-table-card">
    <header><b>{label}</b></header>
    {rows.length > 0 ? <div className="result-table-scroll"><table><thead><tr><th>#</th>{columns.map((column, index) => <th key={`${column.name}-${index}`}><span>{column.name}</span><small>{column.type}</small></th>)}</tr></thead><tbody>{rows.slice(0, 200).map((row, rowIndex) => <tr key={rowIndex}><td>{rowIndex + 1}</td>{columns.map((_, columnIndex) => <td key={columnIndex}>{formatCell(row[columnIndex])}</td>)}</tr>)}</tbody></table></div> : <div className="result-empty">{error ?? "暂无可预览结果"}</div>}
    <footer>显示 {Math.min(rows.length, 200)} / {total} 行</footer>
  </article>;
}

function DifferenceTable({ rows, columns, label, page, onPage }: { rows: unknown[][]; columns: Array<{ name: string; type: string }>; label: string; page: number; onPage: (page: number) => void }) {
  const pageCount = Math.max(1, Math.ceil(rows.length / 5));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * 5;
  const displayed = rows.slice(start, start + 5);
  return <article className="result-table-card difference-table" data-difference-group={label}>
    <header><b>{label}</b><span>{rows.length ? `样本 ${start + 1}–${start + displayed.length}` : "无已保存样本"}</span></header>
    {displayed.length ? <div className="result-table-scroll"><table><thead><tr><th>样本</th>{columns.map((column, index) => <th key={`${column.name}-${index}`}><span>{column.name}</span><small>{column.type}</small></th>)}</tr></thead><tbody>{displayed.map((row, index) => <tr key={`${start}-${index}`} id={`difference-${label}-${start + index}`}><td>{start + index + 1}</td>{columns.map((_, columnIndex) => <td key={columnIndex}>{formatCell(row[columnIndex])}</td>)}</tr>)}</tbody></table></div> : <div className="result-empty">没有已保存的差异行</div>}
    {rows.length > 5 && <footer className="diff-navigation"><button disabled={safePage === 0} onClick={() => onPage(safePage - 1)}>上一页</button><span>{safePage + 1} / {pageCount}</span><button disabled={safePage + 1 >= pageCount} onClick={() => onPage(safePage + 1)}>下一页</button></footer>}
  </article>;
}

function PlanEvidence({ plan, assumptions }: { plan?: QueryPlan | null; assumptions?: string[] | null }) {
  if (!plan) return <div className="result-empty">本次输出未形成有效查询规划</div>;
  const groups = [["数据源", plan.sources], ["连接", plan.joins], ["过滤", plan.filters], ["指标", plan.metrics], ["风险", plan.risks]] as const;
  return <div className="plan-evidence">
    <div className="plan-grain"><small>目标粒度</small><b>{plan.grain}</b></div>
    <ol>{plan.steps.map((step, index) => <li key={index}><span>{String(index + 1).padStart(2, "0")}</span>{step}</li>)}</ol>
    <div className="plan-groups">{groups.map(([label, values]) => <div key={label}><small>{label}</small>{values.length ? values.map((value) => <span key={value}>{value}</span>) : <span>无</span>}</div>)}</div>
    <div className="assumption-list"><small>显式假设</small>{assumptions?.length ? assumptions.map((value) => <span key={value}>{value}</span>) : <span>无额外假设</span>}</div>
  </div>;
}

function ScoreEvidence({ score }: { score?: ScoreBreakdown | null }) {
  if (!score) return <div className="result-empty">未记录评分明细</div>;
  const known = new Set([...scoreOrder.map(([key]) => key), "ast_rules"]);
  const unknown = Object.fromEntries(Object.entries(score).filter(([key]) => !known.has(key as keyof ScoreBreakdown)));
  const rules = Array.isArray(score.ast_rules) ? score.ast_rules : [];
  return <details className="score-breakdown"><summary>评分明细</summary>
    <div className="breakdown">{scoreOrder.map(([key, label]) => typeof score[key] === "number" ? <span key={key}>{label}<b>{Number(score[key]).toFixed(2).replace(/\.00$/, "")}</b></span> : null)}</div>
    <section><h4>能力规则</h4>{rules.length ? rules.map((rule) => <details key={`${rule.id}-${rule.kind}`}><summary>{rule.id} · {rule.kind} · {rule.passed ? "通过" : "未通过"}</summary><pre>{JSON.stringify(rule.details, null, 2)}</pre></details>) : <p>本题未设置能力规则</p>}</section>
    {Object.keys(unknown).length > 0 && <details><summary>原始证据中的其他字段</summary><pre>{JSON.stringify(unknown, null, 2)}</pre></details>}
  </details>;
}

function resultNarrative(preview: ResultPreview, missing: unknown[][], extra: unknown[][]) {
  const summary = preview.comparison_summary;
  if (!summary) return `已保存差异样本：缺失 ${missing.length}、多余 ${extra.length}；总数未记录`;
  if (summary.order_mismatch) return "行内容一致，但顺序不一致";
  if (summary.verdict !== "equal" && missing.length === 0 && extra.length === 0) return "比较未通过，未保存可展示的差异行";
  return `缺失 ${summary.missing_count}（已保存样本 ${missing.length}），多余 ${summary.extra_count}（已保存样本 ${extra.length}），匹配 ${summary.matched_count}`;
}

function SqlPanel({ detail, selected, showReference, comparisonMode, comparisonDetail, modelName, fontSize }: { detail: CaseRunDetail; selected: EligibleRun; showReference: boolean; comparisonMode: ComparisonMode; comparisonDetail?: CaseRunDetail; modelName?: string; fontSize: number }) {
  const modelSql = detail.formatted_sql ?? detail.generated_sql ?? "-- 尚无 SQL";
  const options = { readOnly: true, minimap: { enabled: false }, fontFamily: resolveShisuiTheme().fontMono, fontSize, lineHeight: Math.round(fontSize * 1.6), lineNumbersMinChars: 3, padding: { top: 16 } };
  if (comparisonMode === "model") return <div className="model-sql-comparison">
    <article><h4>{displayModelName(selected.model.name)}</h4><Editor beforeMount={configureShisuiMonaco} value={modelSql} language="sql" theme={SHISUI_MONACO_THEME} options={options}/></article>
    <article><h4>{modelName ? displayModelName(modelName) : "另一模型"}</h4>{comparisonDetail ? <Editor beforeMount={configureShisuiMonaco} value={comparisonDetail.formatted_sql ?? comparisonDetail.generated_sql ?? "-- 该模型没有 SQL"} language="sql" theme={SHISUI_MONACO_THEME} options={options}/> : <div className="result-empty">请选择本题本轮有作答的另一模型</div>}</article>
  </div>;
  if (showReference) return <div className="diff-frame"><div className="diff-labels"><span>参考 SQL</span><span>模型 SQL</span></div><DiffEditor beforeMount={configureShisuiMonaco} original={detail.formatted_reference_sql ?? detail.reference_sql ?? "-- Reference 不可用"} modified={modelSql} language="sql" theme={SHISUI_MONACO_THEME} options={{ ...options, renderSideBySide: true }}/>{!detail.formatted_reference_sql && detail.reference_sql && <p>参考 SQL 以原始格式展示</p>}</div>;
  return <div className="diff-frame"><Editor beforeMount={configureShisuiMonaco} value={modelSql} language="sql" theme={SHISUI_MONACO_THEME} options={options}/></div>;
}

export function SqlWorkspace({ open, onOpenChange, run, focus, onFocusChange }: { open: boolean; onOpenChange: (value: boolean) => void; run: RunSnapshot; focus: RunReviewState; onFocusChange: (patch: Partial<RunReviewState>) => void }) {
  const demoMode = useArenaStore((state) => state.demoMode);
  const recordingSize = useArenaStore((state) => state.recordingSize);
  const allRuns = useMemo(() => run.models.flatMap((model) => model.cases.filter((item) => item.stable_key === focus.caseKey).map((item) => ({ model, run: item }))), [focus.caseKey, run.models]);
  const selected = allRuns.find(({ model, run: item }) => model.id === focus.modelId && item.attempt === focus.attempt);
  const availableAttempts = [...new Set(allRuns.map(({ run: item }) => item.attempt))].sort((a, b) => a - b);
  const eligibleModels = run.models.map((model) => ({ model, run: model.cases.find((item) => item.stable_key === focus.caseKey && item.attempt === focus.attempt) })).filter((item): item is EligibleRun => Boolean(item.run));
  const caseRunId = selected?.run.id ?? null;
  const [showReference, setShowReference] = useState(false);
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>("reference");
  const [comparisonRunId, setComparisonRunId] = useState<number | null>(null);
  const [resultMode, setResultMode] = useState<ResultMode>("differences");
  const [missingPage, setMissingPage] = useState(0);
  const [extraPage, setExtraPage] = useState(0);
  const previousSelection = useRef<number | null>(null);

  useEffect(() => {
    if (!open || previousSelection.current !== caseRunId) {
      setShowReference(false);
      setComparisonMode("reference");
      setComparisonRunId(null);
      setMissingPage(0);
      setExtraPage(0);
    }
    previousSelection.current = open ? caseRunId : null;
  }, [caseRunId, open]);

  const baseQuery = useQuery({
    queryKey: ["case-evidence", caseRunId, false],
    queryFn: () => api.caseRun(caseRunId!, false),
    enabled: open && caseRunId !== null,
    refetchInterval: selected && !terminalCaseStatuses[selected.run.status] ? 1200 : false,
  });
  const referenceQuery = useQuery({
    queryKey: ["case-evidence", caseRunId, true],
    queryFn: () => api.caseRun(caseRunId!, true),
    enabled: open && caseRunId !== null && showReference,
    retry: false,
  });
  const comparisonQuery = useQuery({
    queryKey: ["case-evidence", comparisonRunId, false],
    queryFn: () => api.caseRun(comparisonRunId!, false),
    enabled: open && comparisonMode === "model" && comparisonRunId !== null,
    retry: false,
  });
  const detail = showReference && referenceQuery.data ? referenceQuery.data : baseQuery.data;
  const question = detail?.question ?? selected?.run.question ?? selected?.run.title ?? focus.caseKey;
  const otherModels = eligibleModels.filter(({ model }) => model.id !== focus.modelId);
  const compared = otherModels.find(({ run: item }) => item.id === comparisonRunId);
  const fontSize = demoMode ? (recordingSize === "large" ? 24 : 20) : 14;
  const setSection = (section: EvidenceSection) => onFocusChange({ evidenceSection: section });

  const changeModel = (modelId: number) => {
    setShowReference(false);
    setComparisonRunId(null);
    onFocusChange({ mode: "locked", modelId });
  };
  const changeAttempt = (attempt: number) => {
    setShowReference(false);
    setComparisonRunId(null);
    onFocusChange({ mode: "locked", attempt });
  };

  let body: ReactNode;
  if (!focus.caseKey) body = <div className="workspace-empty">请选择题目后查看证据</div>;
  else if (!selected) body = <div className="workspace-empty">此题第 {focus.attempt} 次暂无作答</div>;
  else if (baseQuery.isPending) body = <div className="workspace-empty">正在读取证据…</div>;
  else if (baseQuery.isError || !detail) body = <div className="workspace-error"><p>实际结果证据读取失败：{errorMessage(baseQuery.error)}</p><button onClick={() => baseQuery.refetch()}>重试</button></div>;
  else if (focus.evidenceSection === "plan") body = <section className="process-evidence"><header><small>01 / PLAN</small><h3>模型显式查询规划</h3></header><PlanEvidence plan={detail.plan} assumptions={detail.assumptions}/><details><summary>查看模型实际收到的 Prompt</summary><pre>{detail.prompt || "等待 Prompt 构建"}</pre></details><details><summary>查看模型原始结构化输出</summary><pre>{detail.raw_output ?? "暂无原始输出"}</pre></details></section>;
  else if (focus.evidenceSection === "sql") body = <section className="sql-evidence"><header><small>02 / SQL</small><h3>SQL 证据</h3></header><div className="comparison-toolbar"><label>对照方式<select value={comparisonMode} onChange={(event) => { const mode = event.target.value as ComparisonMode; setComparisonMode(mode); setComparisonRunId(null); if (mode === "model") setShowReference(false); }}><option value="reference">参考对照</option><option value="model">对比另一模型</option></select></label>{comparisonMode === "model" && <label>另一模型<select value={comparisonRunId ?? ""} onChange={(event) => setComparisonRunId(event.target.value ? Number(event.target.value) : null)}><option value="">请选择</option>{otherModels.map(({ model, run: item }) => <option key={item.id} value={item.id}>{displayModelName(model.name)}</option>)}</select></label>}</div>{comparisonQuery.isError && <div className="workspace-error">另一模型证据读取失败：{errorMessage(comparisonQuery.error)}</div>}<SqlPanel detail={detail} selected={selected} showReference={showReference} comparisonMode={comparisonMode} comparisonDetail={comparisonQuery.data} modelName={compared?.model.name} fontSize={fontSize}/></section>;
  else {
    const preview = detail.result_preview;
    const missingValid = preview?.missing === undefined || validRows(preview.missing);
    const extraValid = preview?.extra === undefined || validRows(preview.extra);
    const missing = validRows(preview?.missing) ? preview.missing : [];
    const extra = validRows(preview?.extra) ? preview.extra : [];
    const columns = resultColumns(detail.expected_result_preview, missing.length ? missing : extra);
    body = <section className="result-evidence"><header><small>03 / RESULT</small><h3>执行结果证据</h3></header>
      {referenceQuery.isError && <div className="workspace-error"><p>参考结果读取失败：{errorMessage(referenceQuery.error)}。实际结果仍可查看。</p><button onClick={() => referenceQuery.refetch()}>重试揭晓</button></div>}
      <div className="comparison-toolbar"><button className={resultMode === "differences" ? "active" : ""} onClick={() => setResultMode("differences")}>只看差异</button><button className={resultMode === "all" ? "active" : ""} onClick={() => setResultMode("all")}>全部结果</button></div>
      {resultMode === "all" ? <div className="result-tables"><DataTable preview={showReference ? detail.expected_result_preview : null} label="固定金标结果" error={showReference ? "固定金标结果不可用" : "揭晓参考结果后展示"}/><DataTable preview={detail.result_preview} label={`${displayModelName(selected.model.name)} 实际结果`} error={detail.error_message}/></div> : !showReference ? <div className="workspace-empty"><DataTable preview={detail.result_preview} label={`${displayModelName(selected.model.name)} 实际结果`} error={detail.error_message}/><button className="button" disabled={detail.status !== "completed"} onClick={() => setShowReference(true)}>揭晓参考结果后查看差异</button></div> : !missingValid || !extraValid ? <div className="workspace-error">差异记录格式不可用。可在“全部结果”或原始证据中继续检查。</div> : preview ? <><p className="evidence-summary">{resultNarrative(preview, missing, extra)}</p>{!preview.comparison_summary && typeof detail.score?.ordering === "number" && detail.score.ordering === 0 && <p>未通过排序/结果一致性评分，未记录独立排序证据</p>}<div className="result-tables"><DifferenceTable rows={missing} columns={columns} label="实际缺失的行" page={missingPage} onPage={setMissingPage}/><DifferenceTable rows={extra} columns={columns} label="实际多出的行" page={extraPage} onPage={setExtraPage}/></div><div className="diff-navigation"><button disabled={missing.length + extra.length === 0} onClick={() => document.querySelector("[data-difference-group]")?.scrollIntoView({ block: "nearest" })}>上一处</button><button disabled={missing.length + extra.length === 0} onClick={() => document.querySelectorAll("[data-difference-group]").item(1)?.scrollIntoView({ block: "nearest" })}>下一处</button></div></> : <div className="workspace-empty">没有结果比较证据</div>}
      <ScoreEvidence score={detail.score}/><details><summary>查看原始结果证据</summary><pre>{JSON.stringify(detail.result_preview, null, 2)}</pre></details>
    </section>;
  }

  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="sheet-overlay"/><Dialog.Content className="sql-sheet" {...(demoMode ? { "data-recording-size": recordingSize } : {})}>
    <div className="sheet-head"><div><Dialog.Title>查询规划 / SQL / 结果证据</Dialog.Title><Dialog.Description>{selected?.run.title ?? focus.caseKey ?? "请选择题目"} · {question ?? "选择题目以查看作答记录"}</Dialog.Description></div><Dialog.Close className="icon-only" aria-label="关闭证据工作台"><X/></Dialog.Close></div>
    <div className="workspace-toolbar"><label>模型作答<select value={focus.modelId ?? ""} onChange={(event) => changeModel(Number(event.target.value))}>{run.models.map((model) => <option key={model.id} value={model.id}>{displayModelName(model.name)}</option>)}</select><ChevronDown/></label>{availableAttempts.length > 0 && <div className="attempt-switch" aria-label="选择作答轮次">{availableAttempts.map((attempt) => <button className={focus.attempt === attempt ? "active" : ""} key={attempt} onClick={() => changeAttempt(attempt)}>A{attempt}</button>)}</div>}<span className="evidence-status"><ListTree/>{selected?.run.status ?? "无作答"}</span><button className="button ghost" disabled={!detail || detail.status !== "completed" || comparisonMode === "model"} onClick={() => setShowReference((value) => !value)}>{showReference ? <EyeOff/> : <Eye/>}{showReference ? "隐藏 Reference" : "显示 Reference"}</button></div>
    <nav className="workspace-tabs" aria-label="证据分区">{(["plan", "sql", "result"] as EvidenceSection[]).map((section) => <button key={section} className={focus.evidenceSection === section ? "active" : ""} onClick={() => setSection(section)}>{section === "plan" ? "规划" : section === "sql" ? "SQL" : "结果"}</button>)}</nav>
    {body}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
