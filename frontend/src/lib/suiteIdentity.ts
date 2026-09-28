const SUITE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "retail-analytics-v1": "零售分析 SQL 测试集",
};

export function displaySuiteName(name: string): string {
  return SUITE_DISPLAY_NAMES[name] ?? name;
}
