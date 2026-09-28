# 公开证据导出与验真

## 1. 目标

公开证据包用于回答三个问题：

1. 报告分数从哪些案例和事件得到？
2. 题库、Prompt、模型身份、SQL、结果和评分能否独立检查？
3. GitHub 中的文件是否在导出后被修改、删除或偷偷增加？

它不是数据库备份。公开性优先于恢复应用内部状态。

## 2. 导出

```bash
uv run python -m backend.app.cli export-evidence --output evidence
```

行为：

1. 确认数据库兼容字段存在。
2. 查询全部 `published` 题库版本。
3. 从数据库源重建每版 SuiteSource 并重新计算 content hash。
4. 读取 content-hash 目录中原冻结 manifest/gold，校验 suite hash 与金标内容摘要。缺失或不一致则终止；不得用当前评分版本重建并覆盖历史金标。
5. 写入题库源、结构、构建清单和完整金标。
6. 查询全部历史运行，不只导出成功运行。
7. 使用在线 API 同一个 `reporting.py` 构建报告和案例证据。
8. 写入所有持久化事件 JSONL。
9. 对公开对象递归脱敏。
10. 为每个 bundle 生成逐文件 SHA-256 和整包摘要。
11. 在临时目录完整生成后替换目标 `suites/`、`runs/` 和 `index.json`。

若导出中途失败，既有证据目录不会被半成品覆盖。

## 3. 目录

```text
evidence/
  index.json
  suites/
    <64-char-content-hash>/
      source/
        schema.sql
        seed.sql
        semantic.json
        prompt.md
        cases.yaml
      artifact-manifest.json
      gold/
        <case-key>.json
      suite.json
      bundle-manifest.json
  runs/
    run-0001/
      report.json
      events.jsonl
      cases/
        case-run-00001.json
      bundle-manifest.json
```

### `suite.json`

标识 suite/version、方言、content hash、发布时间、结构快照和仓库策略。`warehouse.committed=false` 是有意设计：二进制 DuckDB 不提交，复核者从 `source/schema.sql` 和 `source/seed.sql` 重建。

### `artifact-manifest.json`

发布构建时生成的题库产物清单和各案例 gold digest。它证明运行引用的金标与公开 gold 文件属于同一内容哈希。

### `report.json`

完整运行报告；当前新导出为 `run-report-v3`，包括运行/模型/案例快照、官方分数、独立质量指标、资源效率和结论，不依赖当前 profile。历史目录保留其原始合同版本、字段与字节，不原地迁移。

### `events.jsonl`

每行一个事件 JSON。顺序就是持久化 `seq` 顺序。JSONL 便于流式检查和命令行处理。

### `cases/*.json`

单案例最完整证据：

- 模型和题目身份；
- 实际 Prompt；
- 原始输出；
- plan/assumptions/summary；
- generated/formatted SQL；
- token、Provider request ID、生成/执行耗时；
- expected/actual digest；
- 结果和缺失/额外行预览；
- score breakdown；
- reference SQL 和完整 expected result（已完成案例）。

失败或取消案例如果从未产生金标对照上下文，相关字段保持 `null`/缺省，不伪造。

## 4. 公开脱敏

导出器在 JSON/JSONL/YAML 写入前处理：

- `Authorization: Bearer ...`；
- `api_key=...`、`token=...`、`secret=...`；
- 映射中名为 authorization/api_key/token/secret 的值；
- 项目绝对路径替换为 `$PROJECT_ROOT`；
- `/Users/<name>` 和 `/home/<name>` 替换为 `$HOME`；
- 应用临时目录替换为 `$TMPDIR/llm-test-<redacted>`。

写入器还会拒绝已知 GitHub/OpenAI/Google 密钥模式和残留用户绝对路径。

限制：任何正则脱敏都不能识别任意形态的秘密。发布前仍必须做独立文本/密钥扫描；原始数据库和认证目录从源头不进入 Git。

## 5. 不公开内容

| 内容 | 原因 | 替代证据 |
| --- | --- | --- |
| `var/app.db`, WAL, SHM | 含当前密钥引用、健康详情、绝对路径和内部状态 | 脱敏 JSON 报告/事件/案例 |
| `var/suites/**/warehouse.duckdb` | 二进制、可由源重建 | Schema、Seed、manifest、gold |
| `var/cli-homes` | 可能含认证、history、路径 | 隔离快照摘要 |
| Keychain 等密钥存储值与 API Key 明文 | 凭据（仅历史数据可能存在 Keychain 值） | `has_secret`/backend 类型，不含值 |
| Pi `auth.json` | 本机凭据 | 只披露 Provider 与凭据类型；引用形式 `pi-auth:<provider>`，不含值 |
| 环境变量与 shell 配置 | 凭据和个人信息 | 受控环境键合同 |
| 数据库备份 | 与原始 DB 同风险 | 公开证据包 |

## 6. 摘要算法

单文件：原始字节的 SHA-256。

整包：

1. 递归列出 bundle 内所有文件，排除 `bundle-manifest.json` 自身。
2. 按 POSIX 相对路径排序。
3. 生成记录 `{path, sha256, bytes}`。
4. 使用 `sort_keys=true`、无空白 JSON 编码记录数组。
5. 对该字节串计算 SHA-256。

这同时检测内容、文件名、缺失文件和额外文件。

## 7. 验真

```bash
uv run python -m backend.app.cli verify-evidence --input evidence
```

当前预期：

```json
{
  "suite_count": 2,
  "run_count": 18
}
```

校验器会：

- 验证 root schema version；
- 验证每个 suite/run 目录；
- 比较登记路径与实际路径集合；
- 比较文件字节数和 SHA-256；
- 重新计算 bundle digest；
- 比较 root index 中的 bundle digest。

它不会重新调用模型。要重算 SQL 金标，执行完整 export 或题库构建测试。

## 8. 第三方复核建议

最小复核流程：

```bash
uv sync --frozen
uv run python -m backend.app.cli verify-evidence --input evidence
uv run pytest -q tests/test_retail_suite.py tests/test_result_compare.py tests/test_sql_evaluator.py
```

针对某次运行：

1. 打开 `report.json`，记录 suite hash、协议版本和模型快照。
2. 在对应 suite `source/cases.yaml` 找案例。
3. 检查 CaseRun `prompt` 不含 reference/gold/AST 规则。
4. 比较 raw output、parsed SQL 和 score breakdown。
5. 在 `events.jsonl` 按 case_run_id 过滤完整生命周期。
6. 对照 gold JSON、expected/actual digest 和差异行。
7. 若要独立执行，使用公开 Schema/Seed 构建 DuckDB，再运行 formatted SQL。

## 9. 可重复与不可重复部分

可确定性重复：

- suite content hash；
- DuckDB 数据；
- gold 结果和 digest；
- 给定模型输出后的 SQL 守卫、执行、比较和评分；
- 报告聚合；
- 证据摘要。

通常不可逐字节重复：

- 外部模型输出；
- Provider request ID；
- 生成延迟和网络行为；
- Provider 在同一公开模型名背后的服务端路由。

精确复跑的“精确”指本应用冻结的输入和配置快照，不承诺外部模型确定性。

## 10. 静态站点展示边界

`site/` 在构建时直接读取 `evidence/index.json`、题库 manifest 和每次运行的 `report.json`，生成题库索引、历史运行索引和报告详情页。`docs/*.md` 在构建前同步为 Starlight 内容；生成副本不提交。

站点是展示层，不是新的证据层：

- 页面显示的分数、状态、模型名称、题库哈希和 bundle digest 必须来自已提交证据；
- 页面路由使用稳定的 `run-XXXX` 目录名和 64 位题库 content hash；
- 视觉图表不参与摘要计算，也不能代替 `verify-evidence`；
- 证据变更后必须重新执行站点检查与构建，禁止手工维护第二份运行列表；
- Cloudflare Pages 只发布静态产物，不接收模型密钥、用户输入或运行时数据库。

每一条 `CaseRun` 还会生成独立详情页：

```text
/runs/run-XXXX/cases/case-run-YYYYY/
```

详情页完整展示：实际 Prompt、请求事件、原始响应、解析方案、生成/格式化 SQL、Token 与耗时、评分规则、期望/实际结果、全部案例事件及未经裁剪的案例 JSON。运行报告中的每个模型 × 测试用例记录都直接链接到对应详情页。

`provider.requested` 从新运行开始保存脱敏的 Pi 调用信封：

- Pi harness/bridge/policy 版本、Provider、认证模式、请求模型和响应模式；
- 固定 Prompt、显式生成参数、单轮/无工具/生成尝试次数与系统 Prompt 摘要；
- Provider 实际请求元数据仅在 bridge 返回且通过脱敏时保存；不会保存 OAuth/API Key、Authorization 或凭据文件内容（凭据引用仅为 `pi-auth:<provider>` 形式，历史快照中的旧引用值只读保留）。

Run 1—18 及其他既有历史证据按原字节、原适配器和原比较标签保留，不补写 Pi 字段，也不会根据现有 Prompt 反向伪造底层请求。新报告可以显示 `controlled_harness` 以及安全的 Provider/认证/有效控制，但“统一 harness”不表示同一端点或同一模型。

本地站点验收：

```bash
cd site
pnpm check
pnpm build
```

完整证据验真仍以第 7 节命令为准。
