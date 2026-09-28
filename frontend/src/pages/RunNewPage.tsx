import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, CircleAlert, Play, RefreshCw, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api/client";
import { preflightRun } from "../api/workflows";
import { EmptyState, PageHeader, StatusPill } from "../components/AppShell";
import { ModelIdentity, ModelLogo } from "../components/ModelIdentity";
import { displayModelName } from "../lib/modelIdentity";
import { displaySuiteName } from "../lib/suiteIdentity";
import { useArenaStore } from "../store";

type MatchPreset = { name: string; suiteId: number; suiteHash: string; models: number[]; cases: number[] | null; attempts: number };
const PRESET_KEY = "arena-match-presets-v1";
const ids = (value: unknown): value is number[] => Array.isArray(value) && value.every((item) => Number.isInteger(item) && item > 0);
function loadPresets(): MatchPreset[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PRESET_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is MatchPreset => item != null && typeof item === "object" && typeof item.name === "string" && typeof item.suiteHash === "string" && Number.isInteger(item.suiteId) && ids(item.models) && item.models.length > 0 && item.models.length <= 6 && (item.cases === null || ids(item.cases)) && item.attempts === 1).slice(0, 20);
  } catch { return []; }
}

export function RunNewPage() {
  const demo = useArenaStore((state) => state.demoMode);
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles, select: (items) => items.map((profile) => profile.adapter_kind === "pi" ? profile : { ...profile, enabled: false }).sort((a, b) => Number(b.adapter_kind === "pi") - Number(a.adapter_kind === "pi")) });
  const suites = useQuery({ queryKey: ["suites"], queryFn: api.suites });
  const runs = useQuery({ queryKey: ["runs"], queryFn: api.runs });
  const published = useMemo(() => suites.data?.flatMap((suite) => suite.versions.filter((version) => version.status === "published").map((version) => ({ suite, version }))).sort((a, b) => b.version.version - a.version.version) ?? [], [suites.data]);
  const [suiteId, setSuiteId] = useState<number | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [caseIds, setCaseIds] = useState<number[] | null>(null);
  const [attempts, setAttempts] = useState(1);
  const [presets, setPresets] = useState(loadPresets);
  const [presetName, setPresetName] = useState("");
  const [presetIndex, setPresetIndex] = useState("");
  const [search, setSearch] = useState("");
  const [historyStatus, setHistoryStatus] = useState("all");
  const suite = published.find(({ version }) => version.id === (suiteId ?? published[0]?.version.id));
  const cases = suite?.version.cases ?? [];
  const chosenCases = caseIds === null ? cases : cases.filter((item) => caseIds.includes(item.id));
  const selectedProfiles = profiles.data?.filter((profile) => selected.includes(profile.id)) ?? [];
  const payload = { suite_version_id: suite?.version.id ?? 0, model_profile_ids: selected, case_ids: caseIds, attempts };
  const readyToCheck = Boolean(suite && selected.length && chosenCases.length);
  const preflight = useQuery({ queryKey: ["preflight", payload], queryFn: () => preflightRun(payload), enabled: readyToCheck, staleTime: 0, retry: false, refetchInterval: 30_000 });
  const start = useMutation({
    mutationFn: async () => {
      const checked = await preflightRun(payload);
      if (!checked.ready) throw new Error(checked.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join("；") || "运行条件已变化，请重新检查");
      return api.createRun(payload);
    },
    onSuccess: (run) => window.location.assign(`/runs/${run.id}/live`),
    onError: (error: Error) => { toast.error(error.message); void preflight.refetch(); },
  });
  const toggle = (id: number) => setSelected((values) => values.includes(id) ? values.filter((value) => value !== id) : values.length < 6 ? [...values, id] : values);
  const totalCalls = chosenCases.length * selected.length * attempts;
  const persist = (next: MatchPreset[]) => {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(next)); setPresets(next); return true; }
    catch { toast.error("浏览器未允许保存方案，请检查本地存储权限"); return false; }
  };
  const savePreset = () => {
    if (!suite || !selected.length || !chosenCases.length || !presetName.trim()) return;
    const name = presetName.trim();
    if (presets.some((preset) => preset.name === name)) { toast.error("方案名称已存在，请换一个名称或先删除旧方案"); return; }
    if (presets.length >= 20) { toast.error("最多保存 20 个方案，请先删除不再使用的方案"); return; }
    if (persist([...presets, { name, suiteId: suite.version.id, suiteHash: suite.version.content_hash!, models: selected, cases: caseIds, attempts }])) { setPresetName(""); toast.success("方案已保存在此浏览器；不包含密钥"); }
  };
  const applyPreset = (index: string) => {
    setPresetIndex(index);
    if (index === "") return;
    const preset = presets[Number(index)];
    const version = published.find((item) => item.version.id === preset.suiteId)?.version;
    if (!version || version.content_hash !== preset.suiteHash) { toast.error("方案测试集版本不可用或指纹不一致，未替换当前配置"); return; }
    if (preset.cases?.some((id) => !version.cases.some((item) => item.id === id))) { toast.error("方案中存在不可用题目，未替换当前配置"); return; }
    if (preset.models.some((id) => !profiles.data?.some((item) => item.id === id && item.enabled && item.adapter_kind === "pi"))) { toast.error("方案中存在历史、已删除或禁用的模型，未替换当前配置"); return; }
    setSuiteId(preset.suiteId); setSelected(preset.models); setCaseIds(preset.cases); setAttempts(1);
    toast.success("已载入方案；使用模型当前配置，运行前重新检查");
  };
  const history = runs.data?.runs.filter((run) => (historyStatus === "all" || (historyStatus === "completed" ? run.status === "completed" : run.status !== "completed")) && `${run.id} ${run.models.map((model) => model.name).join(" ")}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const estimate = preflight.data?.estimate;
  const error = profiles.error ?? suites.error;
  if (error) return <div className="page"><EmptyState icon={<CircleAlert/>} title="工作台暂时无法读取数据" body={(error as Error).message} action={<button className="button" onClick={() => { void profiles.refetch(); void suites.refetch(); }}>重新读取</button>}/></div>;
  if (profiles.isPending || suites.isPending) return <div className="loading-screen"><RefreshCw className="spin"/>正在读取评测配置…</div>;

  return <div className="page run-setup-page">
    <PageHeader eyebrow="本地评测" title="新建评测" description="选择测试集版本和题目 → 选择模型 → 核对预检与调用量 → 开始运行 → 逐题复核报告。"/>
    {!published.length ? <EmptyState title="暂无已发布测试集" body="应用当前未提供可供评测选择的已发布版本。" action={<Link className="button primary" to="/benchmarks">查看测试集<ArrowRight/></Link>}/> : <>
      <details className="recording-secondary preset-controls" open={demo ? undefined : true}><summary>预设管理</summary><div className="preset-bar"><label htmlFor="match-preset" className="sr-only">常用评测方案</label><select id="match-preset" value={presetIndex} onChange={(event) => applyPreset(event.target.value)}><option value="">载入常用方案 · 当前浏览器</option>{presets.map((preset, index) => <option key={preset.name} value={index}>{preset.name}</option>)}</select><button className="button ghost" disabled={presetIndex === ""} onClick={() => { if (persist(presets.filter((_, index) => index !== Number(presetIndex)))) setPresetIndex(""); }}><Trash2/>删除方案</button></div></details>
      <div className="setup-layout"><div className="setup-main">
        <section className="setup-section"><div className="section-title"><div><span className="step-no">01</span><h2>测试集与题目</h2></div><Link className="button ghost" to="/benchmarks">查看测试集</Link></div>
          <p className="suite-name">{suite && displaySuiteName(suite.suite.name)}</p>
          <label className="suite-selector">版本<select value={suite?.version.id ?? ""} onChange={(event) => { setSuiteId(Number(event.target.value)); setCaseIds(null); setPresetIndex(""); }}>{published.map(({ suite: item, version }) => <option key={version.id} value={version.id}>{suites.data?.length === 1 ? "v" + version.version : displaySuiteName(item.name) + " · v" + version.version}</option>)}</select></label>
          <p className="suite-proof"><span>v{suite?.version.version}</span><span>{chosenCases.length} / {cases.length} 题入选</span><span>{suite?.version.dialect.toUpperCase()} · 固定数据</span><code title={suite?.version.content_hash ?? ""}>{suite?.version.content_hash?.slice(0, 12)}</code></p>
          <details className="case-picker"><summary>选择测试用例</summary><div className="case-picker-toolbar"><small>所选模型使用相同的测试用例</small><div className="button-row"><button className="button ghost" onClick={() => setCaseIds(null)}>全选</button><button className="button ghost" onClick={() => setCaseIds([])}>清空</button></div></div><div className="case-options">{cases.map((item, index) => <label className="case-option" key={item.id}><input type="checkbox" checked={caseIds === null || caseIds.includes(item.id)} onChange={() => setCaseIds((previous) => { const current = previous ?? cases.map((entry) => entry.id); return current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id]; })}/><div><b>{String(index + 1).padStart(2, "0")} · {item.title}</b><p>{item.question}</p><small>{item.radar_dimension} · {item.difficulty === "easy" ? "基础" : item.difficulty === "hard" ? "挑战" : "进阶"}</small></div></label>)}</div></details>
        </section>
        <section className="setup-section"><div className="section-title"><div><span className="step-no">02</span><h2>选择模型</h2></div><small>已选 {selected.length} / 6</small></div>
          {!profiles.data?.length ? <EmptyState title="暂无模型配置" body="先添加模型，再检查接入是否可用。" action={<Link className="button primary" to="/models">配置模型</Link>}/> : <><div className="model-grid">{profiles.data.filter((profile) => !demo || profile.enabled || selected.includes(profile.id)).map((profile) => { const active = selected.includes(profile.id); return <button key={profile.id} className={`model-card ${active ? "selected" : ""}`} disabled={!profile.enabled || (!active && selected.length >= 6)} aria-pressed={active} onClick={() => toggle(profile.id)}><ModelLogo name={profile.name} modelId={profile.model_id} adapterKind={profile.adapter_kind}/><div><h3>{displayModelName(profile.name)}</h3><code>{profile.model_id}</code></div><span className="model-select-box" aria-hidden="true">{active && <Check/>}</span><div className="model-card-foot"><StatusPill status={profile.enabled ? (profile.health_status || "unknown") : "unavailable"}/><span>{profile.base_url}</span></div></button>; })}</div>{demo && profiles.data.some((profile) => !profile.enabled && !selected.includes(profile.id)) && <details className="recording-secondary unavailable-models"><summary>历史不可用模型（{profiles.data.filter((profile) => !profile.enabled && !selected.includes(profile.id)).length}）</summary><p>这些配置不会加入本次运行。可前往<Link to="/models">模型配置</Link>查看或修复。</p></details>}</>}
          <p className="fairness-note">新评测采用统一受控调用，固定每题单次作答；历史配置不可运行。报告保留 Provider、认证和有效控制项。<Link to="/models"> 模型配置与检查 →</Link></p>
        </section>
        <details className="recording-secondary preset-save" open={demo ? undefined : true}><summary>保存评测方案</summary><section className="setup-section"><div className="section-title"><div><span className="step-no">03</span><h2>保存评测方案</h2></div></div><p className="page-description">方案只保存选择项；正式运行仍冻结当时的配置。要复现旧配置，请从历史报告按快照重跑。</p><div className="preset-form"><label className="sr-only" htmlFor="preset-name">方案名称</label><input id="preset-name" value={presetName} maxLength={60} onChange={(event) => setPresetName(event.target.value)} placeholder="例如：零售分析 · 双模型"/><button className="button" disabled={!presetName.trim() || !readyToCheck} onClick={savePreset}><Save/>保存</button></div></section></details>
      </div>
      <aside className="setup-aside" aria-label="运行前检查"><h2>运行前检查</h2><dl><div><dt>测试集</dt><dd>{suite && displaySuiteName(suite.suite.name)} · v{suite?.version.version}</dd></div><div><dt>模型</dt><dd>{selectedProfiles.length} 个</dd></div><div><dt>题目</dt><dd>{chosenCases.length} 道</dd></div><div><dt>总调用量</dt><dd>{totalCalls} 次</dd></div></dl><p>每题单次作答</p><div className="segments" aria-label="重复次数"><button aria-pressed="true" className="active" disabled>1 次</button></div><p>预检只核对本地配置，不发送模型请求，也不保证远端可用。</p>
        {readyToCheck ? <div className="preflight-result" aria-live="polite">{preflight.isFetching && <p>正在核对本地配置…</p>}{preflight.error && <><p className="error">{(preflight.error as Error).message}</p><button className="button" onClick={() => void preflight.refetch()}>重新检查</button></>}{preflight.data && <><h3><ShieldCheck size={16}/> {preflight.data.ready ? "条件已满足" : "检查未通过"}</h3>{preflight.data.issues.length > 0 && <ul>{preflight.data.issues.map((issue, index) => <li className={issue.severity} key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul>}<p>预计用时：{estimate?.estimated_duration_seconds != null ? `约 ${Math.ceil(estimate.estimated_duration_seconds / 60)} 分钟` : "没有足够历史样本"}<br/>预计费用：{estimate?.estimated_cost_usd != null ? `$${estimate.estimated_cost_usd.toFixed(4)}` : "暂不可估算"}</p><small>{estimate?.sample_calls ? `依据 ${estimate.sample_calls} 次历史调用，仅供参考。` : "不使用固定常量假装实时估算。"}</small></>}</div> : <p >选择至少一道题和一个模型后，自动检查运行条件。</p>}
        <button className="button launch" disabled={!readyToCheck || !preflight.data?.ready || preflight.isFetching || preflight.isError || start.isPending} onClick={() => start.mutate()}>{start.isPending ? <RefreshCw className="spin"/> : <Play/>}{start.isPending ? "正在创建运行…" : "开始评测"}</button><p>点击后才会真实调用模型，可能产生费用；完成后逐题看结果正确率、失败原因和综合分。不会自动发布。</p>
      </aside></div>
    </>}
    <details className="recording-secondary recording-history" open={demo ? undefined : true}><summary>历史运行</summary>
    <section className="run-history"><header><div><h2>历史运行</h2></div><div className="history-tools"><input aria-label="搜索历史运行" placeholder="运行编号或模型名称" value={search} onChange={(event) => setSearch(event.target.value)}/><select aria-label="历史状态筛选" value={historyStatus} onChange={(event) => setHistoryStatus(event.target.value)}><option value="all">全部状态</option><option value="completed">已完成</option><option value="other">有失败 / 其他状态</option></select></div></header>
      {runs.error ? <p className="notice error">历史记录读取失败：{(runs.error as Error).message}</p> : !history.length ? <p className="notice">{runs.isPending ? "正在读取历史运行…" : "暂无匹配的运行记录。"}</p> : <><p><small>最近 {runs.data?.runs.length} 次运行，当前显示 {history.length} 次</small></p>{history.map((run) => <Link className="history-row" to={`/runs/${run.id}/${["completed", "completed_with_errors", "failed", "cancelled", "interrupted"].includes(run.status) ? "report" : "live"}`} key={run.id}><b>#{run.id}</b><span className="run-models">{run.models.map((model) => <ModelIdentity compact key={model.id} name={model.name} modelId={model.requested_model_id}/>)}</span><small>{run.case_count} 题 × {run.attempts} 次{run.source_run_id && ` · 来自 #${run.source_run_id}`}</small><StatusPill status={run.status}/></Link>)}</>}
    </section>
    </details>
  </div>;
}
