import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type PropsWithChildren } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, eventStream } from "../api/client";
import * as workflows from "../api/workflows";
import { SqlWorkspace } from "../components/SqlWorkspace";
import { RunLivePage } from "../pages/RunLivePage";
import { RunNewPage } from "../pages/RunNewPage";
import { defaultRunReview, useArenaStore, type RunReviewState } from "../store";
import type { CaseRunDetail, ModelProfile, ModelRun, RunEvent, RunSnapshot, Suite } from "../types";

vi.mock("@monaco-editor/react", () => ({ Editor: ({ value }: { value: string }) => <pre data-testid="sql-editor">{value}</pre>, DiffEditor: ({ original, modified }: { original: string; modified: string }) => <><pre data-testid="diff-original">{original}</pre><pre data-testid="diff-modified">{modified}</pre></> }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const healthy = (id: number, name: string, adapterKind: ModelProfile["adapter_kind"] = "pi"): ModelProfile => ({ id, name, adapter_kind: adapterKind, model_id: name.toLowerCase(), base_url: null, response_mode: "text", parameters: adapterKind === "pi" ? { provider: "openai-codex", auth_mode: "oauth", timeout_seconds: 180 } : {}, pricing: null, enabled: true, has_secret: false, secret_backend: "none", health_status: "healthy", health_details: {}, last_checked_at: null, health_expires_at: null });
const suite: Suite = { id: 1, name: "retail", description: "", versions: [{ id: 10, version: 1, status: "published", dialect: "duckdb", content_hash: "abcdef1234567890", published_at: null, schema_sql: "", seed_sql: "", semantic: {}, prompt_template: "", structure: {}, cases: [{ id: 11, stable_key: "case-1", title: "题一", category: "filter", radar_dimension: "基础查询", difficulty: "easy", question: "q", required_ast: [], comparison: {}, weight: 1, sort_order: 1 }] }] };

function Wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
}

describe("新建评测门禁", () => {
  it("只有当前选择通过预检才能开赛，新增不健康模型后重新锁定", async () => {
    vi.spyOn(api, "profiles").mockResolvedValue([healthy(1, "Alpha"), healthy(2, "Beta")]);
    vi.spyOn(api, "suites").mockResolvedValue([suite]);
    vi.spyOn(api, "runs").mockResolvedValue({ runs: [] });
    vi.spyOn(workflows, "preflightRun").mockImplementation(async (payload) => ({
      ready: !payload.model_profile_ids.includes(2), total_calls: payload.model_profile_ids.length,
      selected_case_count: 1, models: [], estimate: { basis: "matching_completed_calls", sample_calls: 0, estimated_duration_seconds: null, estimated_cost_usd: null },
      issues: payload.model_profile_ids.includes(2) ? [{ code: "health_expired", severity: "error", message: "健康检查已过期", entity_type: "model", entity_id: 2 }] : [],
    }));
    render(<RunNewPage/>, { wrapper: Wrapper });
    const launch = await screen.findByRole("button", { name: "开始评测" });
    expect(launch).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    await waitFor(() => expect(launch).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
    await screen.findByText("健康检查已过期");
    expect(launch).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
    await waitFor(() => expect(launch).toBeEnabled());
  });
  it("历史适配器可见但不可选择，且新运行固定单次尝试", async () => {
    vi.spyOn(api, "profiles").mockResolvedValue([healthy(1, "Pi Alpha"), healthy(9, "Legacy Codex", "codex_cli")]);
    vi.spyOn(api, "suites").mockResolvedValue([suite]);
    vi.spyOn(api, "runs").mockResolvedValue({ runs: [] });
    vi.spyOn(workflows, "preflightRun").mockResolvedValue({ ready: true, total_calls: 1, selected_case_count: 1, models: [], estimate: { basis: "matching_completed_calls", sample_calls: 0, estimated_duration_seconds: null, estimated_cost_usd: null }, issues: [] });
    render(<RunNewPage/>, { wrapper: Wrapper });
    const legacy = await screen.findByRole("button", { name: /Legacy Codex/ });
    expect(legacy).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "1 次" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(screen.queryByRole("button", { name: "2 次" })).not.toBeInTheDocument();
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, EventListener>();
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: EventListener) { this.listeners.set(type, listener); }
  close() { this.closed = true; }
  emit(type: string, item: RunEvent) { this.listeners.get(type)?.({ data: JSON.stringify(item) } as unknown as Event); }
}

const event = (seq: number): RunEvent => ({ seq, event_type: "score.completed", level: "info", created_at: "2026-08-29T00:00:00Z", model_run_id: 1, case_run_id: 1, message: "scored", payload: {} });

describe("SSE 断线续传", () => {
  beforeEach(() => { vi.useFakeTimers(); FakeEventSource.instances = []; vi.stubGlobal("EventSource", FakeEventSource); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("以最后事件序号重连，忽略旧事件，并在最终事件后停止", () => {
    const received: number[] = [];
    const connections: boolean[] = [];
    const stop = eventStream(9, 3, (item) => received.push(item.seq), (connected) => connections.push(connected));
    const first = FakeEventSource.instances[0];
    first.onopen?.();
    first.emit("score.completed", event(7));
    first.emit("score.completed", event(7));
    first.emit("score.completed", event(6));
    first.onerror?.();
    vi.advanceTimersByTime(800);

    expect(received).toEqual([7]);
    expect(connections).toEqual([true, false]);
    expect(FakeEventSource.instances[1].url).toContain("after_seq=7");

    const second = FakeEventSource.instances[1];
    second.onopen?.();
    second.emit("run.completed", { ...event(8), event_type: "run.completed" });
    second.onerror?.();
    vi.advanceTimersByTime(8000);

    expect(received).toEqual([7, 8]);
    expect(connections).toEqual([true, false, true]);
    expect(second.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    stop();
  });

  it("停止时清理待执行的重连", () => {
    const stop = eventStream(9, 0, () => undefined, () => undefined);
    FakeEventSource.instances[0].onerror?.();
    stop();
    vi.advanceTimersByTime(8000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

it("演示模式仅持久化在当前 tab sessionStorage", () => {
  useArenaStore.getState().setDemoMode(true);
  expect(useArenaStore.getState().demoMode).toBe(true);
  expect(sessionStorage.getItem("arena-demo")).toBe("1");
  useArenaStore.getState().setDemoMode(false);
});

const detail = (reference = false, overrides: Partial<CaseRunDetail> = {}): CaseRunDetail => ({
  id: 101, run_id: 3, model_run_id: 1, stable_key: "case-1", title: "题一", question: "统计常量", category: "filter", radar_dimension: "基础查询", difficulty: "easy", status: "completed", attempt: 1, prompt: "actual prompt", raw_output: "raw json",
  plan: { grain: "单行", sources: ["items"], joins: [], filters: [], metrics: ["value"], steps: ["选择常量"], risks: [] }, assumptions: [], visible_summary: null, generated_sql: "SELECT 1", formatted_sql: "SELECT 1", generation_ms: 2, execution_ms: 1, provider_request_id: "fixture-101", token_usage: null, expected_digest: "gold", actual_digest: "actual",
  result_preview: { columns: [{ name: "id", type: "BIGINT" }, { name: "name", type: "VARCHAR" }], rows: [[2, "乙"], [3, "丙"], [2, "乙"]], row_count: 3, ...(reference ? { missing: [["1", "甲"]], extra: [["3", "丙"]], comparison_summary: { verdict: "different", expected_count: 3, actual_count: 3, matched_count: 2, missing_count: 1, extra_count: 1, order_mismatch: false } } : {}) },
  score: { total: 90, protocol: 5, ordering: 0, ast_rules: [] }, error_code: null, error_message: null, required_ast: [], comparison: {}, suite_content_hash: "hash",
  ...(reference ? { reference_sql: "select 999", formatted_reference_sql: "SELECT\n  999", expected_result_preview: { columns: [{ name: "id", type: "BIGINT" }, { name: "name", type: "VARCHAR" }], rows: [[1, "甲"], [2, "乙"], [2, "乙"]], row_count: 3, digest: "gold" } } : {}), ...overrides,
});
const model = (id: number, name: string, caseId: number): ModelRun => ({ id, name, status: "completed", official_score: 100, requested_model_id: name, resolved_model_id: name, adapter_kind: "codex_cli", response_mode: "text", parameters: {}, cli_version: "fixture", isolation: {}, cases: [{ id: caseId, case_id: 11, stable_key: "case-1", title: "题一", category: "filter", radar_dimension: "基础查询", attempt: 1, status: "completed", visible_summary: null, formatted_sql: "SELECT 1", generation_ms: 2, execution_ms: 1, provider_request_id: "fixture-case", token_usage: null, score: { total: 100 }, error_code: null, error_message: null }] });
const snapshot = (id: number): RunSnapshot => ({ id, source_run_id: null, suite_version_id: 10, suite_content_hash: "hash", selected_case_keys: ["case-1"], status: "running", attempts: 1, created_at: "2026-08-29T00:00:00Z", started_at: null, finished_at: null, protocol: { output_contract: "query-plan-v1", app_version: "0.2.0", scorer_version: "1.0.0", duckdb_version: "1.5.5", sqlglot_version: "30.17.0", case_count: 1, attempts: 1 }, fairness: { comparison_mode: "single_model", pure_model_comparison: false, controlled_fields: ["adapter_kind"], differences: [], model_variable: ["Alpha"], exact_rerun_default: true }, models: [model(1, "Alpha", 101)] });

function WorkspaceHarness({ run = snapshot(3), initial = {} }: { run?: RunSnapshot; initial?: Partial<RunReviewState> }) {
  const [focus, setFocus] = useState<RunReviewState>({ ...defaultRunReview, mode: "locked", caseKey: "case-1", modelId: 1, attempt: 1, ...initial });
  return <SqlWorkspace open onOpenChange={() => undefined} run={run} focus={focus} onFocusChange={(patch) => setFocus((value) => ({ ...value, ...patch }))}/>;
}

it("未揭晓只显示实际结果，揭晓后按金标列展示差异样本", async () => {
  vi.spyOn(api, "caseRun").mockImplementation(async (_id, reference) => detail(reference));
  render(<WorkspaceHarness/>, { wrapper: Wrapper });
  expect(await screen.findByText("Alpha 实际结果")).toBeInTheDocument();
  expect(screen.getAllByText("乙")).toHaveLength(2);
  expect(screen.queryByText("甲")).not.toBeInTheDocument();
  expect(api.caseRun).toHaveBeenCalledWith(101, false);
  fireEvent.click(screen.getByRole("button", { name: "揭晓参考结果后查看差异" }));
  expect(await screen.findByText("实际缺失的行")).toBeInTheDocument();
  expect(await screen.findByText("甲")).toBeInTheDocument();
  expect(screen.getByText("丙")).toBeInTheDocument();
  expect(screen.queryByText(/原结果第/)).not.toBeInTheDocument();
  expect(await screen.findByText("缺失 1（已保存样本 1），多余 1（已保存样本 1），匹配 2")).toBeInTheDocument();
  expect(api.caseRun).toHaveBeenCalledWith(101, true);
});

it("切换模型立即隐藏参考证据且严格读取所选作答", async () => {
  const run = { ...snapshot(3), models: [model(1, "Alpha", 101), model(2, "Beta", 102)] };
  vi.spyOn(api, "caseRun").mockImplementation(async (id, reference) => detail(reference, { id, model_run_id: id === 102 ? 2 : 1 }));
  render(<WorkspaceHarness run={run}/>, { wrapper: Wrapper });
  await screen.findByText("Alpha 实际结果");
  fireEvent.click(screen.getByRole("button", { name: "揭晓参考结果后查看差异" }));
  expect(await screen.findByText("甲")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("模型作答"), { target: { value: "2" } });
  expect(await screen.findByText("Beta 实际结果")).toBeInTheDocument();
  expect(screen.queryByText("甲")).not.toBeInTheDocument();
  expect(api.caseRun).toHaveBeenCalledWith(102, false);
});

it("历史差异不猜测总数或独立排序证据", async () => {
  vi.spyOn(api, "caseRun").mockImplementation(async (_id, reference) => detail(reference, reference ? { result_preview: { columns: [{ name: "id", type: "BIGINT" }], rows: [[2]], missing: [["1"]], extra: [] }, expected_result_preview: { columns: [{ name: "id", type: "BIGINT" }], rows: [[1]] } } : {}));
  render(<WorkspaceHarness/>, { wrapper: Wrapper });
  await screen.findByText("Alpha 实际结果");
  fireEvent.click(screen.getByRole("button", { name: "揭晓参考结果后查看差异" }));
  expect(await screen.findByText("已保存差异样本：缺失 1、多余 0；总数未记录")).toBeInTheDocument();
  expect(screen.getByText("未通过排序/结果一致性评分，未记录独立排序证据")).toBeInTheDocument();
});

it("运行中的取消按钮调用后端且刷新状态", async () => {
  vi.spyOn(api, "run").mockResolvedValue(snapshot(3));
  vi.spyOn(api, "history").mockResolvedValue({ events: [], total: 0 });
  const cancel = vi.spyOn(api, "cancelRun").mockResolvedValue({ status: "cancelling" });
  vi.stubGlobal("EventSource", FakeEventSource);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={["/runs/3/live"]}><Routes><Route path="/runs/:id/live" element={<RunLivePage/>}/></Routes></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "取消运行" }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith(3));
  vi.unstubAllGlobals();
});

it("状态轮询失败和缺失 payload 不会遮住已经收到的输出", async () => {
  vi.spyOn(api, "run").mockResolvedValueOnce(snapshot(4)).mockRejectedValue(new Error("network unavailable"));
  vi.spyOn(api, "history").mockResolvedValue({ events: [
    { ...event(1), payload: undefined } as unknown as RunEvent,
    { ...event(2), case_run_id: 101, event_type: "provider.delta", payload: { text: "preserved live output" } },
  ], total: 2 });
  vi.stubGlobal("EventSource", FakeEventSource);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/runs/4/live"]}><Routes><Route path="/runs/:id/live" element={<RunLivePage/>}/></Routes></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText("preserved live output")).toBeVisible();
  await act(async () => { await client.refetchQueries({ queryKey: ["run", 4] }); });
  expect(await screen.findByRole("button", { name: "重试状态更新" })).toBeVisible();
  expect(screen.getByText("preserved live output")).toBeVisible();
  vi.unstubAllGlobals();
});
