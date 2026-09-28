import { describe, expect, it } from "vitest";
import { presentModelOutput } from "../lib/modelOutput";

const completeOutput = {
  plan: {
    grain: "每行一个订单",
    sources: ["orders", "customers"],
    joins: ["orders.customer_id = customers.id"],
    filters: ["status = 'paid'"],
    metrics: ["SUM(total)"],
    steps: ["先筛选", "再聚合"],
    risks: ["退款可能延迟"],
  },
  sql: "SELECT customer_id,\n       SUM(total) AS revenue\nFROM orders\nGROUP BY customer_id",
  summary: "按客户汇总收入。",
  assumptions: ["total 已扣除折扣"],
};

describe("presentModelOutput", () => {
  it("完整 query-plan-v1 按固定章节呈现并保留 SQL 缩进", () => {
    const result = presentModelOutput(JSON.stringify(completeOutput));
    expect(result.structured).toBe(true);
    expect(result.text).toContain(completeOutput.sql);
    for (const value of Object.values(completeOutput.plan).flat()) expect(result.text).toContain(value);
    expect(result.text).toContain(completeOutput.summary);
    expect(result.text).toContain(completeOutput.assumptions[0]);
  });

  it("JSON 转义只解码一次，区分换行与 SQL 中的反斜杠 n", () => {
    const raw = JSON.stringify({
      ...completeOutput,
      sql: "SELECT 'C:\\temp\\n' AS path;\n\tFROM files",
    });

    const result = presentModelOutput(raw);
    expect(result.structured).toBe(true);
    expect(result.text).toContain("SQL\nSELECT 'C:\\temp\\n' AS path;\n\tFROM files");
    expect(result.text).not.toContain("C:\\temp\n' AS path");
  });

  it("流式未闭合对象逐字段显示，字符串末尾的半个转义等待后续片段", () => {
    const beforeEscape = '{"plan":{"grain":"订单","sources":["orders"]},"sql":"SELECT 1\\nWHERE name = \'A' + "\\";
    expect(presentModelOutput(beforeEscape)).toEqual({
      structured: true,
      text: "查询规划\n粒度：订单\n数据源\n- orders\n\nSQL\nSELECT 1\nWHERE name = 'A",
    });

    const afterEscape = `${beforeEscape}n`;
    expect(presentModelOutput(afterEscape)).toEqual({
      structured: true,
      text: "查询规划\n粒度：订单\n数据源\n- orders\n\nSQL\nSELECT 1\nWHERE name = 'A\n",
    });
  });

  it("流式 Unicode 转义不提前显示残缺字符，四位齐全后再呈现", () => {
    const prefix = '{"sql":"国家：\\u56';
    expect(presentModelOutput(prefix)).toEqual({ structured: true, text: "SQL\n国家：" });
    expect(presentModelOutput(`${prefix}fd`)).toEqual({ structured: true, text: "SQL\n国家：国" });
  });
  it("代理对 Unicode 转义跨片到达时等待完整码点", () => {
    const prefix = '{"sql":"rare: \\uD840\\uDC';
    expect(presentModelOutput(prefix)).toEqual({ structured: true, text: "SQL\nrare: " });
    expect(presentModelOutput(`${prefix}00`)).toEqual({ structured: true, text: "SQL\nrare: 𠀀" });
  });

  it("流式数组保留已完成项目，并显示当前字符串的安全前缀", () => {
    const raw = '{"plan":{"grain":"订单","steps":["读取订单","汇总\\u65';
    expect(presentModelOutput(raw)).toEqual({
      structured: true,
      text: "查询规划\n粒度：订单\n步骤\n- 读取订单\n- 汇总",
    });
  });

  it("支持完整的标准 JSON 代码围栏", () => {
    const raw = `\n\`\`\`json\n${JSON.stringify(completeOutput, null, 2)}\n\`\`\`\n`;
    const result = presentModelOutput(raw);
    expect(result.structured).toBe(true);
    expect(result.text).toContain("查询规划\n粒度：每行一个订单");
    expect(result.text).toContain("SQL\nSELECT customer_id,");
  });

  it("字段名跨片时保留已解码内容，直到出现确定无效的结构", () => {
    const prefix = '{"sql":"SELECT\\n  1",';
    expect(presentModelOutput(`${prefix}"summ`)).toEqual({ structured: true, text: "SQL\nSELECT\n  1" });
    const invalid = `${prefix}}`;
    expect(presentModelOutput(invalid)).toEqual({ structured: false, text: invalid });
  });

  it.each([
    "  普通回答\n\t保持原样  ",
    '{"sql":"SELECT 1" nope',
    '{"sql":"SELECT 1","debug":{"trace":true',
    JSON.stringify({ ...completeOutput, extra: "不可丢弃" }),
    JSON.stringify({ ...completeOutput, plan: { ...completeOutput.plan, steps: [{ hidden: true }] } }),
  ])("普通、畸形、未知字段或不支持形状原样回退: %s", (raw) => {
    expect(presentModelOutput(raw)).toEqual({ text: raw, structured: false });
  });
});
