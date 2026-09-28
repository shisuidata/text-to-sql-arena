export interface OutputPresentation {
  text: string;
  structured: boolean;
}

type PlanField = "grain" | "sources" | "joins" | "filters" | "metrics" | "steps" | "risks";
type RootField = "plan" | "sql" | "summary" | "assumptions";

type PartialPlan = { grain?: string } & Partial<Record<Exclude<PlanField, "grain">, string[]>>;
interface PartialOutput {
  plan?: PartialPlan;
  sql?: string;
  summary?: string;
  assumptions?: string[];
}

type ParseState = "complete" | "incomplete" | "invalid";
interface StringResult {
  state: ParseState;
  value: string;
}
interface ArrayResult {
  state: ParseState;
  value: string[];
}

const PLAN_FIELDS: readonly PlanField[] = [
  "grain",
  "sources",
  "joins",
  "filters",
  "metrics",
  "steps",
  "risks",
];
const ROOT_FIELDS: readonly RootField[] = ["plan", "sql", "summary", "assumptions"];

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

class QueryPlanPrefixParser {
  private index = 0;
  private readonly output: PartialOutput = {};
  private recognizedValue = false;

  constructor(private readonly source: string) {}

  parse(): { state: ParseState; output: PartialOutput; recognizedValue: boolean } {
    this.skipWhitespace();
    if (!this.take("{")) return this.result("invalid");

    const seen = new Set<RootField>();
    while (true) {
      this.skipWhitespace();
      if (this.atEnd()) return this.result("incomplete");
      if (this.take("}")) {
        this.skipWhitespace();
        return this.result(this.atEnd() && seen.size === 0 ? "complete" : "invalid");
      }

      const key = this.readString();
      if (key.state !== "complete") return this.result(key.state);
      if (!ROOT_FIELDS.includes(key.value as RootField)) return this.result("invalid");
      const field = key.value as RootField;
      if (seen.has(field)) return this.result("invalid");
      seen.add(field);

      this.skipWhitespace();
      if (!this.take(":")) return this.result(this.atEnd() ? "incomplete" : "invalid");
      this.skipWhitespace();
      const state = this.readRootValue(field);
      if (state !== "complete") return this.result(state);

      this.skipWhitespace();
      if (this.take(",")) continue;
      if (this.take("}")) {
        this.skipWhitespace();
        return this.result(this.atEnd() ? "complete" : "invalid");
      }
      return this.result(this.atEnd() ? "incomplete" : "invalid");
    }
  }

  private readRootValue(field: RootField): ParseState {
    if (field === "plan") return this.readPlan();
    if (field === "assumptions") {
      const result = this.readStringArray();
      this.output.assumptions = result.value;
      if (result.state !== "invalid") this.recognizedValue = true;
      return result.state;
    }

    const result = this.readString();
    this.output[field] = result.value;
    if (result.state !== "invalid") this.recognizedValue = true;
    return result.state;
  }

  private readPlan(): ParseState {
    if (!this.take("{")) return this.atEnd() ? "incomplete" : "invalid";
    const plan: PartialPlan = {};
    this.output.plan = plan;
    const seen = new Set<PlanField>();

    while (true) {
      this.skipWhitespace();
      if (this.atEnd()) return "incomplete";
      if (this.take("}")) return seen.size === 0 ? "complete" : "invalid";

      const key = this.readString();
      if (key.state !== "complete") return key.state;
      if (!PLAN_FIELDS.includes(key.value as PlanField)) return "invalid";
      const field = key.value as PlanField;
      if (seen.has(field)) return "invalid";
      seen.add(field);

      this.skipWhitespace();
      if (!this.take(":")) return this.atEnd() ? "incomplete" : "invalid";
      this.skipWhitespace();

      if (field === "grain") {
        const result = this.readString();
        plan.grain = result.value;
        if (result.state !== "invalid") this.recognizedValue = true;
        if (result.state !== "complete") return result.state;
      } else {
        const result = this.readStringArray();
        plan[field] = result.value;
        if (result.state !== "invalid") this.recognizedValue = true;
        if (result.state !== "complete") return result.state;
      }

      this.skipWhitespace();
      if (this.take(",")) continue;
      if (this.take("}")) return "complete";
      return this.atEnd() ? "incomplete" : "invalid";
    }
  }

  private readStringArray(): ArrayResult {
    if (!this.take("[")) {
      return { state: this.atEnd() ? "incomplete" : "invalid", value: [] };
    }

    const value: string[] = [];
    while (true) {
      this.skipWhitespace();
      if (this.atEnd()) return { state: "incomplete", value };
      if (this.take("]")) return { state: value.length === 0 ? "complete" : "invalid", value };

      const item = this.readString();
      if (item.state === "invalid") return { state: "invalid", value: [] };
      value.push(item.value);
      if (item.state === "incomplete") return { state: "incomplete", value };

      this.skipWhitespace();
      if (this.take(",")) continue;
      if (this.take("]")) return { state: "complete", value };
      return { state: this.atEnd() ? "incomplete" : "invalid", value };
    }
  }

  private readString(): StringResult {
    if (!this.take('"')) {
      return { state: this.atEnd() ? "incomplete" : "invalid", value: "" };
    }

    let value = "";
    while (!this.atEnd()) {
      const char = this.source[this.index++];
      if (char === '"') return { state: "complete", value };
      if (char === "\\") {
        if (this.atEnd()) return { state: "incomplete", value };
        const escaped = this.source[this.index++];
        if (escaped in SIMPLE_ESCAPES) {
          value += SIMPLE_ESCAPES[escaped];
          continue;
        }
        if (escaped !== "u") return { state: "invalid", value: "" };

        const digits = this.source.slice(this.index, this.index + 4);
        if (digits.length < 4) {
          if (![...digits].every((digit) => /[0-9a-fA-F]/.test(digit))) {
            return { state: "invalid", value: "" };
          }
          return { state: "incomplete", value };
        }
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) return { state: "invalid", value: "" };
        const codeUnit = Number.parseInt(digits, 16);
        this.index += 4;
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
          const pair = this.source.slice(this.index, this.index + 6);
          const incompletePair = pair.length < 6 && (
            "\\u".startsWith(pair) || /^\\u[dD]$/.test(pair) || /^\\u[dD][c-fC-F][0-9a-fA-F]{0,2}$/.test(pair)
          );
          if (incompletePair) return { state: "incomplete", value };
          if (/^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(pair)) {
            value += String.fromCharCode(codeUnit, Number.parseInt(pair.slice(2), 16));
            this.index += 6;
            continue;
          }
        }
        value += String.fromCharCode(codeUnit);
        continue;
      }
      if (char.charCodeAt(0) < 0x20) return { state: "invalid", value: "" };
      value += char;
    }
    return { state: "incomplete", value };
  }

  private skipWhitespace() {
    while (" \t\r\n".includes(this.source[this.index] ?? "x")) this.index += 1;
  }

  private take(expected: string): boolean {
    if (this.source[this.index] !== expected) return false;
    this.index += 1;
    return true;
  }

  private atEnd(): boolean {
    return this.index >= this.source.length;
  }

  private result(state: ParseState) {
    return { state, output: this.output, recognizedValue: this.recognizedValue };
  }
}

function unwrapJsonFence(raw: string): string {
  const complete = raw.match(/^\s*```json\s*\n([\s\S]*?)\n```\s*$/i);
  if (complete) return complete[1];

  const streaming = raw.match(/^\s*```json\s*\n([\s\S]*)$/i);
  return streaming ? streaming[1] : raw;
}


function appendList(lines: string[], label: string, values: string[] | undefined) {
  if (values === undefined) return;
  lines.push(label);
  lines.push(...values.map((value) => `- ${value}`));
}

function renderOutput(output: PartialOutput): string {
  const sections: string[] = [];
  if (output.plan) {
    const lines = ["查询规划"];
    if (output.plan.grain !== undefined) lines.push(`粒度：${output.plan.grain}`);
    appendList(lines, "数据源", output.plan.sources);
    appendList(lines, "连接", output.plan.joins);
    appendList(lines, "筛选", output.plan.filters);
    appendList(lines, "指标", output.plan.metrics);
    appendList(lines, "步骤", output.plan.steps);
    appendList(lines, "风险", output.plan.risks);
    sections.push(lines.join("\n"));
  }
  if (output.sql !== undefined) sections.push(`SQL\n${output.sql}`);
  if (output.summary !== undefined) sections.push(`说明\n${output.summary}`);
  if (output.assumptions !== undefined) {
    const lines = ["假设", ...output.assumptions.map((item) => `- ${item}`)];
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

export function presentModelOutput(raw: string): OutputPresentation {
  const parsed = new QueryPlanPrefixParser(unwrapJsonFence(raw)).parse();
  if (parsed.state !== "invalid" && parsed.recognizedValue) {
    return { text: renderOutput(parsed.output), structured: true };
  }
  return { text: raw, structured: false };
}
