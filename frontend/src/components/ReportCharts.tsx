import { BarChart, HeatmapChart as HeatmapSeries, RadarChart as RadarSeries } from "echarts/charts";
import { GridComponent, LegendComponent, RadarComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import * as echarts from "echarts/core";
import type { EChartsOption } from "echarts";
import { SVGRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";
import { displayModelName } from "../lib/modelIdentity";
import { resolveShisuiTheme, type ShisuiTheme } from "../lib/shisui";
import type { RunSnapshot } from "../types";

echarts.use([BarChart, HeatmapSeries, RadarSeries, GridComponent, LegendComponent, RadarComponent, TooltipComponent, VisualMapComponent, SVGRenderer]);

const fallbackDimensions = ["基础查询", "连接与粒度", "聚合与指标", "时间与窗口", "复杂查询", "数据开发"];

function useChart(option: EChartsOption) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
    chart.setOption(option, true);
    const resize = () => chart.resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(ref.current);
    const frame = requestAnimationFrame(resize);
    window.addEventListener("resize", resize);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener("resize", resize); chart.dispose(); };
  }, [option]);
  return ref;
}

function chartBase(theme: ShisuiTheme) {
  return {
    backgroundColor: "transparent",
    textStyle: { color: theme.gray900, fontFamily: theme.fontSans },
    tooltip: {
      trigger: "item" as const,
      backgroundColor: theme.canvas,
      borderColor: theme.paper3,
      textStyle: { color: theme.gray900, fontFamily: theme.fontSans },
      extraCssText: "box-shadow: var(--sh-shadow-md); border-radius: var(--sh-r-md);",
    },
  };
}

export function RankingChart({ report }: { report: RunSnapshot }) {
  const theme = resolveShisuiTheme();
  const palette = [theme.viz1, theme.viz2, theme.viz3, theme.viz4, theme.viz5, theme.viz6, theme.viz7, theme.viz8];
  const models = [...report.models].sort((a, b) => (b.official_score ?? 0) - (a.official_score ?? 0));
  const ref = useChart({
    ...chartBase(theme),
    grid: { left: 112, right: 36, top: 16, bottom: 26 },
    xAxis: { type: "value", min: 0, max: 100, axisLabel: { color: theme.gray500, fontFamily: theme.fontNumber }, axisLine: { lineStyle: { color: theme.gray200 } }, splitLine: { lineStyle: { color: theme.paper3 } } },
    yAxis: { type: "category", inverse: true, data: models.map((model) => displayModelName(model.name)), axisLabel: { color: theme.ink700, fontFamily: theme.fontSans, width: 96, overflow: "truncate" }, axisLine: { show: false }, axisTick: { show: false } },
    series: [{ type: "bar", data: models.map((model, index) => ({ value: Number((model.official_score ?? 0).toFixed(2)), itemStyle: { color: palette[index % palette.length] } })), barWidth: 22, label: { show: true, position: "right", color: theme.ink700, fontFamily: theme.fontNumber, formatter: "{c}" } }],
  });
  return <div ref={ref} className="chart"/>;
}

export function RadarChart({ report }: { report: RunSnapshot }) {
  const theme = resolveShisuiTheme();
  const palette = [theme.viz1, theme.viz2, theme.viz3, theme.viz4, theme.viz5, theme.viz6, theme.viz7, theme.viz8];
  const dimensions = Array.from(new Set(report.models.flatMap((model) => Object.keys(model.categories ?? {}))));
  const activeDimensions = dimensions.length ? dimensions : fallbackDimensions;
  const ref = useChart({
    ...chartBase(theme),
    color: palette,
    legend: { bottom: 0, textStyle: { color: theme.gray500, fontFamily: theme.fontSans } },
    radar: { radius: "64%", center: ["50%", "47%"], indicator: activeDimensions.map((name) => ({ name, max: 100 })), axisName: { color: theme.ink700, fontFamily: theme.fontSans }, splitLine: { lineStyle: { color: theme.paper3 } }, splitArea: { areaStyle: { color: [theme.canvas, theme.paper] } }, axisLine: { lineStyle: { color: theme.gray200 } } },
    series: [{ type: "radar", data: report.models.map((model) => ({ name: displayModelName(model.name), value: activeDimensions.map((dimension) => Number(model.categories?.[dimension] ?? 0)), areaStyle: { opacity: .14 } })) }],
  });
  return <div ref={ref} className="chart"/>;
}

export function HeatmapChart({ report }: { report: RunSnapshot }) {
  const theme = resolveShisuiTheme();
  const cases = report.models[0]?.cases.filter((item, index, all) => all.findIndex((other) => other.stable_key === item.stable_key) === index).map((item) => item.stable_key) ?? [];
  const data = report.models.flatMap((model, y) => cases.map((key, x) => [x, y, Number(([...model.cases].reverse().find((item) => item.stable_key === key)?.score?.total ?? 0).toFixed(2))]));
  const ref = useChart({
    ...chartBase(theme),
    grid: { left: 140, right: 36, top: 24, bottom: 96 },
    xAxis: { type: "category", data: cases.map((_, index) => String(index + 1).padStart(2, "0")), axisLabel: { color: theme.gray500, fontFamily: theme.fontNumber, interval: 0 }, axisLine: { lineStyle: { color: theme.gray200 } }, axisTick: { lineStyle: { color: theme.gray200 } } },
    yAxis: { type: "category", data: report.models.map((model) => displayModelName(model.name)), axisLabel: { color: theme.ink700, fontFamily: theme.fontSans, width: 120, overflow: "truncate" }, axisLine: { lineStyle: { color: theme.gray200 } }, axisTick: { show: false } },
    visualMap: { min: 0, max: 100, orient: "horizontal", left: "center", bottom: 4, inRange: { color: [theme.paper, theme.ink100, theme.ink300, theme.ink500, theme.ink700] }, textStyle: { color: theme.gray500, fontFamily: theme.fontNumber } },
    series: [{ type: "heatmap", data, label: { show: true, color: theme.ink700, backgroundColor: theme.canvas, fontFamily: theme.fontNumber, formatter: ({ value }) => Array.isArray(value) ? String(value[2]) : "" }, itemStyle: { borderColor: theme.canvas, borderWidth: 3 } }],
  });
  return <div ref={ref} className="chart wide"/>;
}
