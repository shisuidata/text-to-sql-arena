import { Component, lazy, Suspense, type PropsWithChildren } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell";

const RunNewPage = lazy(() => import("./pages/RunNewPage").then((module) => ({ default: module.RunNewPage })));
const RunLivePage = lazy(() => import("./pages/RunLivePage").then((module) => ({ default: module.RunLivePage })));
const ReportPage = lazy(() => import("./pages/ReportPage").then((module) => ({ default: module.ReportPage })));
const BenchmarksPage = lazy(() => import("./pages/BenchmarksPage").then((module) => ({ default: module.BenchmarksPage })));
const ModelsPage = lazy(() => import("./pages/ModelsPage").then((module) => ({ default: module.ModelsPage })));

class RouteErrorBoundary extends Component<PropsWithChildren, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) return <main className="boot-error"><b>当前页面渲染失败</b><p>{this.state.error.message}</p><a className="button primary" href={window.location.href}>重新加载</a></main>;
    return this.props.children;
  }
}

export default function App() {
  const location = useLocation();
  return <AppShell><RouteErrorBoundary key={location.pathname}><Suspense fallback={<div className="loading-screen">正在加载本地评测台…</div>}><Routes><Route path="/" element={<Navigate to="/runs/new" replace/>}/><Route path="/runs/new" element={<RunNewPage/>}/><Route path="/runs/:id/live" element={<RunLivePage/>}/><Route path="/runs/:id/report" element={<ReportPage/>}/><Route path="/benchmarks" element={<BenchmarksPage/>}/><Route path="/models" element={<ModelsPage/>}/><Route path="*" element={<Navigate to="/runs/new" replace/>}/></Routes></Suspense></RouteErrorBoundary></AppShell>;
}
