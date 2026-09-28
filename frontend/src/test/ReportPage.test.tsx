import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { ReportPage } from "../pages/ReportPage";
import type { RunSnapshot } from "../types";
import { buildCaseRounds, buildComparisonEvidence, buildReportVerdict, buildRoundSignals, selectKeyRounds, filterRounds, adjacentRoundKey, compareResultCorrect, comparisonControls, summarizeModelEvidence, type ReportSnapshot } from "../lib/reportAnalysis";
import { defaultRunReview, useArenaStore } from "../store";
import { resolveReview, selectModelAttempt, latestModelCaseIds } from "../lib/runReview";

vi.mock("../api/client", () => ({ api: { report: vi.fn(), runs: vi.fn() } }));
vi.mock("../api/workflows", () => ({ getPublicationPreview: vi.fn(), exportPublicationPackage: vi.fn(), rerunRun: vi.fn() }));
vi.mock("../components/SqlWorkspace", () => ({ SqlWorkspace: ({ open }: { open: boolean }) => open ? <div>SQL evidence workspace</div> : null }));

function model(id: number, name: string, caseOneCorrect: boolean, caseTwoCorrect: boolean) {
  return {
    id,
    name,
    status: "completed",
    official_score: caseOneCorrect && caseTwoCorrect ? 92 : 61,
    requested_model_id: `${name}-secret-id`,
    resolved_model_id: `${name}-resolved-secret-id`,
    adapter_kind: "codex_cli",
    response_mode: "json",
    parameters: { temperature: 0 },
    cli_version: "1",
    isolation: { network: false },
    endpoint_fingerprint: null,
    quality: { total: 2, evaluated: 2, result_correct: Number(caseOneCorrect) + Number(caseTwoCorrect), execution_ok: 2, protocol_ok: 2, correct_rate: (Number(caseOneCorrect) + Number(caseTwoCorrect)) / 2, execution_rate: 1, protocol_rate: 1 },
    cases: [
      { id: id * 10 + 1, case_id: 1, stable_key: "orders", title: "订单汇总", question: "统计每个地区订单", weight: 1, category: "聚合", radar_dimension: "aggregation", attempt: 1, status: "completed", visible_summary: null, formatted_sql: "select secret from orders", generation_ms: 12, execution_ms: 2, provider_request_id: null, token_usage: null, score: { total: caseOneCorrect ? 90 : 30, rows: caseOneCorrect ? 20 : 0 }, quality: { result_correct: caseOneCorrect, execution_ok: true, protocol_ok: true, reason: caseOneCorrect ? "digest_match" : "row_mismatch" }, error_code: null, error_message: null },
      { id: id * 10 + 2, case_id: 2, stable_key: "customers", title: "客户筛选", question: "筛选活跃客户", weight: 2, category: "筛选", radar_dimension: "filter", attempt: 1, status: "completed", visible_summary: null, formatted_sql: "select private from customers", generation_ms: 14, execution_ms: 2, provider_request_id: null, token_usage: null, score: { total: caseTwoCorrect ? 94 : 40 }, quality: { result_correct: caseTwoCorrect, execution_ok: true, protocol_ok: true, reason: caseTwoCorrect ? "digest_match" : "row_mismatch" }, error_code: null, error_message: null },
    ],
  };
}

function report(id = 7): ReportSnapshot {
  return {
    id,
    report_schema_version: "run-report-v3",
    quality_schema_version: "result-quality-v1",
    source_run_id: null,
    suite_version_id: 3,
    suite_content_hash: "suite-abc",
    selected_case_keys: ["orders", "customers"],
    status: "completed",
    attempts: 1,
    created_at: "2026-09-17T00:00:00Z",
    started_at: "2026-09-17T00:00:01Z",
    finished_at: "2026-09-17T00:00:10Z",
    protocol: { output_contract: "json-v1", app_version: "3", scorer_version: "3", duckdb_version: "1", sqlglot_version: "2", case_count: 2, attempts: 1 },
    fairness: { comparison_mode: "pure_model", pure_model_comparison: true, controlled_fields: [], differences: [], model_variable: [], exact_rerun_default: true },
    models: [model(1, "Alpha Real", true, false), model(2, "Beta Real", false, true)],
  } as RunSnapshot as ReportSnapshot;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/runs/7/report"]}><Routes><Route path="/runs/:id/report" element={<ReportPage/>}/></Routes></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  useArenaStore.setState({ reviewByRun: {} });
  vi.mocked(api.report).mockResolvedValue(report());
  vi.mocked(api.runs).mockResolvedValue({ runs: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("report analysis", () => {
  it("uses every planned attempt and normalizes contributions onto the total score", () => {
    const data = report();
    data.attempts = 2;
    for (const entry of data.models) entry.cases.push(...entry.cases.map((item) => ({ ...item, id: item.id + 100, attempt: 2 })));
    data.models[0].cases[2] = { ...data.models[0].cases[2], score: { total: 50 }, quality: { result_correct: false, execution_ok: true, protocol_ok: true, reason: "row_mismatch" } };
    const order = buildCaseRounds(data).find((round) => round.key === "orders");
    expect(order?.models[0].score).toBe(70);
    expect(order?.models[0].resultCorrect).toBe(0.5);
    expect(order?.spread).toBeCloseTo(40 / 3);
    data.models[0].cases[2] = { ...data.models[0].cases[2], status: "failed", score: null, quality: undefined };
    const failed = buildCaseRounds(data).find((round) => round.key === "orders");
    expect(failed?.models[0].score).toBe(45);
    expect(failed?.models[0].resultCorrect).toBeNull();
  });

  it("refuses ranked change labels when a control differs", () => {
    const left = report(7);
    const right = report(8);
    right.protocol.output_contract = "text-v2";
    const controls = comparisonControls(left, right, left.models[0], right.models[0]);
    expect(controls.find((control) => control.label === "输出合同")?.same).toBe(false);
    expect(compareResultCorrect(left, right, left.models[0], right.models[0]).map((change) => change.state)).toEqual(["无法判断", "无法判断"]);
  });
  it("requires completed actual calls and refuses matching configurations with different wire budgets", () => {
    const left = report(7);
    const right = report(8);
    left.models[0].adapter_kind = right.models[0].adapter_kind = "pi";
    const states = () => compareResultCorrect(left, right, left.models[0], right.models[0]).map(change => change.state);
    expect(states()).toEqual(["无法判断", "无法判断"]);
    for (const data of [left, right]) for (const item of data.models[0].cases) item.invocation = { status: "completed", harness: "pi-ai", effective_parameters: { wire_generation: { max_tokens: 8192 } } };
    expect(states()).toEqual(["持平", "持平"]);
    right.models[0].cases[0].invocation = { status: "completed", harness: "pi-ai", effective_parameters: { wire_generation: { max_tokens: 16384 } } };
    expect(states()).toEqual(["无法判断", "无法判断"]);
  });

  it("describes a comparable same-request rerun as fluctuation, not model improvement", () => {
    const left = report(7);
    const right = report(8);
    left.quality_schema_version = right.quality_schema_version = "result-quality-v2";
    right.models[0].cases[1].quality!.result_correct = true;
    expect(compareResultCorrect(left, right, left.models[0], right.models[0]).map((change) => change.state)).toEqual(["复测上浮", "复测持平"]);
    expect(compareResultCorrect(left, right, left.models[0], right.models[1]).map((change) => change.state)).toEqual(["右侧更高", "右侧更低"]);
    right.models[0].resolved_model_id = "different-version";
    expect(compareResultCorrect(left, right, left.models[0], right.models[0]).map((change) => change.state)).toEqual(["右侧更高", "持平"]);
    right.protocol.output_contract = "different-contract";
    expect(compareResultCorrect(left, right, left.models[0], right.models[0]).map((change) => change.state)).toEqual(["无法判断", "无法判断"]);
  });

  it("declares v2 ties on quality rates rather than auxiliary score gaps", () => {
    const tied = report();
    tied.quality_schema_version = "result-quality-v2";
    tied.models.forEach((item) => { item.quality!.result_correct = 1; item.quality!.correct_rate = 0.5; });
    tied.models[0].official_score = 98.98; tied.models[1].official_score = 97.32;
    const verdict = buildReportVerdict(tied, (item) => item.name);
    expect(verdict.kind).toBe("tie");
    expect(verdict.text).toContain("本次运行中");
    expect(verdict.text).toContain("Alpha Real 正确 1/2 次计划尝试");
    expect(verdict.text).not.toContain("优秀");
    tied.models[1].quality!.evaluated = 1;
    expect(buildReportVerdict(tied, (item) => item.name).kind).toBe("unknown");
    expect(buildReportVerdict({ ...tied, status: "running" }, (item) => item.name).kind).toBe("provisional");
    expect(buildReportVerdict({ ...tied, quality_schema_version: "result-quality-v1" }, (item) => item.name).kind).toBe("legacy");
  });

  it("distinguishes shared misses from case-level differences and unknown evidence", () => {
    const data = report();
    data.models[1].cases[1].quality!.result_correct = false;
    expect(buildComparisonEvidence(buildCaseRounds(data))).toEqual({ differentiating: ["订单汇总"], sharedMisses: ["客户筛选"], unknown: [] });
    data.models[1].cases[0].quality!.result_correct = null;
    expect(buildComparisonEvidence(buildCaseRounds(data))).toEqual({ differentiating: [], sharedMisses: ["客户筛选"], unknown: ["订单汇总"] });
  });

  it("keeps provider failures unknown instead of business failures and prioritizes actual result differences", () => {
    const data = report();
    data.models[0].cases[0].quality!.failure_kind = "provider_error";
    data.models[0].cases[0].quality!.result_correct = null as never;
    data.models[1].cases[0].quality!.result_correct = null as never;
    data.models[0].cases[1].score = { total: 10, ast_rules: [{ id: "uses_window", kind: "ast", passed: false, details: {} }] };
    const rounds = buildCaseRounds(data);
    const signals = buildRoundSignals(data, rounds);
    expect(signals.get("orders")!.unknown).toBe(true);
    expect(signals.get("orders")!.businessFailure).toBe(false);
    expect(signals.get("orders")!.failureKinds).toEqual(["provider_error"]);
    expect(signals.get("customers")!.capabilityFailure).toBe(true);
    expect(signals.get("customers")!.businessFailure).toBe(true);
    expect(selectKeyRounds(rounds, signals).map((round) => round.key)).toEqual(["customers", "orders"]);
    expect(filterRounds(rounds, signals, "unknown", []).map((round) => round.key)).toEqual(["orders"]);
    expect(filterRounds(rounds, signals, "marked", ["customers"]).map((round) => round.key)).toEqual(["customers"]);
    expect(adjacentRoundKey(rounds, "orders", -1)).toBe("orders");
    expect(adjacentRoundKey(rounds, "stale", 1)).toBe("orders");
  });

  it("attributes only executed result mismatches to observed weak areas", () => {
    const data = report();
    data.quality_schema_version = "result-quality-v2";
    const subject = data.models[0];
    subject.cases[0].quality = { result_correct: false, execution_ok: true, protocol_ok: true, reason: "result differs from the reference contract", failure_kind: "result_mismatch" };
    subject.cases[0].score = { total: 70, ast_rules: [{ id: "join", kind: "join_type", passed: false, details: {} }] };
    subject.cases[1].quality = { result_correct: null, execution_ok: false, protocol_ok: true, reason: "query did not execute successfully", failure_kind: "policy_rejected" };
    const finding = summarizeModelEvidence(data, subject);
    expect(finding).toMatchObject({ planned: 2, judged: 1, correct: 0, mismatched: 1, unjudged: 1, weakAreas: [{ area: "aggregation", titles: ["订单汇总"] }], constraintCases: ["订单汇总"], failureKinds: { policy_rejected: 1 } });
    expect(finding.weakAreas.some((item) => item.titles.includes("客户筛选"))).toBe(false);
  });

  it("resolves stale review selections and never falls back to a different attempt", () => {
    const data = report();
    const review = resolveReview(data, { ...defaultRunReview, mode: "locked", caseKey: "stale", modelId: 999, attempt: 99, markedCaseKeys: ["orders", "orders", "stale"] });
    expect(review).toMatchObject({ caseKey: "orders", modelId: 1, attempt: 1, markedCaseKeys: ["orders"] });
    expect(selectModelAttempt(data.models[0], { ...review, attempt: 2 })).toBeNull();
    const late = latestModelCaseIds([
      { seq: 1, event_type: "case.started", level: "info", created_at: "2026-01-01", model_run_id: 1, case_run_id: 12, message: "", payload: {} },
      { seq: 9, event_type: "score.completed", level: "info", created_at: "2026-01-01", model_run_id: 1, case_run_id: 11, message: "", payload: {} },
    ]);
    expect(late.get(1)).toBe(12);
  });

});

describe("ReportPage", () => {
  it("keeps historical reruns disabled and hides identities and scores until reveal", async () => {
    vi.mocked(api.report).mockResolvedValue({ ...report(), status: "completed_with_errors" });
    renderPage();
    expect((await screen.findByRole("heading", { name: /历史评分口径/ })).textContent).toContain("历史评分口径");
    expect(screen.getByRole("button", { name: "复测" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "匿名预测" }));
    expect(document.body.textContent).not.toContain("61.00");
    expect(screen.getByRole("button", { name: /逐题分析/ })).toBeDisabled();
    expect(screen.queryByText("Alpha Real")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("secret-id");
    expect(document.body.textContent).not.toContain("select secret");
    const prediction = screen.getAllByRole("button", { name: /选择此模型/ })[0];
    fireEvent.click(prediction);
    expect(prediction).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "显示模型与结果" }));
    expect(screen.getAllByText("Alpha Real").length).toBeGreaterThan(0);
  });

  it("shows each saved case process and keeps policy rejection out of business analysis", async () => {
    const data = report();
    data.quality_schema_version = "result-quality-v2";
    data.models[0].cases[0].quality = { result_correct: false, execution_ok: true, protocol_ok: true, reason: "result differs from the reference contract", failure_kind: "result_mismatch" };
    data.models[0].cases[1].quality = { result_correct: null, execution_ok: false, protocol_ok: true, reason: "query did not execute successfully", failure_kind: "policy_rejected" };
    vi.mocked(api.report).mockResolvedValue(data);
    renderPage();
    expect(await screen.findByRole("heading", { name: "结果与能力分析" })).toBeVisible();
    expect(screen.getAllByText(/aggregation（订单汇总）的金标未匹配/)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /逐题分析/ }));
    const section = screen.getByRole("heading", { name: "执行过程与结果" }).closest("section")!;
    const cards = within(section).getAllByText("Alpha Real · 第 1 次");
    expect(cards).toHaveLength(2);
    const card = cards[0].closest("details")!;
    fireEvent.click(within(card).getByText("订单汇总"));
    expect(within(card).getByText("结果比对")).toBeVisible();
    expect(within(card).getByText("SQL 执行")).toBeVisible();
    fireEvent.click(within(card).getByRole("button", { name: "查看完整执行证据与结果行" }));
    expect(screen.getByText("SQL evidence workspace")).toBeVisible();
  });
  it("shows shared misses separately from distinguishing questions", async () => {
    const data = report();
    data.quality_schema_version = "result-quality-v2";
    data.models[1].cases[1].quality!.result_correct = false;
    vi.mocked(api.report).mockResolvedValue(data);
    renderPage();
    const evidence = await screen.findByRole("region", { name: "题目区分证据" });
    expect(within(evidence).getByText("结果有差异 · 1 题")).toBeVisible();
    expect(within(evidence).getByText("共同未全对 · 1 题")).toBeVisible();
    expect(within(evidence).getByText("客户筛选；优先核对题意与口径。")).toBeVisible();
  });

  it("shows an explicit unknown record for an unsaved planned attempt", async () => {
    const data = report();
    data.attempts = 2;
    vi.mocked(api.report).mockResolvedValue(data);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /逐题分析/ }));
    const section = screen.getByRole("heading", { name: "执行过程与结果" }).closest("section")!;
    expect(within(section).getAllByText("暂无保存的作答，结果未知")).toHaveLength(4);
    expect(within(section).getAllByText(/第 2 次/)).toHaveLength(4);
  });


  it("shows quality boundaries and opens real evidence only after navigating to inspection", async () => {
    renderPage();
    await screen.findByRole("button", { name: /结果概览/ });
    fireEvent.click(screen.getByRole("button", { name: /逐题分析/ }));
    expect(screen.getAllByText("50.0%")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "查看案例详情" })[0]);
    await waitFor(() => expect(screen.getByText("SQL evidence workspace")).toBeInTheDocument());
  });
  it("hides secret controls in configuration and invocation evidence", async () => {
    const controlled = report();
    controlled.fairness = { ...controlled.fairness, comparison_mode: "controlled_harness", pure_model_comparison: false, differences: ["provider"] };
    controlled.models = controlled.models.map(item => ({ ...item, adapter_kind: "pi", response_mode: "text", parameters: { provider: item.id === 1 ? "openai-codex" : "anthropic", auth_mode: "oauth", timeout_seconds: 180, api_key_ref: "must-not-render" }, isolation: { harness: "pi", secret_ref: "also-hidden" }, cases: item.cases.map(c => ({ ...c, invocation: { status: "completed", harness: "pi-ai", effective_parameters: { wire_generation: { max_tokens: 16384, api_key: "nested-wire-secret" } } } })) }));
    vi.mocked(api.report).mockResolvedValue(controlled);
    const view = renderPage();
    const page = within(view.container);
    await page.findByRole("button", { name: /配置与证据/ });
    fireEvent.click(page.getByRole("button", { name: /配置与证据/ }));
    expect(document.body.textContent).not.toContain("must-not-render");
  });
  it("shows a two-run range without treating a rerun as a new ranking", async () => {
    const left = report(6);
    const right = report(7);
    left.quality_schema_version = right.quality_schema_version = "result-quality-v2";
    right.source_run_id = 6;
    right.models[0] = model(1, "Alpha Real", true, true);
    vi.mocked(api.report).mockImplementation(async (id) => id === 6 ? left : right);
    vi.mocked(api.runs).mockResolvedValue({ runs: [{ id: 6 }, { id: 7 }] } as Awaited<ReturnType<typeof api.runs>>);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /配置与证据/ }));
    expect(await screen.findByText(new RegExp("两次结果正确率 50.0% / 100.0%，观察范围 50.0%–100.0%"))).toBeVisible();
    expect(screen.getByText("复测上浮")).toBeVisible();
    expect(screen.getByText(/两轮只描述波动，不证明稳定性或统计显著性/)).toBeVisible();
  });

  it("filters replay by marked questions and keyboard actions never leave the bounded set", async () => {
    renderPage();
    await screen.findByRole("button", { name: /结果概览/ });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "标记讲解题：订单汇总" }));
    fireEvent.change(screen.getByLabelText("回放筛选"), { target: { value: "marked" } });
    expect(screen.getByText("第 1 / 1 题")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "取消标记：订单汇总" }));
    expect(screen.getByText("尚未标记讲解题")).toBeVisible();
    expect(screen.getByRole("button", { name: "上一题" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("回放筛选"), { target: { value: "all" } });
    const board = screen.getByRole("region", { name: "历史结果回放" });
    fireEvent.keyDown(board, { code: "ArrowRight" });
    expect(screen.getByText("第 2 / 2 题")).toBeVisible();
    fireEvent.keyDown(board, { code: "ArrowRight" });
    expect(screen.getByText("第 2 / 2 题")).toBeVisible();
    fireEvent.keyDown(board, { code: "Space" });
    expect(screen.getByRole("button", { name: "播放历史回放" })).toBeDisabled();
    fireEvent.keyDown(board, { code: "ArrowLeft" });
    fireEvent.keyDown(board, { code: "Space" });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByText("第 2 / 2 题")).toBeVisible();
    expect(screen.getByRole("button", { name: "播放历史回放" })).toBeDisabled();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.getByText("第 2 / 2 题")).toBeVisible();
    fireEvent.keyDown(screen.getByLabelText("回放筛选"), { code: "Space" });
    expect(screen.getByRole("button", { name: "播放历史回放" })).toBeDisabled();
  });

    expect(document.body.textContent).not.toContain("also-hidden");
    expect(document.body.textContent).not.toContain("nested-wire-secret");
  });
