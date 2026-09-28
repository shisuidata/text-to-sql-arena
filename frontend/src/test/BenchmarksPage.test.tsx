import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { api } from "../api/client";
import { BenchmarksPage } from "../pages/BenchmarksPage";
import type { SuiteVersion } from "../types";

vi.mock("../api/client", () => ({ api: { suites: vi.fn() } }));

const version = (overrides: Partial<SuiteVersion>): SuiteVersion => ({
  id: 1,
  version: 1,
  status: "published",
  dialect: "duckdb",
  content_hash: "published-hash-v1",
  published_at: "2026-09-01T00:00:00Z",
  schema_sql: "CREATE TABLE orders (id INTEGER);",
  seed_sql: "",
  semantic: {},
  prompt_template: "{{question}}",
  structure: { tables: [{ name: "orders" }] },
  cases: [{
    id: 11,
    stable_key: "orders",
    title: "订单筛选",
    category: "filter",
    radar_dimension: "基础查询",
    difficulty: "easy",
    question: "查询已完成的订单",
    required_ast: [],
    comparison: {},
    weight: 1,
    sort_order: 1,
  }],
  ...overrides,
});

it("shows only published versions as a read-only question catalog", async () => {
  vi.mocked(api.suites).mockResolvedValue([{
    id: 1,
    name: "retail-analytics-v1",
    description: "固定零售数据上的 SQL 能力评测。",
    versions: [
      version({}),
      version({ id: 2, version: 2, content_hash: "published-hash-v2", structure: { tables: [{ name: "orders" }, { name: "customers" }] } }),
      version({ id: 3, version: 3, status: "draft", content_hash: null, cases: [{ ...version({}).cases[0], title: "未发布题目" }] }),
    ],
  }]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><BenchmarksPage/></MemoryRouter></QueryClientProvider>);

  expect(await screen.findByRole("heading", { name: "零售分析 SQL 测试集" })).toBeVisible();
  expect(screen.getByText("最新版本").nextSibling).toHaveTextContent("v2");
  expect(screen.getByText("2 张表")).toBeVisible();
  expect(screen.getByText("published-hash-v2")).toBeVisible();
  expect(screen.getAllByText("查询已完成的订单")).toHaveLength(2);
  expect(screen.queryByText("未发布题目")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /保存|发布|复制|校验|自检/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /编辑/ })).not.toBeInTheDocument();
});
