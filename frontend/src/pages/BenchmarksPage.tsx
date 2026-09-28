import { useQuery } from "@tanstack/react-query";
import { BookOpenText, Boxes, Database, Hash } from "lucide-react";
import { api } from "../api/client";
import { EmptyState, PageHeader } from "../components/AppShell";
import { displaySuiteName } from "../lib/suiteIdentity";

export function BenchmarksPage() {
  const suites = useQuery({ queryKey: ["suites"], queryFn: api.suites });
  const publishedSuites = (suites.data ?? []).map((suite) => ({
    ...suite,
    versions: suite.versions
      .filter((version) => version.status === "published")
      .sort((left, right) => right.version - left.version),
  })).filter((suite) => suite.versions.length > 0);

  return <div className="page benchmarks-page">
    <PageHeader eyebrow="评测依据" title="测试集" description="同一个测试集可有多个版本。版本、题目范围和内容哈希是评测标签；不同版本的分数不能直接混排。"/>
    {!publishedSuites.length ? <EmptyState icon={<Boxes/>} title="暂无可用测试集" body="应用当前没有可供评测选择的已发布版本。"/> : <div className="suite-list">
      {publishedSuites.map((suite) => {
        const latest = suite.versions[0];
        return <article className="suite-card" key={suite.id}>
          <header>
            <div className="suite-icon"><Database/></div>
            <div><h2>{displaySuiteName(suite.name)}</h2><p>{suite.description}</p></div>
            <div className="suite-latest"><span>最新版本</span><strong>v{latest.version}</strong></div>
          </header>
          <div className="version-list">
            {suite.versions.map((version) => <section className="version-row" key={version.id} aria-labelledby={`suite-version-${version.id}`}>
              <div className="version-tag" id={`suite-version-${version.id}`}>v{version.version}</div>
              <div className="version-main">
                <div className="version-facts">
                  <span>已发布</span>
                  <span>{version.cases.length} 题</span>
                  <span>{version.structure?.tables?.length ?? 0} 张表</span>
                  <span>{version.dialect.toUpperCase()}</span>
                </div>
                <div className="version-proof"><Hash size={15}/><span>内容哈希</span><code>{version.content_hash}</code></div>
                <details className="case-catalog">
                  <summary><BookOpenText size={17}/>查看 {version.cases.length} 道题目</summary>
                  <ol>{[...version.cases].sort((left, right) => left.sort_order - right.sort_order).map((item) => <li key={item.id}>
                    <div><strong>{item.title}</strong><span>{item.radar_dimension} · {item.difficulty}</span></div>
                    <p>{item.question}</p>
                  </li>)}</ol>
                </details>
              </div>
            </section>)}
          </div>
        </article>;
      })}
    </div>}
  </div>;
}
