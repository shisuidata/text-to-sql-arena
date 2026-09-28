import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { PiOutputPanel } from "../components/PiOutputPanel";
import { buildRunTimeline } from "../lib/runTimeline";
import { defaultRunReview, type RunReviewState } from "../store";
import type { CaseRun, ModelRun, RunEvent, RunSnapshot } from "../types";

afterEach(cleanup);
const attempt = (id: number, title: string, overrides: Partial<CaseRun> = {}): CaseRun => ({
  id, case_id: id, stable_key: `case-${id}`, title, category: "filter", radar_dimension: "基础查询",
  attempt: 1, status: "running", visible_summary: null, formatted_sql: null, generation_ms: null,
  execution_ms: null, provider_request_id: null, token_usage: null, score: null, error_code: null, error_message: null,
  ...overrides,
});
const model = (id: number, name: string, cases: CaseRun[]): ModelRun => ({
  id, name, status: "running", official_score: null, requested_model_id: name, resolved_model_id: null,
  adapter_kind: "pi", response_mode: "text", parameters: {}, cli_version: null, isolation: {}, cases,
});
const run: RunSnapshot = {
  id: 1, source_run_id: null, suite_version_id: 1, suite_content_hash: "fixture", selected_case_keys: ["case-11", "case-12"],
  status: "running", attempts: 1, created_at: "2026-09-19T00:00:00Z", started_at: null, finished_at: null,
  protocol: { output_contract: "query-plan-v1", app_version: "test", scorer_version: "test", duckdb_version: "test", sqlglot_version: "test", case_count: 2, attempts: 1 },
  fairness: { comparison_mode: "controlled_harness", pure_model_comparison: false, controlled_fields: [], differences: [], model_variable: [], exact_rerun_default: true },
  models: [model(1, "Alpha", [attempt(11, "第一题"), attempt(12, "第二题")]), model(2, "Beta", [attempt(21, "第一题")])],
};
const event = (seq: number, modelId: number, caseId: number, type: string, payload: Record<string, unknown>, createdAt = "2026-09-19T00:00:00Z"): RunEvent => ({
  seq, model_run_id: modelId, case_run_id: caseId, event_type: type, payload,
  level: "info", message: "", created_at: createdAt,
});

function ControlledPanel({ events, connection = "live", initialFocus = defaultRunReview }: {
  events: RunEvent[]; connection?: "live" | "reconnecting" | "ended"; initialFocus?: RunReviewState;
}) {
  const [focus, setFocus] = useState<RunReviewState>(initialFocus);
  return <div>
    <button type="button" onClick={() => setFocus((value) => ({ ...value, mode: "locked", caseKey: "case-11", modelId: 1, attempt: 1 }))}>锁定题一</button>
    <button type="button" onClick={() => setFocus((value) => ({ ...value, mode: "locked", caseKey: "case-12", modelId: 1, attempt: 1 }))}>锁定题二</button>
    <button type="button" onClick={() => setFocus((value) => ({ ...value, mode: "follow", caseKey: null }))}>恢复跟随</button>
    <PiOutputPanel run={run} events={events} connection={connection} focus={focus}/>
  </div>;
}

it("交错片段按模型和题目拼接，锁定题目不被新题抢走，失败保留已收到的文本", () => {
  const initial = [
    event(1, 1, 11, "provider.requested", {}), event(2, 2, 21, "provider.requested", {}),
    event(3, 1, 11, "provider.delta", { text: "Alpha <script>" }),
    event(4, 2, 21, "provider.delta", { text: "Beta only" }),
  ];
  const { rerender, container } = render(<ControlledPanel events={initial}/>);
  const alpha = () => within(screen.getByRole("article", { name: "Alpha 输出" }));
  const beta = () => within(screen.getByRole("article", { name: "Beta 输出" }));
  expect(alpha().getByRole("region")).toHaveTextContent("Alpha <script>");
  expect(beta().getByRole("region")).toHaveTextContent("Beta only");
  expect(container.querySelector("script")).toBeNull();
  expect(beta().getByText(/case-21/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "锁定题一" }));
  const next = [...initial,
    event(5, 1, 11, "provider.delta", { text: " tail" }),
    event(6, 1, 11, "provider.completed", { elapsed_ms: 2500, token_usage: { input_tokens: 10, output_tokens: 20, cache_read_tokens: 4, cache_write_tokens: 2 } }),
    event(7, 1, 12, "provider.requested", {}), event(8, 1, 12, "provider.delta", { text: "Second answer" }),
  ];
  rerender(<ControlledPanel events={next} connection="reconnecting"/>);
  expect(alpha().getByRole("region")).toHaveTextContent("Alpha <script> tail");
  expect(alpha().getByRole("region")).not.toHaveTextContent("Second answer");
  expect(alpha().getByText("36 Token")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "恢复跟随" }));
  expect(alpha().getByRole("region")).toHaveTextContent("Second answer");
  const failed = [...next, { ...event(9, 1, 12, "case.failed", { error_code: "provider_output_truncated" }), message: "模型输出被截断" }];
  rerender(<ControlledPanel events={failed} connection="ended"/>);
  expect(alpha().getByRole("region")).toHaveTextContent("Second answer");
  expect(alpha().getByRole("alert")).toHaveTextContent("模型输出被截断");
  expect(beta().getByRole("region")).toHaveTextContent("Beta only");
});

it("未结束的 JSON 立即显示 SQL 换行，切换原始文本不丢失后续流式片段", () => {
  const prefix = '{"sql":"SELECT\\n  1 AS n';
  const suffix = ',\\n  2 AS m"}';
  const initial = [event(1, 1, 11, "provider.delta", { text: prefix })];
  const { rerender } = render(<ControlledPanel events={initial}/>);
  const alpha = () => within(screen.getByRole("article", { name: "Alpha 输出" }));
  expect(alpha().getByRole("region").textContent).toContain("SELECT\n  1 AS n");
  fireEvent.click(alpha().getByRole("button", { name: "原始文本" }));
  expect(alpha().getByRole("region").textContent).toBe(prefix);
  rerender(<ControlledPanel events={[...initial, event(2, 1, 11, "provider.delta", { text: suffix })]}/>);
  expect(alpha().getByRole("region").textContent).toBe(prefix + suffix);
  fireEvent.click(alpha().getByRole("button", { name: "阅读视图" }));
  expect(alpha().getByRole("region").textContent).toContain("SELECT\n  1 AS n,\n  2 AS m");
});

it("锁定的模型与题目严格匹配，缺失该次作答显示暂无而不是退回其他题目", () => {
  const betaRun: RunSnapshot = { ...run, models: [run.models[0], model(2, "Beta", [attempt(21, "第一题")])] };
  const lockedFocus: RunReviewState = { ...defaultRunReview, mode: "locked", caseKey: "case-12", modelId: 2, attempt: 2 };
  render(<PiOutputPanel run={betaRun} events={[]} connection="live" focus={lockedFocus}/>);
  const beta = within(screen.getByRole("article", { name: "Beta 输出" }));
  expect(beta.getByText("此题第 2 次暂无作答")).toBeVisible();
});

it("buildRunTimeline 合并 delta 为单一节点并保留模型返回后的失败", () => {
  const events = [
    event(1, 1, 11, "provider.requested", {}, "2026-09-19T00:00:01Z"),
    event(2, 1, 11, "provider.delta", { text: "a" }, "2026-09-19T00:00:02Z"),
    event(3, 1, 11, "provider.delta", { text: "b" }, "2026-09-19T00:00:03Z"),
    event(4, 1, 11, "provider.completed", { elapsed_ms: 2100 }, "2026-09-19T00:00:04Z"),
    event(5, 1, 11, "case.failed", { error_code: "provider_output_truncated" }),
  ];
  const attempts = buildRunTimeline(run, events);
  const item = attempts.find((entry) => entry.caseRunId === 11)!;
  expect(item.caseKey).toBe("case-11");
  const receive = item.nodes.find((node) => node.label === "接收输出")!;
  expect(receive.state).toBe("recorded");
  expect(receive.firstSeq).toBe(2);
  expect(receive.lastSeq).toBe(3);
  const returned = item.nodes.find((node) => node.label === "模型返回完成")!;
  expect(returned.elapsedMs).toBe(2100);
  expect(returned.elapsedSource).toBe("recorded");
  const score = item.nodes.find((node) => node.label === "执行与比对结束")!;
  expect(score.state).toBe("failed");
  const emptyAttempt = attempts.find((entry) => entry.caseRunId === 12)!;
  expect(emptyAttempt.nodes.find((node) => node.label === "准备请求")!.state).toBe("waiting");
});

it("buildRunTimeline 只用 score.completed 的 score 字段，事件间隔标注为事件间隔", () => {
  const events = [
    event(1, 1, 11, "case.started", {}, "2026-09-19T00:00:01Z"),
    event(2, 1, 11, "provider.requested", {}, "2026-09-19T00:00:02Z"),
    event(3, 1, 11, "provider.delta", { text: "x" }, "2026-09-19T00:00:03Z"),
    event(4, 1, 11, "provider.completed", { elapsed_ms: 2000 }, "2026-09-19T00:00:05Z"),
    event(5, 1, 11, "plan.completed", {}, "2026-09-19T00:00:06Z"),
    event(6, 1, 11, "score.completed", { score: 92, total: 999 }, "2026-09-19T00:00:10Z"),
  ];
  const item = buildRunTimeline(run, events).find((entry) => entry.caseRunId === 11)!;
  const sqlNode = item.nodes.find((node) => node.label === "SQL 已提交评估")!;
  expect(sqlNode.state).toBe("waiting");
  const scoreNode = item.nodes.find((node) => node.label === "执行与比对结束")!;
  expect(scoreNode.state).toBe("recorded");
  expect(scoreNode.elapsedMs).toBe(4000);
  expect(scoreNode.elapsedSource).toBe("event-gap");
  expect(JSON.stringify(item.nodes.map((node) => node.elapsedMs))).not.toContain("999");
});

it("buildRunTimeline 对历史终止运行且无逐题事件标记终态来自运行快照", () => {
  const finishedRun: RunSnapshot = { ...run, status: "completed", finished_at: "2026-09-19T01:00:00Z" };
  const attempts = buildRunTimeline(finishedRun, []);
  expect(attempts).toHaveLength(3);
  expect(attempts[0].nodes[0].label).toBe("终态来自运行快照");
  expect(attempts[0].nodes[0].state).toBe("unknown");
});
