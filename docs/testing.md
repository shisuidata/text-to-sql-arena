# 测试策略与证据等级

## 1. 原则

测试只为可观察合同服务：

- 同样输入是否生成同样题库和金标？
- 危险 SQL 是否被拒绝？
- 结果比较是否正确处理类型、重复行、容差和顺序？
- Provider 记录格式是否按预期解析？
- 运行状态、取消、续传、复跑和报告是否端到端一致？
- 公开证据是否脱敏且能检测篡改？
- UI 的关键交互是否使用正确后端证据？

不测试纯实现细节、源文本存在性或无行为意义的 getter。

## 2. 一键验证

```bash
./script/verify.sh
```

脚本依次执行：

1. Ruff；
2. mypy strict；
3. Pytest；
4. 空 SQLite 的 Alembic `upgrade head`；
5. 已提交证据摘要校验；
6. ESLint；
7. TypeScript build typecheck；
8. Vitest；
9. Vite production build。

任何一步失败即退出非零。

## 3. 后端测试矩阵

### `tests/test_retail_suite.py`

保护：

- 相同源生成相同 content hash 和 lock；
- 当前题库恰好 18 题、六维均衡和难度分布；
- 雷达维度是可版本化字符串，历史维度可重建；
- 固定表基数和专用边界数据存在；
- 所有参考 SQL 与提交的 lock 完全一致；
- 18 个参考查询完整评分为 100。

未证明：模型能解这些题。

### `tests/test_suites.py`

保护：

- 发布构建可复现；
- Schema/Seed/semantic/cases 变化会改变哈希；
- 结构快照包含实际外键和语义关系；
- Prompt 包含问题、结构、语义和输出合同；
- Prompt 不含 reference SQL、金标和 AST 评分规则；
- 非确定性/危险 Seed、错误参考 SQL 和非法合同被拒绝。

未证明：公开题库不会被模型记忆。

### `tests/test_result_compare.py`

保护：

- 全精度 Decimal、整数列精确比较与非整数列容差；
- NULL、布尔、日期、UTC 时间戳和 Unicode NFC；
- 重复行按多重集处理；
- 列名大小写/引用符与列重排；
- 指纹映射唯一性和歧义失败；
- 有序/无序结果；
- 空结果 precision/recall/F1 边界；
- 金标和实际摘要稳定。

未证明：比较器支持任意数据库私有类型；执行方言仅 DuckDB。

### `tests/test_sql_evaluator.py`

保护：

- 单语句、只读 Query、表白名单和 CTE；
- 外部函数、未知 schema、写入和多语句拒绝；
- Worker 超时、行数上限和错误映射；
- 窗口、相关子查询、NOT EXISTS、CTE、条件聚合和预聚合 AST 规则；
- 100 分固定公式及部分失败得分；
- 案例权重、attempt mean/nonzero-score/stddev 和结论生成；
- `result-quality-v1` 对完整评分、未知证据和全计划尝试分母的判定；
- challenge check 用真实 DuckDB 验证典型错解可区分，并保护“全错但空结果相同”不得误报的边界。

未证明：SQLGlot 或 DuckDB 不存在未知漏洞；因此实现还保留运行时只读和 external access 双层防守。challenge check 是题库自检，不是模型能力测试；变体只在临时目录构建，不改变 canonical hash 或发布目录。

### Pi 适配器与桥接测试

保护：

- 新 profile 只接受 `pi`/`text`，验证 Provider、认证、默认 180 秒超时和可选生成参数；界面固定 180 秒，API 可显式配置超时并在快照中披露；
- `openai-codex` 只接受 OAuth，模型候选来自锁定目录，拒绝订阅端点变更、API Key 与 `max_tokens`；
- 本地检查只读 Pi 凭据文件验证存在性与有效期，不自动读取个人配置、工具或会话、不发生成请求；评测台不写入、不刷新凭据，OAuth 过期要求回 Pi 刷新登录，原凭据文件保持不变；
- Pi 本机凭据引用覆盖：`auth.json` 有该 Provider 对应类型凭据条目时保存 `pi-auth:<provider>` 引用且不复制凭据；Pi 本机凭据缺失且非环回 → 422 `provider_auth_error`；端点覆盖与 Pi 目录解析出的服务端地址不一致 → 422；本机环回端点无凭据可保存（`secret_backend=none`、运行时不发送凭据）；PATCH 修改 `parameters`/`model_id`/`base_url` 时重新解析凭据引用并写回 `api_key_ref`，失败即 422；DELETE 软删除不触碰任何凭据存储；`/pi/credentials` 只返回 Provider 与类型存在性，不返回值；
- 本机 `models.json` 声明式定义不执行命令、不导入凭据或提示词；未知协议配置标为不可用，无效/含凭据 URL 不回显；HTTP 回归覆盖缺失协议、URL userinfo 与错误 input 对象的安全返回；
- 声明式自定义模型定义通过真实 Pi SDK 和本地 Completions 协议服务完成单次调用，验证兼容字段保留且定义元数据不进入请求；
- Node bridge 固定 `@earendil-works/pi-ai` 0.85.1，结构化 stdin/stdout 合同、取消、超时和错误映射可在无 Provider 网络调用下验证；
- 隔离快照披露单轮、无工具、生成尝试上限 1（本地检查实际生成 0 次）、固定 Prompt 摘要、Provider/认证和有效参数，不包含凭据；
- 旧适配器实现及专属解析测试已移除；接口测试保护历史配置不可用于新运行或复测，历史报告继续读取冻结证据而不重算分数；
- 递归密钥脱敏继续覆盖事件、报告和公开证据。

自动化检查不调用真实 Provider。另已对 GPT 订阅路径完成一次独立 smoke：Pi 0.85.1、`openai-codex/gpt-5.6-luna`、使用既有 Pi 订阅登录凭据、单请求、无工具，严格 JSON 的 `SELECT 1` 执行得到 `[(1,)]`（生成 2839 ms；381 input / 66 output Token）。它没有创建 benchmark run 或历史记录，不是完整评测，也不证明其他远端 Provider 可用。另用真实 Pi SDK 连接本地协议服务，验证 Anthropic/Google 单请求路径，以及超时、取消和超长输出的错误边界；这些本地检查不是远端模型实测。

2026-09-18 目录/导入验收：真实浏览器在 1440px 与 390px 验证目录筛选、能力联动、OAuth 保存、显式上传和导入保存（该上传入口现已移除，模型仅来自本机 Pi 声明式定义）；隔离临时数据库与 loopback 协议服务验证了预览/本地检查零生成、一次评测恰好一次模型请求、命令不执行，以及修改当前导入定义后历史运行快照不变。未调用外部付费模型，未向用户数据库添加验收记录。

同日已接入名单验收：真实本机配置返回 11 个模型（Codex 3、DeepSeek 2、仅扩展注册 6），桌面 1440px / 移动端 390px 均只展示该名单；Provider 筛选与不可用提示已核对。浏览器拦截并中止保存请求，确认本机自定义模型提交包含规范化定义，用户已保存配置前后完全相同。新增回归覆盖空/缺失名单不回退完整目录、白名单筛选、重复项、覆盖优先级及未知扩展模型；73 项后端测试、15 项前端测试与构建通过。

### `tests/test_api_integration.py`

使用 FastAPI TestClient、真实 SQLite、真实题库构建、真实运行引擎和真实评分器。模型层换成 FixtureAdapter。

保护：

- 创建/本地就绪检查模型配置；
- 只读题库目录仅返回已发布版本；草稿 Prompt 预览返回 404，已退出的题库写入/挑战入口不可调用；已发布版本 Prompt 预览保留；
- 双模型完整状态机；
- 成功模型 18 题真实执行和 100 分链路；
- 失败模型、错误码和脱敏；
- `run.started` 与有 model ID 的 `model.started` 事件语义；
- 事件严格递增、history `after_seq` 和 SSE 续传；
- 默认隐藏和显式揭示 reference/gold；
- 生成耗时与 Provider request ID 落库；
- run-report-v4/result-quality-v2 的业务结果、格式、失败分类与效率；旧 scorer 1.x 动态报告及历史公开证据保留原合同；
- profile 改名后历史报告仍使用名称快照；
- exact rerun 复制冻结快照；执行/评分环境变化时拒绝冒充原环境；
- 取消到终态；
- Host、Origin 和 CSRF 拒绝；
- 全量证据导出、路径/密钥脱敏、摘要验真和篡改检测。

关键限制：FixtureAdapter 直接返回每题参考 SQL。它验证编排、执行、比较、评分、事件和报告链路，不是外部模型能力证明。真实模型能力只能由 `evidence/runs/` 中的实际 Provider/CLI 运行支持。

## 4. 前端测试矩阵

`frontend/src/test/arena.test.tsx` 使用 Vitest、jsdom、Testing Library 和 mock API。

保护：

- 新建运行只允许 Pi profile；历史 profile 保持可见、不可选且仍可删除；
- 竞技场固定单次尝试，预检通过后才能开赛；
- SSE 按最后 seq 重连且不重复消费，终态保留最后事件并停止重连；useRunEvents 测试覆盖超过 5000 条历史补齐、历史失败重试、切换运行时忽略旧请求；
- 演示模式只写当前 tab 的 `sessionStorage`；
- SQL 工作区把 plan、SQL、固定金标和实际结果放在正确位置；
- 报告分开披露配置和逐题实际调用；相同配置但实际 wire 预算不同或请求缺失时不输出进退结论；嵌套控制项不暴露密钥；
- 运行中取消调用正确 API 并刷新状态；旧事件缺失 payload 不影响相邻输出，状态轮询失败仍保留已收到片段；
- PiOutputPanel 测试覆盖双模型交错片段、固定选题不被新题抢走、失败保留文本以及模型文本按纯文本渲染；
- BenchmarksPage 回归覆盖隐藏草稿、只读查看已发布题目、展示名称与版本分离，以及不再提供编辑/复制/发布入口；

2026-09-19 产品功能收敛验收：36 项前端测试、8 项后端 API 集成测试、ESLint、TypeScript、Ruff、mypy 与生产构建通过。真实浏览器在 1440px/390px 验证只读题库说明与题目展开，旧编辑 URL 回到新建评测且默认选择 v4；运行 #22 的报告、逐题证据和发布预览仍可用，真实 API 导出 66 文件 ZIP 并通过归档校验，状态为 exported-not-published。既有公开证据校验通过（2 个题库版本、18 场运行）；用户题库、草稿、运行、案例与事件逐表行内容摘要前后完全一致。未调用外部模型或部署公开站点。

未覆盖：

- 真实浏览器布局、字体加载和 SVG 图表；
- 浏览器与真实 FastAPI 的完整写操作；
- 多浏览器兼容；
- 触屏和辅助技术完整流程。

因此不能称为“自动化 E2E”。发布前需要真实浏览器 smoke。

## 5. 真实浏览器 smoke

至少验证：

1. `GET /api/health` 返回 0.3.0；
2. 首页/历史页加载，18 次公开前历史运行仍可打开；
3. Run 18 报告显示 Luna 95.09、Sol 92.04，并标为 `pure_model`；
4. 案例工作区默认隐藏 Reference，点击后能加载金标；
5. 实时日志筛选和历史事件加载正常；
6. 生产构建没有浏览器 console error；
7. 404 前端路径回退到 SPA。
8. 新运行选择器禁用历史适配器并固定 1 次尝试；报告将 `controlled_harness` 解释为统一 Pi 控制而非同端点/同模型。此 smoke 不创建 profile、不调用 Provider。

Smoke 只确认被操作的路径，不替代自动化合同测试。

2026-09-19 实时 Pi 输出验收：隔离 SQLite 与本地慢速 SSE 协议服务经真实 Pi SDK、事件持久化和网页 SSE，在请求未完成时观察到双模型片段持续增长。通过代理切断实际 SSE 连接并续传，重放文本逐字等于数据库事件拼接，无丢失或重复；刷新恢复、输出截断错误、取消保留片段均已实测。取消跨历史/实时事件的时区偏移已修正，刷新后取消显示 0.8 秒而非多出 8 小时。真实历史记录在 1440px / 390px 验证事件切换、滚动暂停/恢复与无横向溢出。73 项后端、21 项前端测试通过；没有调用外部模型，验收数据仅写临时库。

2026-09-19 输出阅读改造验收：前端 35 项测试、ESLint、TypeScript 与生产构建通过。读取既有运行 #22 验证阅读视图中的 SQL/摘要与原文一致；对两条真实回答的全部 1,593 个字符前缀执行流式解码，已识别内容不闪回原始 JSON。只读本地 SSE 回放中，两栏在未完成状态下从 127/132 字符增长至 303/303 字符；中途切换原始文本后继续追加，终态与事件拼接逐字一致。1440px、820px、390px 页面检查通过，深色输出与事件日志在可见区域无横向溢出，展开明细不覆盖相邻可见行。模型页及报告配置证据页已检查，预检参数、接入身份与已披露差异保留。本次不调用外部模型、不写用户运行记录；回放服务和脚本验收后移除。

### 0.2.0 开源候选实测结果

- `/api/health`：HTTP 200，`{status: "ok", version: "0.2.0"}`。
- 1440px Chromium：`/runs/new`、`/benchmarks`、`/models`、`/runs/18/live`、`/runs/18/report` 均加载；没有 console warning/error、page error 或横向溢出。
- 新建对局页首次视觉检查发现卡片使用 `model-card-foot`、CSS 仍指向已删除的 `model-meta`；迁移样式并重建后，状态徽标与响应模式为 flex 布局、间距 10px，截图确认不再贴连。
- Run 18 报告：Luna 95.09、Sol 92.04、`pure_model`；总分、雷达和热力图实际渲染；APP 0.1.0 是该历史运行快照，不是当前服务版本。
- Live 工作区：293 条持久化事件可见；`case.failed` 服务端筛选得到 1 条；案例 08 默认隐藏 Reference，显式揭晓后返回参考 SQL、12 行金标和 digest。
- 未知前端路径 HTTP 200 返回 SPA，并由客户端重定向到 `/runs/new`。
- 1024px、768px 无横向溢出；390px 会横向滚动到 631px，因此手机布局明确不在 0.2.0 支持范围。
- 没有在 smoke 中创建新运行或点击 exact rerun：这会调用真实外部模型并改变历史状态；创建、取消和复跑合同由 API 集成测试覆盖，真实 Provider 行为由已公开的 Runs 1–18 支持。

## 6. 迁移验证

空库验证必须使用临时 `LLM_TEST_VAR_DIR` 和 `LLM_TEST_DATABASE_URL`，执行：

```bash
uv run alembic upgrade head
```

随后确认：

- `alembic_version = 8d7f4c12a901`；
- `comparison_runs` 有五个版本快照字段；
- `model_profiles` 有 `pricing_json`；
- `model_runs` 有 `profile_name_snapshot` 和 `pricing_snapshot_json`；
- `case_runs` 有 `generation_ms` 和 `provider_request_id`。

现有早期数据库还要验证兼容路径：列已被 `ensure_schema()` 添加时，迁移可幂等跳过并正确盖章。

## 7. 证据验证

```bash
uv run python -m backend.app.cli verify-evidence --input evidence
```

当前公开基线应报告：

```json
{"suite_count": 2, "run_count": 18}
```

还应执行独立文本扫描，确保没有：

- `/Users/<name>/` 或 `/home/<name>/`；
- GitHub、OpenAI、Google 已知密钥前缀；
- 测试密钥 `private-token`；
- `.env`、SQLite、WAL/SHM 或 CLI 认证文件。

摘要验证保护“导出后未变化”，文本扫描保护“导出内容可公开”。两者不能互相替代。

## 8. 质量门禁

| 门禁 | 失败含义 |
| --- | --- |
| Ruff | Python 风格、导入、常见 bug/async 问题 |
| mypy strict | 后端和测试存在类型不确定性 |
| Pytest | 核心领域/API 合同回归 |
| Alembic empty upgrade | 新安装无法建库或迁移头不完整 |
| Evidence verifier | 历史证据缺失、增加或字节变化 |
| ESLint | React hooks 或前端静态规则回归 |
| TypeScript | API/UI 类型合同不一致 |
| Vitest | 关键前端交互回归 |
| Vite build | 生产前端无法生成或引用失败 |

## 9. 依赖和安全检查

发布前额外执行：

```bash
cd frontend
pnpm audit --prod
```

Python 依赖由 `uv.lock` 固定，前端和 Pi bridge 分别由各自的 `pnpm-lock.yaml` 固定；CI 与 `script/verify.sh` 在后端测试前安装锁定的 Pi 运行时。依赖漏洞扫描只能发现已登记 CVE，不证明应用安全；Host/Origin/CSRF、进程隔离、SQL 双层守卫和脱敏仍需行为验证。

## 10. 证据等级

从强到弱：

1. 哈希锁定的真实运行逐案例证据；
2. 真实程序/浏览器/Seatbelt smoke 输出；
3. 使用真实核心服务的 API 集成测试；
4. 领域单元/属性边界测试；
5. 录制 Provider 协议夹具；
6. 前端 mock 组件测试；
7. 文档或源码静态声明。

对外结论必须标明它依赖哪一级。尤其不能用 FixtureAdapter 的 100 分替代真实模型结果。

## 11. 0.4.0 验收

- backend：67 个测试通过，Ruff、mypy、空库 Alembic 升级通过。测试环境仍有 Starlette/httpx 弃用警告，未屏蔽。
- frontend：13 个测试通过，ESLint、TypeScript、Vite 构建通过。
- site：Astro 检查无错误，构建验真为 188 页、2 个历史题库、18 场已公开运行，内部链接通过；未部署。
- v3 真实评测使用 Pi 0.85.1、Luna/Sol 现有订阅、medium、每题每轮一次，不回传错误、不重试、不择优。记录实际 wire 参数、调用次数、工具状态及上下文隔离。
- 真实浏览器已确认新报告业务正确率优先、配置与实际请求分列；1440px 无横向溢出。
- v3 试运行发现累计消费口径未明确，另冻结 v4 澄清订单头存储金额优先。v3 原分和调用保留，不旁路重评分；v4 的参考答案与回归验收不等于模型实测。

## 12. v3 三轮独立诊断记录

运行 #20、#21、#22 均完整结束；每轮两份现有订阅配置、18 题，每题一次，共 108 次生成。三轮均冻结 v3 hash bd6e5a90192057b51f6ab8c37cf7155255b2392368271a417367c1abaaf4c090，未中途切换到 v4。每轮事件均为 36 条 provider.requested 和 36 条 provider.completed，每个案例恰好一条请求。

| 配置 | 三轮金标匹配题数 | 三轮辅助综合分 | 平均分 / 轮间标准差 |
| --- | --- | --- | --- |
| Luna · Pi 订阅 | 17/18、17/18、17/18 | 98.15、96.90、97.32 | 97.46 / 0.52 |
| Sol · Pi 订阅 | 17/18、17/18、17/18 | 98.15、98.98、98.98 | 98.70 / 0.39 |

标准差按这三轮总体描述计算，不作统计显著性推断。两者金标匹配率均为 51/54=94.44%，三轮该比率波动为 0；执行、JSON 和格式均 54/54。唯一业务结果不匹配均在 Q9，来自订单头/明细金额口径歧义，因此不用于判定模型优劣，也不事后删题改分。Q8、Q11、Q15 的其他分差来自辅助 AST 结构项，行结果仍匹配。

全部 108 次调用记录 generation_attempts=1、tool_calls_observed=0、context_isolated=true；实际参数均为 openai-codex/OAuth、180 秒、reasoning medium，输出上限 provider_managed。模型身份仅 requested_catalog，不能证明服务端实际版本。双方总 Token 分别为 198714 与 198793；订阅单题费用未知。

本地完整报告：var/validation-v3-three-rounds.json。逐题 18×2×3 结果、AST 失分、失败类型、统计和解释限制：var/validation-v3-summary.json。这些本地诊断文件未复制到公开 evidence/，未部署。当前 v4 hash addba1a63b88ae88b088c015a8fc0da5563980d3fe47684a32dc97bd48bf0bdb 仅澄清 Q9 来源与嵌套要求；本次没有额外调用模型验证 v4。
