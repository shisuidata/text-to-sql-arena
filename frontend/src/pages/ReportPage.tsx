import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Check, ChevronLeft, ChevronRight, CircleHelp, Copy, Download, Eye, EyeOff, FileCheck2, Gauge, Pause, Play, RefreshCw, RotateCcw, Search, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api/client";
import { exportPublicationPackage, getPublicationPreview, rerunRun, type PublicationPreview } from "../api/workflows";
import { PageHeader } from "../components/AppShell";
import { SqlWorkspace } from "../components/SqlWorkspace";
import { displayModelName } from "../lib/modelIdentity";
import { anonymousName, actualControlVariants, buildCaseRounds, buildComparisonEvidence, buildReportVerdict, buildRoundSignals, selectKeyRounds, filterRounds, adjacentRoundKey, compareResultCorrect, comparisonControls, isRepeatPair, keyRounds, summarizeModelEvidence, terminalRunStatuses, type CaseRound, type ReportModel, type ReportSnapshot, type RoundFilter, type RoundSignals } from "../lib/reportAnalysis";
import type { CaseRun } from "../types";
import { defaultRunReview, useArenaStore, type EvidenceSection, type RunReviewState } from "../store";
import { resolveReview } from "../lib/runReview";
import "./report.css";

type Layer = "watch" | "inspect" | "verify";
const percent = (value: number | null | undefined) => value == null ? "待评估" : `${(value * 100).toFixed(1)}%`;
const score = (value: number | null | undefined) => value == null ? "—" : value.toFixed(2);
const compact = (value: number | null | undefined) => value == null ? "—" : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1, notation: "compact" }).format(value);

const failureLabels: Record<string, string> = { policy_rejected: "政策拒绝（未证明业务错误）", protocol_error: "JSON 协议失败", execution_error: "SQL 解析或执行失败", provider_error: "Provider 调用失败", infrastructure_error: "本地基础设施错误", cancelled: "已取消", result_mismatch: "业务结果不匹配", format_mismatch: "输出格式不匹配" };

export function ReportPage() {
  const runId = Number(useParams().id);
  const report = useQuery({ queryKey: ["report", runId], queryFn: () => api.report(runId), enabled: Number.isFinite(runId), refetchInterval: (query) => terminalRunStatuses[query.state.data?.status ?? ""] ? false : 1500 });
  if (report.isError) return <main className="report-state"><AlertTriangle/><h1>报告读取失败</h1><p>{report.error instanceof Error ? report.error.message : "无法连接本地评测服务。"}</p><button className="button primary" onClick={() => report.refetch()}>重新读取</button></main>;
  if (!report.data) return <div className="loading-screen"><Gauge className="spin"/>正在读取评测报告…</div>;
  return <ReportExperience key={runId} report={report.data as ReportSnapshot}/>;
}

function ReportExperience({ report }: { report: ReportSnapshot }) {
  const savedReview = useArenaStore((state) => state.reviewByRun[report.id] ?? defaultRunReview);
  const updateRunReview = useArenaStore((state) => state.updateRunReview);
  const review = useMemo(() => resolveReview(report, savedReview), [report, savedReview]);
  const layer = review.reportLayer;
  const setLayer = (reportLayer: Layer) => { setPlaying(false); updateRunReview(report.id, { reportLayer }); };
  const [blind, setBlind] = useState(false);
  const [revealed, setRevealed] = useState(true);
  const [prediction, setPrediction] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [filter, setFilter] = useState<RoundFilter>("all");
  const [intervalSeconds, setIntervalSeconds] = useState(10);
  const workspaceScroll = useRef(0);
  const [rerunChoice, setRerunChoice] = useState<null | { scope: "all" | "failed"; mode: "exact" | "current" }>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [publication, setPublication] = useState<PublicationPreview | null>(null);
  const [exportArmed, setExportArmed] = useState(false);
  const rounds = useMemo(() => buildCaseRounds(report), [report]);
  const highlights = useMemo(() => keyRounds(rounds), [rounds]);
  const ranked = useMemo(() => [...report.models].sort((a, b) => report.quality_schema_version === "result-quality-v2" ? (b.quality?.correct_rate ?? -1) - (a.quality?.correct_rate ?? -1) : (b.official_score ?? -Infinity) - (a.official_score ?? -Infinity)), [report.models, report.quality_schema_version]);
  const showIdentity = !blind || revealed;
  const completed = Boolean(terminalRunStatuses[report.status]);
  const expectedAttempts = report.protocol.case_count * Math.max(1, report.attempts);
  const nameFor = (model: ReportModel) => showIdentity ? displayModelName(model.name) : anonymousName(report.models.indexOf(model));

  const signals = useMemo(() => buildRoundSignals(report, rounds), [report, rounds]);
  const keyQuestions = useMemo(() => selectKeyRounds(rounds, signals), [rounds, signals]);
  const visibleRounds = useMemo(() => filterRounds(rounds, signals, filter, review.markedCaseKeys), [rounds, signals, filter, review.markedCaseKeys]);
  const currentRound = visibleRounds.find((round) => round.key === review.caseKey);
  const currentIndex = visibleRounds.findIndex((round) => round.key === review.caseKey);
  const changeFocus = (patch: Partial<RunReviewState>) => { setPlaying(false); updateRunReview(report.id, { ...resolveReview(report, { ...review, ...patch }), mode: "locked" }); };
  const openEvidence = (key: string, modelId?: number, section: EvidenceSection = "result") => {
    if (!showIdentity) return;
    workspaceScroll.current = window.scrollY;
    changeFocus({ caseKey: key, modelId: modelId ?? review.modelId, evidenceSection: section });
    setWorkspaceOpen(true);
  };
  const toggleMarked = (key: string) => changeFocus({ markedCaseKeys: review.markedCaseKeys.includes(key) ? review.markedCaseKeys.filter((item) => item !== key) : [...review.markedCaseKeys, key] });
  const navigateRound = (delta: -1 | 1) => {
    const caseKey = adjacentRoundKey(visibleRounds, review.caseKey, delta);
    if (caseKey !== null) changeFocus({ caseKey });
  };
  const changeFilter = (value: RoundFilter) => {
    setPlaying(false); setFilter(value);
    const next = filterRounds(rounds, signals, value, review.markedCaseKeys);
    if (!next.some((round) => round.key === review.caseKey)) changeFocus({ caseKey: next[0]?.key ?? null });
  };
  useEffect(() => {
    if (savedReview.caseKey === null && report.selected_case_keys.length) updateRunReview(report.id, { caseKey: report.selected_case_keys[0] });
  }, [report.id, report.selected_case_keys, savedReview.caseKey, updateRunReview]);
  useEffect(() => {
    if (!playing || !completed || !showIdentity || layer !== "watch" || workspaceOpen || currentIndex < 0 || currentIndex >= visibleRounds.length - 1) { setPlaying(false); return; }
    const timer = window.setTimeout(() => {
      const next = visibleRounds[currentIndex + 1];
      updateRunReview(report.id, { mode: "locked", caseKey: next.key });
      if (currentIndex + 1 === visibleRounds.length - 1) setPlaying(false);
    }, intervalSeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [playing, completed, showIdentity, layer, workspaceOpen, currentIndex, visibleRounds, intervalSeconds, report.id, updateRunReview]);
  useEffect(() => {
    const pauseHidden = () => { if (document.visibilityState === "hidden") setPlaying(false); };
    document.addEventListener("visibilitychange", pauseHidden);
    return () => document.removeEventListener("visibilitychange", pauseHidden);
  }, []);
  useEffect(() => { setPlaying(false); }, [review.modelId, review.attempt]);

  const beginBlind = () => {
    setBlind(true);
    setRevealed(false);
    setPrediction(null);
    setWorkspaceOpen(false);
    setLayer("watch");
    setRerunChoice(null);
    setPlaying(false);
  };
  const reveal = () => {
    setBlind(false);
    setRevealed(true);
    setPlaying(false);
  };
  const downloadJson = () => {
    if (!showIdentity) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `run-${report.id}-evidence.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const confirmRerun = async () => {
    if (!rerunChoice) return;
    setActionBusy(true);
    try {
      const created = await rerunRun(report.id, rerunChoice);
      window.location.assign(`/runs/${created.id}/live`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "复测启动失败");
      setActionBusy(false);
    }
  };
  const previewPublication = async () => {
    setActionBusy(true);
    try {
      setPublication(await getPublicationPreview(report.id));
      setExportArmed(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "发布预检失败");
    } finally {
      setActionBusy(false);
    }
  };
  const exportPublication = async () => {
    if (!publication || !exportArmed) return;
    setActionBusy(true);
    try {
      const exported = await exportPublicationPackage(report.id, publication.summary_digest);
      const url = URL.createObjectURL(exported.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exported.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setExportArmed(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "证据包导出失败");
    } finally {
      setActionBusy(false);
    }
  };

  return <div className="page report-page">
    <PageHeader eyebrow={`运行 #${report.id} · ${completed ? "已结束" : "运行中"}`} title="评测报告" description="查看模型得分、逐题结果、运行配置与原始记录。" actions={<>
      <Link className="button ghost" to={`/runs/${report.id}/live`}><ArrowLeft/>运行过程</Link>
      <button className="button ghost" onClick={() => navigator.clipboard.writeText(window.location.href).then(() => toast.success("报告链接已复制"))}><Copy/>复制链接</button>
      {showIdentity ? <button className="button ghost" onClick={beginBlind}><EyeOff/>匿名预测</button> : <button className="button ghost" onClick={reveal}><Eye/>退出匿名模式</button>}
      <button className="button primary" disabled={!completed || !showIdentity || report.models.some((model) => model.adapter_kind !== "pi")} onClick={() => setRerunChoice({ scope: "failed", mode: "exact" })}><RotateCcw/>复测</button>
    </>}/>

    {showIdentity && report.models.some((model) => model.adapter_kind !== "pi") && <p className="notice">此运行使用历史接入；新建评测需选择当前可用的模型配置。历史记录保持不变。</p>}
    {!completed && <div className="report-running"><RefreshCw className="spin"/><b>运行中</b><span>当前显示已保存的记录，得分和逐题结果会随运行更新。</span></div>}
    {!report.models.length && <section className="report-empty"><CircleHelp/><h2>暂无模型结果</h2><p>运行已建立，但尚未收到任何模型案例。可回到运行过程查看状态。</p></section>}

    {blind && !revealed && <section className="blind-banner" aria-label="匿名预测模式"><div><b>匿名预测模式</b><p>匿名模式隐藏模型身份、SQL 和导出入口，使用临时代号。预测仅保存在当前标签页，不上传或计分。</p></div><button className="button ghost" onClick={reveal}>退出匿名模式</button></section>}

    <nav className="report-layers" aria-label="报告视图">
      {([['watch','结果概览','模型得分与题目差异'],['inspect','逐题分析','质量指标与逐题证据'],['verify','配置与证据','运行配置、对照与导出']] as const).map(([value, title, note], index) => <button key={value} disabled={!showIdentity && value !== "watch"} aria-pressed={layer === value} className={layer === value ? "active" : ""} onClick={() => setLayer(value)}><span>0{index + 1}</span><b>{title}</b><small>{note}</small></button>)}
    </nav>

    {layer === "watch" && <WatchLayer report={report} rounds={rounds} ranked={ranked} highlights={highlights} keyQuestions={keyQuestions} signals={signals} nameFor={nameFor} prediction={prediction} setPrediction={setPrediction} showIdentity={showIdentity} reveal={reveal} expectedAttempts={expectedAttempts} openEvidence={openEvidence} review={review} toggleMarked={toggleMarked}>
      <ReplayBoard report={report} rounds={visibleRounds} round={currentRound} currentIndex={currentIndex} review={review} filter={filter} changeFilter={changeFilter} playing={playing} setPlaying={setPlaying} intervalSeconds={intervalSeconds} setIntervalSeconds={(value) => { setPlaying(false); setIntervalSeconds(value); }} navigateRound={navigateRound} changeFocus={changeFocus} toggleMarked={toggleMarked} openEvidence={openEvidence} nameFor={nameFor} dialogOpen={workspaceOpen || rerunChoice !== null}/>
    </WatchLayer>}
    {layer === "inspect" && <InspectLayer report={report} rounds={rounds} nameFor={nameFor} showIdentity={showIdentity} openCase={openEvidence}/>}
    {layer === "verify" && <VerifyLayer report={report} nameFor={nameFor} showIdentity={showIdentity} downloadJson={downloadJson} previewPublication={previewPublication} publication={publication} exportArmed={exportArmed} setExportArmed={setExportArmed} exportPublication={exportPublication} actionBusy={actionBusy}/>}

    {rerunChoice && <section className="action-confirm" role="dialog" aria-label="确认复测"><div><b>确认启动新的模型调用</b><p>这会创建新运行，不会修改当前证据。请选择冻结快照或当前配置，以及复测范围。</p></div><label>配置<select value={rerunChoice.mode} onChange={(event) => setRerunChoice({ ...rerunChoice, mode: event.target.value as "exact" | "current" })}><option value="exact">原运行冻结快照</option><option value="current">当前配置</option></select></label><label>范围<select value={rerunChoice.scope} onChange={(event) => setRerunChoice({ ...rerunChoice, scope: event.target.value as "all" | "failed" })}><option value="failed">仅失败题</option><option value="all">全部题</option></select></label><button className="button ghost" onClick={() => setRerunChoice(null)}>取消</button><button className="button primary" disabled={actionBusy} onClick={confirmRerun}>{actionBusy ? "正在创建…" : "确认并启动调用"}</button></section>}
    {showIdentity && <SqlWorkspace open={workspaceOpen} onOpenChange={(open) => { setPlaying(false); setWorkspaceOpen(open); if (!open) requestAnimationFrame(() => window.scrollTo(0, workspaceScroll.current)); }} run={report} focus={review} onFocusChange={changeFocus}/>}
  </div>;
}

function WatchLayer({ report, rounds, ranked, highlights, keyQuestions, signals, nameFor, prediction, setPrediction, showIdentity, reveal, expectedAttempts, openEvidence, review, toggleMarked, children }: {
  report: ReportSnapshot; rounds: CaseRound[]; ranked: ReportModel[]; highlights: CaseRound[]; keyQuestions: CaseRound[]; signals: Map<string, RoundSignals>; nameFor: (model: ReportModel) => string; prediction: number | null; setPrediction: (id: number) => void; showIdentity: boolean; reveal: () => void; expectedAttempts: number; openEvidence: (key: string, modelId?: number, section?: EvidenceSection) => void; review: RunReviewState; toggleMarked: (key: string) => void; children: ReactNode;
}) {
  const modern = report.quality_schema_version === "result-quality-v2";
  const verdict = buildReportVerdict(report, nameFor);
  const comparison = buildComparisonEvidence(rounds);
  if (!showIdentity) return <section className="match-scoreboard"><h2>匿名结果预测</h2><p>结果暂时隐藏。预测只在本标签页暂存，不上传、不计票、不影响评分。</p><div className="blind-contenders">{report.models.map((model) => <button key={model.id} className="button" aria-pressed={prediction === model.id} onClick={() => setPrediction(model.id)}>{prediction === model.id && <Check/>}{nameFor(model)} · 选择此模型</button>)}</div><button className="button primary" onClick={reveal}>显示模型与结果</button></section>;
  return <div className="report-layer-content">
    <section className="match-summary" aria-label="本次结论"><h2>{verdict.text}</h2><p>综合得分不是正确率。这是一次运行的观察，不是统计显著性结论；只适用于本次测试集版本与调用配置。</p></section>
    {modern && <section className="quality-board"><header><h2>业务结果正确率</h2><p>分母包含全部计划尝试；未确认的结果不补零。</p></header><div className="quality-models">{report.models.map((model) => <article key={model.id}><h3>{nameFor(model)}</h3><div className="quality-rate"><strong>{percent(model.quality?.correct_rate)}</strong><span>已确认正确 {model.quality?.result_correct ?? "未记录"}/{model.quality?.total ?? expectedAttempts} 次计划尝试</span></div><p>结果证据覆盖 {model.quality?.evaluated ?? "未记录"}/{model.quality?.total ?? expectedAttempts}</p></article>)}</div></section>}
    {modern && <section className="capability-summary" aria-label="简短结果与能力分析"><header><div><span className="section-kicker">基于本次逐题证据</span><h2>结果与能力分析</h2></div><p>仅说明本次测试集上的表现；未执行或被政策拒绝的题不当作业务错解。</p></header><div className="capability-models">{report.models.map((model) => {
      const finding = summarizeModelEvidence(report, model);
      return <article key={model.id}><h3>{nameFor(model)}</h3><p>结果：已确认正确 {finding.correct}/{finding.planned} 次；已执行但结果不符 {finding.mismatched} 次；未能判定 {finding.unjudged} 次。</p><p>能力观察：{finding.weakAreas.length ? finding.weakAreas.map(({ area, titles }) => area + "（" + titles.join("、") + "）").join("；") + "的金标未匹配；需逐题核对题意、口径与 SQL，不能仅凭失分断定能力不足。" : finding.unjudged ? "现有证据不足以归纳业务短板。" : "本次未观察到业务结果不匹配；不代表其他数据也能通过。"}</p>{finding.constraintCases.length > 0 && <p>指定 SQL 写法未通过：{finding.constraintCases.join("、")}。这与业务结果分开判断。</p>}{Object.keys(finding.failureKinds).length > 0 && <p>非业务失败：{Object.entries(finding.failureKinds).map(([kind, count]) => (failureLabels[kind] ?? kind) + " " + count + " 次").join("；")}。</p>}</article>;
    })}</div></section>}
    {modern && report.models.length > 1 && <section className="comparison-evidence" aria-label="题目区分证据"><header><div><span className="section-kicker">本次运行</span><h2>哪些题拉开差异</h2></div><p>只比较已完整判定的业务结果；共同失分不能区分模型，未知题不算答错。</p></header><dl><div><dt>结果有差异 · {comparison.differentiating.length} 题</dt><dd>{comparison.differentiating.join("、") || "没有"}</dd></div><div><dt>共同未全对 · {comparison.sharedMisses.length} 题</dt><dd>{comparison.sharedMisses.join("、") || "没有"}；优先核对题意与口径。</dd></div>{comparison.unknown.length > 0 && <div><dt>证据不足 · {comparison.unknown.length} 题</dt><dd>{comparison.unknown.join("、")}</dd></div>}</dl></section>}
    <section className="round-highlights" aria-label="关键题"><header><h2>关键题直达</h2><p>按结果差异、失败与未知证据排序；多尝试显示汇总，工作台核对当前第 {review.attempt} 次。</p></header>
      {keyQuestions.length ? <div className="highlight-list">{keyQuestions.map((round) => {
        const signal = signals.get(round.key)!;
        const reasons = [signal.businessDifference && (modern ? "业务差异" : "历史结果合同差异"), signal.businessFailure && (modern ? "业务答错" : "历史结果合同未通过"), signal.formatFailure && "格式问题", signal.capabilityFailure && "能力约束未通过", signal.unknown && "证据未知"].filter(Boolean);
        return <article key={round.key}><div><button className="button" onClick={() => openEvidence(round.key)}>查看关键题：{round.title}</button><p>{reasons.join(" · ")}</p>{signal.failureKinds.map((kind) => <small key={kind}>{failureLabels[kind] ?? kind}</small>)}</div>
          <div>{round.models.map((row) => {
            const attempts = row.model.cases.filter((item) => item.stable_key === round.key);
            const format = attempts.some((item) => item.quality?.format_ok === false) ? "未通过" : attempts.length === report.attempts && attempts.every((item) => item.quality?.format_ok === true) ? "通过" : "未记录";
            const rules = attempts.flatMap((item) => item.score?.ast_rules ?? []);
            const capability = rules.some((rule) => !rule.passed) ? "未通过" : rules.length ? "已记录规则通过" : "未记录";
            return <button className="button ghost" key={row.model.id} onClick={() => openEvidence(round.key, row.model.id)}>{nameFor(row.model)} · 结果 {row.resultCorrect === null ? "未知" : percent(row.resultCorrect)} · 格式 {format} · 能力 {capability}</button>;
          })}</div><button className="button ghost" aria-pressed={review.markedCaseKeys.includes(round.key)} onClick={() => toggleMarked(round.key)}>{review.markedCaseKeys.includes(round.key) ? "取消标记" : "标记讲解题"}：{round.title}</button></article>;
      })}</div> : <p>没有需要优先核对的关键题。</p>}
    </section>
    <details className="match-scoreboard"><summary>{modern ? "辅助综合分" : "历史合同综合分"}</summary><p>原合同得分保留，不作为业务正确率胜负依据。</p><div className="score-lines">{ranked.map((model) => <div className="score-line" key={model.id}><b>{nameFor(model)}</b><strong>{score(model.official_score)}</strong></div>)}</div></details>
    <details className="round-highlights"><summary>辅助综合分差异（不是业务差异）</summary><p>按全部计划尝试的均分和题目权重计算对总分的贡献。</p>{highlights.map((round) => <article key={round.key}><b>{round.title}</b><p>对总分的最大影响 {score(round.spread)}</p>{round.models.map((row) => <p key={row.model.id}>{nameFor(row.model)} 均值 {score(row.score)} · 总分贡献 {score(row.contribution)}</p>)}</article>)}</details>
    {children}
  </div>;
}

function ReplayBoard({ report, rounds, round, currentIndex, review, filter, changeFilter, playing, setPlaying, intervalSeconds, setIntervalSeconds, navigateRound, changeFocus, toggleMarked, openEvidence, nameFor, dialogOpen }: {
  report: ReportSnapshot; rounds: CaseRound[]; round: CaseRound | undefined; currentIndex: number; review: RunReviewState; filter: RoundFilter; changeFilter: (value: RoundFilter) => void; playing: boolean; setPlaying: (value: boolean) => void; intervalSeconds: number; setIntervalSeconds: (value: number) => void; navigateRound: (delta: -1 | 1) => void; changeFocus: (patch: Partial<RunReviewState>) => void; toggleMarked: (key: string) => void; openEvidence: (key: string, modelId?: number, section?: EvidenceSection) => void; nameFor: (model: ReportModel) => string; dialogOpen: boolean;
}) {
  const modern = report.quality_schema_version === "result-quality-v2";
  const canPlay = Boolean(terminalRunStatuses[report.status]) && currentIndex >= 0 && currentIndex < rounds.length - 1 && !dialogOpen;
  return <section className="replay-board" tabIndex={0} aria-label="历史结果回放" onKeyDown={(event) => {
    if (dialogOpen || event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey || (event.target instanceof Element && event.target.closest("input,textarea,select,button,a,[contenteditable=true]"))) return;
    let handled = false;
    if (event.code === "ArrowLeft" && currentIndex > 0) { navigateRound(-1); handled = true; }
    if (event.code === "ArrowRight" && currentIndex >= 0 && currentIndex < rounds.length - 1) { navigateRound(1); handled = true; }
    if (event.code === "Space" && (playing || canPlay)) { setPlaying(!playing); handled = true; }
    if (event.code === "KeyM" && round) { toggleMarked(round.key); handled = true; }
    if (handled) event.preventDefault();
  }}>
    <header><h2>历史结果回放</h2><p>此处不是实时运行。按题查看已保存结果，包含全部计划尝试。</p></header>
    {!terminalRunStatuses[report.status] && <p className="notice">运行仍在更新，仅允许手动审阅，自动播放不可用。</p>}
    <div className="replay-controls"><label>回放筛选<select value={filter} onChange={(event) => changeFilter(event.target.value as RoundFilter)}><option value="all">全部</option><option value="business-difference">{modern ? "业务差异" : "历史结果合同差异"}</option><option value="business-failure">{modern ? "业务答错" : "历史结果合同未通过"}</option><option value="format-failure">格式问题</option><option value="capability-failure">能力约束</option><option value="unknown">证据未知</option><option value="marked">已标记</option></select></label>
      <label>播放间隔<select value={intervalSeconds} onChange={(event) => setIntervalSeconds(Number(event.target.value))}>{[5, 10, 20].map((seconds) => <option key={seconds} value={seconds}>{seconds} 秒</option>)}</select></label>
      <button aria-label="上一题" disabled={currentIndex <= 0} onClick={() => navigateRound(-1)}><ChevronLeft/></button><button aria-label={playing ? "暂停历史回放" : "播放历史回放"} disabled={!playing && !canPlay} onClick={() => setPlaying(!playing)}>{playing ? <Pause/> : <Play/>}{playing ? "暂停" : "播放"}</button><span>第 {currentIndex < 0 ? 0 : currentIndex + 1} / {rounds.length} 题</span><button aria-label="下一题" disabled={currentIndex < 0 || currentIndex >= rounds.length - 1} onClick={() => navigateRound(1)}><ChevronRight/></button>
    </div><p className="replay-shortcuts">聚焦此区域：← / → 切题，空格播放或暂停，M 标记。输入与按钮不受影响。</p>
    {round ? <><div className="replay-controls"><label>讲解题目<select value={round.key} onChange={(event) => changeFocus({ caseKey: event.target.value })}>{rounds.map((item) => <option key={item.key} value={item.key}>{item.title}</option>)}</select></label><label>证据主模型<select value={review.modelId ?? ""} onChange={(event) => changeFocus({ modelId: Number(event.target.value) })}>{report.models.map((model) => <option key={model.id} value={model.id}>{nameFor(model)}</option>)}</select></label><label>尝试<select value={review.attempt} onChange={(event) => changeFocus({ attempt: Number(event.target.value) })}>{Array.from({ length: Math.max(1, report.attempts) }, (_, index) => <option key={index + 1} value={index + 1}>第 {index + 1} 次</option>)}</select></label></div>
      <h3>{round.title}</h3><p>{round.question ?? "题意未记录"}</p><div className="replay-results">{round.models.map((row) => <article key={row.model.id}><b>{nameFor(row.model)}</b><p>{modern ? "业务结果" : "历史结果合同"} {row.resultCorrect === null ? "未知" : percent(row.resultCorrect)} · {row.attempts}/{report.attempts} 次已保存</p></article>)}</div><div className="replay-controls"><button className="button" onClick={() => openEvidence(round.key)}>查看当前题证据 · 第 {review.attempt} 次</button><button className="button ghost" aria-pressed={review.markedCaseKeys.includes(round.key)} onClick={() => toggleMarked(round.key)}>{review.markedCaseKeys.includes(round.key) ? "取消标记" : "标记讲解题"}</button></div></> : <p className="empty-inline">{filter === "marked" ? "尚未标记讲解题" : "当前筛选没有题目"}</p>}
  </section>;
}


function InspectLayer({ report, rounds, nameFor, showIdentity, openCase }: { report: ReportSnapshot; rounds: CaseRound[]; nameFor: (model: ReportModel) => string; showIdentity: boolean; openCase: (key: string, modelId?: number) => void }) {
  return <div className="report-layer-content">
    <section className="quality-board"><header><div><span className="section-kicker">{report.quality_schema_version === "result-quality-v2" ? "质量与失败分类" : "结果、执行与协议"}</span><h2>质量指标</h2></div><p>分母为全部计划尝试；未执行不等于业务结果错误。{report.quality_schema_version === "result-quality-v2" ? "新合同按结果值与排序判定业务正确，列名和 JSON 格式另报。" : "历史合同包含列名要求，原口径保留。"}</p></header>
      <div className="quality-models">{report.models.map(model => <article key={model.id}><h3>{nameFor(model)}</h3>{model.quality ? <>
        <div className="quality-rate"><span>结果正确</span><strong>{percent(model.quality.correct_rate)}</strong><small>{model.quality.result_correct}/{model.quality.total}</small></div>
        <div className="quality-rate"><span>执行成功</span><strong>{percent(model.quality.execution_rate)}</strong><small>{model.quality.execution_ok}/{model.quality.total}</small></div>
        <div className="quality-rate"><span>JSON 协议</span><strong>{percent(model.quality.protocol_rate)}</strong><small>{model.quality.protocol_ok}/{model.quality.total}</small></div>
        {model.quality.format_rate !== undefined && <div className="quality-rate"><span>输出格式</span><strong>{percent(model.quality.format_rate)}</strong><small>{model.quality.format_ok}/{model.quality.total}</small></div>}
        <p>结果证据覆盖 {model.quality.evaluated}/{model.quality.total}</p>
        {Object.entries(model.quality.failure_counts ?? {}).map(([kind, count]) => <p key={kind}>{failureLabels[kind] ?? kind}：{count}</p>)}
      </> : <p>质量证据不足</p>}</article>)}</div>
    </section>

    <section className="case-ledger"><header><div><h2>逐题结果</h2></div><p>{showIdentity ? "打开证据工作台可核对 SQL、执行结果与摘要。" : "匿名阶段隐藏 SQL 工作台和身份字段；揭晓后可查原始证据。"}</p></header><div className="case-table-wrap"><table><thead><tr><th>案例</th>{report.models.map((model) => <th key={model.id}>{nameFor(model)}</th>)}<th>证据</th></tr></thead><tbody>{rounds.map((round) => <tr key={round.key}><th><b>{round.title}</b><span>{round.question ?? "题意缺失"}</span><small>{round.category} · 权重 {round.weight}</small></th>{round.models.map((row) => <td key={row.model.id}><strong>{score(row.score)}</strong><span>结果 {row.resultCorrect == null ? "未知" : percent(row.resultCorrect)}</span><span>执行 {row.executionOk == null ? "未知" : percent(row.executionOk)}</span><span>协议 {row.protocolOk == null ? "未知" : percent(row.protocolOk)}</span><small>{row.reason ?? "无质量原因"}</small></td>)}<td>{showIdentity ? <button className="evidence-link" onClick={() => openCase(round.key)}><Search/>查看案例详情</button> : <span className="blind-lock">揭晓后可查</span>}</td></tr>)}</tbody></table></div>{!rounds.length && <p className="empty-inline">报告没有逐题记录。</p>}</section>

    <section className="case-processes"><header><div><span className="section-kicker">每题每模型</span><h2>执行过程与结果</h2></div><p>展开查看调用、协议、SQL 执行和比对状态；完整 Prompt、原始输出、结果行与金标在证据工作台。</p></header><div className="case-process-list">{rounds.map((round) => report.models.map((model) => <div key={round.key + "-" + model.id}>{Array.from({ length: report.attempts }, (_, index) => {
      const attempt = index + 1;
      const item = model.cases.find((entry) => entry.stable_key === round.key && entry.attempt === attempt);
      return item ? <CaseProcess key={attempt} item={item} model={model} modern={report.quality_schema_version === "result-quality-v2"} openEvidence={() => openCase(round.key, model.id)}/> : <article className="case-process-missing" key={attempt}><b>{round.title} · {nameFor(model)} · 第 {attempt} 次</b><span>暂无保存的作答，结果未知</span></article>;
    })}</div>))}</div></section>
    <details className="efficiency-fold"><summary><span><b>资源效率</b><small>新合同按实际正确题数归一；旧合同保留得分折算，不能混排</small></span><ChevronRight/></summary><div>{report.models.map(model => {
      const modern = model.efficiency?.metric_schema_version === "efficiency-v2";
      const adjusted = modern ? model.efficiency?.per_correct_case : model.efficiency?.per_correct_case_equivalent;
      const unit = modern ? "正确题" : "得分折算题";
      return <article key={model.id}><h3>{nameFor(model)}</h3>{adjusted ? <dl><div><dt>{unit}数</dt><dd>{score(modern ? model.efficiency?.correct_cases : model.efficiency?.correct_case_equivalents)}</dd></div><div><dt>Token / {unit}</dt><dd>{compact(adjusted.tokens)}</dd></div><div><dt>生成时长 / {unit}</dt><dd>{compact(adjusted.generation_ms)} ms</dd></div><div><dt>估算费用 / {unit}</dt><dd>{adjusted.estimated_cost_usd == null ? "不可估算" : String(adjusted.estimated_cost_usd) + " USD"}</dd></div><div><dt>Token 记录覆盖</dt><dd>{model.efficiency?.coverage.tokens.measured}/{model.efficiency?.coverage.tokens.total}</dd></div></dl> : <p>缺少效率证据</p>}</article>;
    })}</div></details>
  </div>;
}

function CaseProcess({ item, model, modern, openEvidence }: { item: CaseRun; model: ReportModel; modern: boolean; openEvidence: () => void }) {
  const quality = item.quality;
  const result = quality?.result_correct === true ? "结果匹配" : quality?.result_correct === false ? modern ? "结果不匹配" : "历史结果合同未通过" : "结果未知";
  const stage = (value: boolean | null | undefined, positive: string, negative: string) => value === true ? positive : value === false ? negative : "未确认";
  return <details className="case-process"><summary><b>{item.title}</b><span>{displayModelName(model.name)} · 第 {item.attempt} 次</span><strong>{result}</strong></summary><div className="case-process-body"><ol>
    <li><b>模型请求</b><span>{item.invocation?.status === "completed" ? "已完成" : item.invocation?.status === "request_recorded" ? "已记录请求，未确认完成" : item.invocation?.status === "failed" ? "请求失败" : model.adapter_kind === "pi" ? "调用证据未记录" : "历史调用证据未记录"}</span></li>
    <li><b>输出协议</b><span>{stage(quality?.protocol_ok, "通过", "未通过")}</span></li>
    <li><b>SQL 执行</b><span>{stage(quality?.execution_ok, "成功", "未成功")}{item.execution_ms != null && " · " + Math.round(item.execution_ms) + " ms"}</span></li>
    <li><b>结果比对</b><span>{result}{quality?.failure_kind && " · " + (failureLabels[quality.failure_kind] ?? quality.failure_kind)}</span></li>
  </ol>{item.formatted_sql && <pre aria-label="模型 SQL">{item.formatted_sql}</pre>}{item.error_message && <p className="case-process-error">{item.error_message}</p>}<button className="button ghost" onClick={openEvidence}>查看完整执行证据与结果行</button></div></details>;
}

const comparisonModeLabel: Record<string, string> = {
  single_model: "单模型运行",
  pure_model: "历史：相同接入控制的模型比较",
  access_path: "历史：接入路径比较",
  controlled_harness: "统一受控调用",
};

const effectiveControlKeys = ["provider", "auth_mode", "timeout_seconds", "temperature", "max_tokens", "reasoning_effort", "harness", "harness_version", "policy_version", "tools_enabled", "tool_count", "generation_attempts", "generation_attempt_limit", "context_isolated", "system_prompt_sha256", "model_identity_source", "effective_parameters"] as const;
const controlValue = (value: unknown) => {
  if (value == null) return "默认";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return Object.entries(value).filter(([key]) => ["provider", "auth_mode", "timeout_seconds", "temperature", "max_tokens", "reasoning_effort"].includes(key)).map(([key, nested]) => `${key}=${String(nested)}`).join(" · ") || "已冻结";
  return String(value);
};

function VerifyLayer({ report, nameFor, showIdentity, downloadJson, previewPublication, publication, exportArmed, setExportArmed, exportPublication, actionBusy }: { report: ReportSnapshot; nameFor: (model: ReportModel) => string; showIdentity: boolean; downloadJson: () => void; previewPublication: () => void; publication: PublicationPreview | null; exportArmed: boolean; setExportArmed: (value: boolean) => void; exportPublication: () => void; actionBusy: boolean }) {
  return <div className="report-layer-content">
    <section className="contract-board"><header><div><span className="section-kicker">冻结快照</span><h2>评分配置与版本</h2></div><ShieldCheck/></header><dl><div><dt>报告 schema</dt><dd>{report.report_schema_version ?? "旧版未声明"}</dd></div><div><dt>质量 schema</dt><dd>{report.quality_schema_version ?? "旧版未声明"}</dd></div><div><dt>Suite hash</dt><dd><code>{report.suite_content_hash}</code></dd></div><div><dt>案例集合</dt><dd>{report.selected_case_keys.length} 项</dd></div><div><dt>Attempts</dt><dd>{report.attempts}</dd></div><div><dt>评分器</dt><dd>{report.protocol.scorer_version}</dd></div><div><dt>输出合同</dt><dd>{report.protocol.output_contract}</dd></div></dl><div className="adapter-contracts">{report.models.map((model) => <article key={model.id}><b>{nameFor(model)}</b>{showIdentity && <code>{model.resolved_model_id ?? model.requested_model_id}</code>}<span>{showIdentity ? `${model.adapter_kind} · ${model.response_mode}` : "身份与适配器在匿名阶段隐藏"}</span></article>)}</div></section>
    <section className="contract-board"><header><div><span className="section-kicker">配置与预检快照</span><h2>{comparisonModeLabel[report.fairness.comparison_mode] ?? report.fairness.comparison_mode}</h2></div></header><p>{report.fairness.comparison_mode === "controlled_harness" ? "采用统一本地调用规则，不等于同端点、同预算或同模型。下方为配置/预检值，实际请求另列。" : "这是按原始历史快照保留的比较口径，不会改写为当前受控调用合同。"}</p>
      <div className="adapter-contracts">{report.models.map(model => <article key={model.id}><b>{nameFor(model)}</b><dl>
        {effectiveControlKeys.map(key => { const value = model.parameters[key] ?? model.isolation[key]; return value === undefined ? null : <div key={key}><dt>{key}</dt><dd>{controlValue(value)}</dd></div>; })}
        <div><dt>adapter</dt><dd>{model.adapter_kind}</dd></div><div><dt>response</dt><dd>{model.response_mode}</dd></div>
      </dl></article>)}</div>
      {report.fairness.differences.length > 0 && <p>已披露差异：{report.fairness.differences.join("；")}</p>}
    </section>
    {showIdentity && report.models.some(model => model.adapter_kind === "pi") && <section className="contract-board"><header><div><span className="section-kicker">逐题请求证据</span><h2>实际模型请求</h2></div></header><p>以下来自调用事件，而不是本地预检。记录的是请求载荷参数，不证明 Provider 内部计算预算或服务端模型版本。未完成的请求不能证明成功完成。</p><div className="adapter-contracts">{report.models.map(model => <article key={model.id}><b>{nameFor(model)}</b><p>已记录请求 {model.cases.filter(c => c.invocation).length}/{model.cases.length}；完成返回 {model.cases.filter(c => c.invocation?.status === "completed").length}/{model.cases.length}</p>{actualControlVariants(model).map((controls, index) => <details key={controls}><summary>实际控制组合 {index + 1}</summary><dl>{Object.entries(JSON.parse(controls) as Record<string, unknown>).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>)}</dl></details>)}</article>)}</div></section>}
    <RunComparison current={report} showIdentity={showIdentity}/>
    <section className="evidence-actions"><header><div><h2>导出报告与发布包</h2></div><p>JSON 是当前报告原文；发布包必须先生成预览摘要，再二次确认导出。导出不会自动上线。</p></header>{showIdentity ? <div className="evidence-action-row"><button className="button ghost" onClick={downloadJson}><Download/>下载报告 JSON</button><button className="button ghost" disabled={actionBusy} onClick={previewPublication}><FileCheck2/>生成发布预览</button></div> : <p className="blind-lock">匿名竞猜阶段禁用原始证据下载；退出盲测即可恢复。</p>}{publication && showIdentity && <article className="publication-preview"><div><b>{publication.eligible ? "预检通过" : "暂不可导出"}</b><span>状态 {publication.status} · 摘要 {publication.summary_digest}</span><pre>{JSON.stringify(publication.preview, null, 2)}</pre>{publication.warnings.length > 0 && <ul>{publication.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}</div><dl><div><dt>事件</dt><dd>{publication.manifest_summary.event_count}</dd></div><div><dt>案例运行</dt><dd>{publication.manifest_summary.case_run_count}</dd></div><div><dt>文件</dt><dd>{publication.manifest_summary.file_count}</dd></div></dl>{publication.eligible && (!exportArmed ? <button className="button primary" onClick={() => setExportArmed(true)}>准备导出证据包</button> : <div className="export-confirm"><span>确认摘要未变化？这只会下载文件，不会上线。</span><button className="button ghost" onClick={() => setExportArmed(false)}>取消</button><button className="button primary" disabled={actionBusy} onClick={exportPublication}>确认导出</button></div>)}</article>}</section>
  </div>;
}

function RunComparison({ current, showIdentity }: { current: ReportSnapshot; showIdentity: boolean }) {
  const history = useQuery({ queryKey: ["runs-for-comparison"], queryFn: api.runs, enabled: showIdentity });
  const candidates = history.data?.runs ?? [];
  const [leftRunId, setLeftRunId] = useState(current.source_run_id ?? current.id);
  const [rightRunId, setRightRunId] = useState(current.id);
  const [leftModelId, setLeftModelId] = useState<number | null>(null);
  const [rightModelId, setRightModelId] = useState<number | null>(null);

  const leftReport = useQuery({ queryKey: ["report", leftRunId], queryFn: () => api.report(leftRunId), enabled: showIdentity && leftRunId !== current.id });
  const rightReport = useQuery({ queryKey: ["report", rightRunId], queryFn: () => api.report(rightRunId), enabled: showIdentity && rightRunId !== current.id });
  const left = (leftRunId === current.id ? current : leftReport.data) as ReportSnapshot | undefined;
  const right = (rightRunId === current.id ? current : rightReport.data) as ReportSnapshot | undefined;
  const leftModel = left?.models.find((model) => model.id === leftModelId) ?? left?.models[0];
  const rightModel = right?.models.find((model) => model.id === rightModelId) ?? right?.models[0];
  const controls = left && right && leftModel && rightModel ? comparisonControls(left, right, leftModel, rightModel) : [];
  const repeat = Boolean(left && right && leftModel && rightModel && isRepeatPair(left, right, leftModel, rightModel));
  const observedRate = (run: ReportSnapshot | undefined, model: ReportModel | undefined) => {
    const quality = model?.quality;
    return run && quality && ["completed", "completed_with_errors"].includes(run.status) && quality.total === run.selected_case_keys.length * run.attempts && quality.evaluated === quality.total && Number.isFinite(quality.correct_rate) ? quality.correct_rate : null;
  };
  const leftRate = observedRate(left, leftModel);
  const rightRate = observedRate(right, rightModel);
  const comparable = controls.length > 0 && controls.every((control) => control.same);
  const changes = comparable && left && right && leftModel && rightModel ? compareResultCorrect(left, right, leftModel, rightModel) : [];
  if (!showIdentity) return <section className="comparison-board"><h2>跨运行比较</h2><p className="blind-lock">匿名阶段不加载运行历史，避免通过选择项或网络响应泄露身份。</p></section>;
  return <section className="comparison-board"><header><div><span className="section-kicker">跨运行比较</span><h2>跨运行结果对比</h2></div><p>仅在测试集、案例、attempts、评分器、合同与接入控制一致时对照结果。同请求模型的复测只记录波动，不自动合并排名。</p></header><div className="comparison-pickers"><label>左侧基准<select value={leftRunId} onChange={(event) => { setLeftRunId(Number(event.target.value)); setLeftModelId(null); }}>{candidates.map((item) => <option key={item.id} value={item.id}>运行 #{item.id}</option>)}{!candidates.some((item) => item.id === current.id) && <option value={current.id}>运行 #{current.id}</option>}</select></label><label>左侧模型<select value={leftModel?.id ?? ""} onChange={(event) => setLeftModelId(Number(event.target.value))}>{left?.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label><span>对照</span><label>右侧运行<select value={rightRunId} onChange={(event) => { setRightRunId(Number(event.target.value)); setRightModelId(null); }}>{candidates.map((item) => <option key={item.id} value={item.id}>运行 #{item.id}</option>)}{!candidates.some((item) => item.id === current.id) && <option value={current.id}>运行 #{current.id}</option>}</select></label><label>右侧模型<select value={rightModel?.id ?? ""} onChange={(event) => setRightModelId(Number(event.target.value))}>{right?.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label></div>{leftReport.isError || rightReport.isError ? <p className="comparison-error">对照报告读取失败，只保留选择项，不生成优劣结论。</p> : !left || !right ? <p className="empty-inline">正在读取对照报告…</p> : <><div className="control-checks">{controls.map((control) => <div className={control.same ? "same" : "different"} key={control.label}><span>{control.same ? <Check/> : <AlertTriangle/>}{control.label}</span><code>{control.left}</code><code>{control.right}</code></div>)}</div>{comparable && repeat && <p className="repeat-summary">同请求模型复测 · {leftRate != null && rightRate != null ? <>两次结果正确率 {percent(leftRate)} / {percent(rightRate)}，观察范围 {percent(Math.min(leftRate, rightRate))}–{percent(Math.max(leftRate, rightRate))}。</> : "结果证据不完整，不能汇总正确率。"} 两轮只描述波动，不证明稳定性或统计显著性；请求 ID 相同也不证明服务端模型版本相同。</p>}{left.id === right.id && leftModel?.id === rightModel?.id ? <p className="empty-inline">当前选中同一次运行的同一模型；请选择另一轮运行查看复测波动。</p> : comparable ? <div className="change-list">{changes.map((change) => <div className={`change ${change.state}`} key={change.key}><b>{change.title}</b><span>{change.left == null ? "未知" : percent(change.left)} → {change.right == null ? "未知" : percent(change.right)}</span><strong>{change.state}</strong></div>)}</div> : <div className="not-comparable"><AlertTriangle/><div><b>控制项不一致，只能并排查阅</b><p>{controls.filter((control) => !control.same).map((control) => control.label).join("、") || "缺少控制项"} 不一致；本页不会排列谁更好。</p></div></div>}</>}</section>;
}
