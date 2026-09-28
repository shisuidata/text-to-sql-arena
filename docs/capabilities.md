# 能力清单

本文描述 `0.4.0` 的可观察能力。实现入口和验证方式同时列出，避免把计划、UI 文案或测试替身误写成已实现能力。

## 1. 模型配置

### 已实现

- 创建、修改、软删除和列出模型配置。新建配置只能使用 `adapter_kind=pi` 与 `response_mode=text`；旧 `openai_compatible`/CLI 配置保持可见和可删除，但不能执行本地就绪检查或进入新运行。
- 参数包含 `provider`、`auth_mode`（`oauth` 或 `api_key`）；界面固定 `timeout_seconds=180`。`reasoning_effort` 选项直接取 Pi 模型能力；Codex 协议不发送 `max_tokens`，其他受支持协议可配置输出上限。
- 配置页默认只展示当前 Pi `enabledModels` 中的模型，按锁定内置目录和本机 `models.json` 解析 Provider、协议、默认端点与能力，支持搜索；没有启用名单时只展示默认模型和声明式自定义模型，不回退完整目录。仅由扩展注册而无法安全解析的显式模型保留为不可用项，不加载扩展。认证方式来自目录 Provider 的 API Key/OAuth 能力，不代表账号已取得权限。`openai-codex` 为 OAuth-only，不允许改变订阅端点，凭据只读本机 Pi 凭据文件（`~/.pi/agent/auth.json`，`openai-codex` 同时考虑既有 `~/.codex/auth.json`），评测台不刷新。
- 本机 `~/.pi/agent/models.json` 声明式自定义模型随锁定目录解析，选择后保存规范化 `parameters.custom_model`。仅保留连接与能力白名单；`apiKey` 不导入，`!` 命令与环境插值不执行，提示词/工具/扩展不加载。三项 Completions 布尔兼容字段 `supportsStore`、`supportsDeveloperRole`、`supportsReasoningEffort` 可保留；自定义 headers、动态 OAuth、samplingParams 和其他兼容语义标为不支持，不静默替换协议。运行冻结解析后的定义，原文件后续变化不影响已保存配置或历史快照。
- API Key 凭据只来自本机 Pi：`auth.json` 有该 Provider 的 `type=api_key` 条目时，评测台只保存 `pi-auth:<provider>` 引用，运行时读取凭据文件，不复制、不落盘，HTTP/API 输出不返回明文；该 provider/model 能在 Pi 目录解析出服务端地址时，该地址不可覆盖（覆盖即拒绝保存）。本机环回端点（localhost/127.0.0.1/::1）且 Pi 无凭据时不发送凭据，`secret_backend=none`。`GET /pi/credentials` 只披露 Provider 与凭据类型的存在性，不返回值。OAuth 凭据同样只读 Pi 凭据文件，评测台不刷新；过期或缺失时报错要求先回 Pi 刷新登录。
- 可选配置 USD/百万 Token 的输入、缓存输入、缓存写入和输出价格及来源/生效日期；运行创建时冻结价格快照。
- “检查本地配置”只验证本地 catalog、凭据、参数、Pi harness/bridge/policy 与隔离详情；不调用模型、不消耗生成，也不证明 Provider 可用。
- 运行创建前要求所选配置启用、属于 Pi 且本地就绪检查仍有效。

### Pi 调用行为

| 层 | 当前合同 |
| --- | --- |
| Node bridge | `runtime/pi` 固定 `@earendil-works/pi-ai` 0.85.1；stdin/stdout 传输单次请求和结果 |
| Prompt | 使用评测引擎生成的固定 Prompt；单轮，不自动加载个人配置或会话；显式导入只使用已校验的模型定义快照 |
| 工具与重试 | 工具关闭、工具数 0、生成尝试上限 1；本地就绪检查不生成内容（实际计数 0），运行调用保存实际计数 |
| 输出 | Pi 返回文本后进入现有 `query-plan-v1` 严格解析和 SQL 评测链路 |
| OAuth | 按 Pi Provider 的认证能力展示；`openai-codex` 为 OAuth-only；凭据只读 `~/.pi/agent/auth.json`（`openai-codex` 同时考虑既有 `~/.codex/auth.json`，取较新者），评测台不刷新，过期回 Pi 刷新登录；订阅端点不可覆盖 |
| API Key | 仅 Pi 目录受支持模型（含本机声明式定义）；凭据为 `pi-auth:<provider>` 引用，运行时读本机 `auth.json`，环回端点无凭据时不发送凭据；只有当前案例 Prompt 和调用参数离开进程，目录与定义元数据不进入厂商请求 |

每次真实调用在 `provider.requested` wire payload 与 `provider.completed` 证据中保存请求/解析模型身份、Provider request ID（若返回）、Token（若返回）、生成耗时、凭据来源（`credential_source`：`pi_auth_file` / `codex_auth_file` / `local_no_auth`；历史运行快照中的旧取值只读保留、不重算）和不含凭据的有效控制快照。已完成一次受控订阅 smoke：Pi 0.85.1、`openai-codex/gpt-5.6-luna`、使用既有 Pi 订阅登录凭据、单次请求、无工具，严格 JSON 中的 SQL `SELECT 1` 执行得到 `[(1,)]`；生成 2839 ms，usage 为 381 input / 66 output。该 smoke 没有创建 benchmark run 或历史记录，也不证明其他远端 Provider 已测试。

## 2. 只读题库与离线构建

- 产品仅展示随应用提供的已发布题库、版本、题意、维度、难度和内容哈希，供测评选择与结果复核。
- 内置题库展示为“零售分析 SQL 题库”，版本号独立展示；内部标识 `retail-analytics-v1` 保持不变。
- 不提供题库创建、复制草稿、源文件编辑、校验发布或挑战自检的 Web UI/HTTP API。已有草稿保留在本地数据库，但不出现在题库目录或测评选择中。
- 雷达维度仍是不可变题库版本数据，历史版本可保留旧维度；已发布版本的 Prompt 预览 API 继续只读开放。

维护者的离线构建与应用 bootstrap 仍负责 Pydantic 源合同校验、执行 Schema/固定 Seed、提取结构、执行参考 SQL 生成金标、计算 SHA-256 并保存内容寻址产物。发布前回归验收另用完整评分器验证参考答案；构建本身不是模型能力测试。

已发布版本不可原地修改。维护源数据变化必须产生新哈希和新版本，不改写旧题库或历史证据。固定数据变体挑战检查保留为内部质量验证能力，不作为用户产品入口。

## 3. 内置 Retail Analytics 题库

### v4（当前，scorer 2.0.0）

- 18 个案例。
- 6 个雷达维度，每个维度 3 题：
  - 基础查询
  - 连接与粒度
  - 聚合与指标
  - 时间与窗口
  - 复杂查询
  - 数据开发
- 难度：3 easy、10 medium、5 hard。
- 固定数据包括 123 位客户、39 个商品、5 个渠道、617 个订单；覆盖空月/零收入、原始均值精度、金额分档端点、重复退货、pending 支付、无销量品类及无明细/非完成对账异常。v2 的 120/36/5/604 原样保留，不重建历史金标。
- 案例覆盖筛选、连接、聚合、反连接、窗口、CTE、条件聚合、多事实表预聚合和数据质量检查。

### v1（历史）

- 12 个案例。
- 仍可由数据库中的历史源完整重建。
- 源、金标和历史运行均在 `evidence/` 中发布。

## 4. 运行编排

- 选择 1–6 个已启用且健康的 Pi 模型；历史适配器不可选择。
- 选择全部案例或案例子集。
- 新运行每个案例固定执行 1 次；API 也拒绝其他 attempts 值。
- 模型按运行快照执行，运行中修改配置不改变已创建运行。
- 每个模型内部按案例顺序执行；模型之间可并发。
- 取消请求传播到 Pi bridge 和后续案例。
- 应用启动时把意外遗留的运行恢复为 `interrupted`，避免永久停在 `running`。
- `exact` 复跑复制原题库哈希、模型名、适配器、模型 ID、参数、价格和隔离快照；历史运行仍按原快照解释，不被迁移为 Pi。
- `current` 复跑重新读取当前模型配置；只有满足当前 Pi 合同的配置才能创建新运行。
- 新建运行前执行只读预检：验证题库、Pi profile、案例、固定单次尝试、本地就绪检查有效期和价格完整性；不调用模型、不创建记录。
- 预检历史估算只使用同题库、所选案例且模型/adapter/Provider/认证/参数/响应合同/bridge 版本一致的样本；缺证据不编造数字。
- `failed` 补跑取所有参赛模型失败、未完成或未满分案例的有序并集，再让同组模型公平比较同一子集；空子集返回 409，进行中运行禁止补跑。
运行状态：

- ComparisonRun：`pending`、`running`、`cancelling`、`completed`、`completed_with_errors`、`cancelled`、`failed`、`interrupted`。
- ModelRun：`pending`、`running`、`completed`、`completed_with_errors`、`cancelled`、`failed`。
- CaseRun：`pending`、`running`、`completed`、`failed`、`cancelled`。

## 5. Prompt 与模型输出

- Prompt 由发布版本的模板、结构快照、语义层、问题和 JSON 输出合同构成。
- Prompt 不包含参考 SQL、金标结果或必需 AST 规则。
- 实际 Prompt 在运行前持久化，并随案例证据公开。
- `query-plan-v1` 要求模型输出：
  - `plan.grain`
  - `plan.sources`
  - `plan.joins`
  - `plan.filters`
  - `plan.metrics`
  - `plan.steps`
  - `plan.risks`
  - `sql`
  - `summary`
  - `assumptions`
- 严格 JSON 得到协议分；仅允许恢复“单层、无前后文本”的 `json` Markdown fence。其他文本判输出合同错误。

## 6. SQL 守卫和执行

### 静态守卫

- DuckDB 方言解析。
- 只能有一条语句。
- 根节点必须是 SQLGlot `Query`。
- 禁止写入、DDL、事务、附加数据库及其他危险 AST 节点。
- 禁止 `read_*`、`*_scan` 和已知外部访问函数。
- 禁止非 `main` schema/catalog。
- 只允许发布快照中的表或当前查询定义的 CTE。

### 运行时隔离

- 使用 `multiprocessing spawn` 独立进程。
- DuckDB 以 `read_only=True` 打开。
- `enable_external_access=false`。
- `threads=1`、`memory_limit=512MB`、`TimeZone=UTC`。
- 默认 5 秒执行超时。
- 每案例按合同限制最大结果行数；内置题库上限不超过 10,000。
- 超时先 terminate，仍存活再 kill。

## 7. 结果比较

- 数值转 Decimal 保留全精度，不以 decimal_scale 先舍入；12=12.0，但12.4不等于12。
- 金标整数列精确比较；非整数列支持绝对和相对容差，取两者较大值。
- 日期按 ISO，时间戳转 UTC 微秒，字符串做 Unicode NFC。
- 保留 NULL、布尔类型和重复行语义。
- 列名去引用符、大小写折叠；同名集合可按名称重排。
- 名称不足以对齐时，先精确指纹、再类型/容差二分图唯一匹配；歧义失败，不猜测。
- 行比较是多重集最大匹配，不把重复行折叠为集合。
- 无顺序要求时，F1=1 即顺序项通过；有顺序要求时逐行比较。
- 保存 expected/actual digest、匹配数、precision、recall、F1、缺失和额外行预览。

## 8. SQL 能力规则

可发布在案例中的 AST 规则：

- 最少 Join/Case 节点数；
- LEFT JOIN 类型；
- 相关子查询；
- NOT EXISTS；
- 窗口函数名称、分区和排序；
- 查询深度；
- CTE 数量；
- SUM 条件聚合数量；
- 两个事实度量先分别预聚合再连接。

规则只用于辅助评分，不进入模型 Prompt。窗口按作用域来源识别，预聚合按事实来源/度量/分组和消费关系识别，不强制表别名或 CTE 名；来源不同及事实放大仍拒绝。

## 9. 评分与报告

- 每案例固定 100 分公式，见 [methodology.md](methodology.md)。
- 多次尝试保存 mean、nonzero_score_rate 和总体标准差；非零得分率不等于结果正确率。
- 模型总分按案例 `weight` 加权平均。
- 分类/雷达维度分数按同一权重规则聚合。
- 报告包含独立的结果正确、执行成功、协议通过、覆盖率、关键回合与逐题解释；所有计划尝试进入分母。
- 新 Pi 多模型运行标为 `controlled_harness`：统一的是 Pi harness、文本响应、单轮/无工具/无重试和 Prompt 合同；Provider、认证、模型身份和显式生成参数仍逐项披露。这不表示同一端点或同一模型。
- 新 Pi 单模型运行仍标为 `single_model`。
- 历史报告保留原 `pure_model`、`access_path` 或 `single_model` 标签及原始字段，不回写为新分类。

## 10. 实时事件与查询工作区

- 19 种有类型事件，先持久化再推送。
- 每个运行的 `seq` 单调递增。
- SSE 支持 `after_seq` 断线续传，并用持久化历史补齐订阅水位线前后的竞态。
- 历史接口支持模型、案例、级别、事件类型、搜索词、offset 和 limit 筛选。
- Provider delta 以 250 ms 缓冲，避免逐 token 写库。
- 实时页默认以「模型输出」按模型和案例连续拼接片段，每栏独立选题或跟随最新题目；请求等待、生成、完成、失败和取消状态可见。深色阅读视图在 JSON 尚未完成时解码已收到的字段，展示规划、SQL、说明、假设，保留换行与缩进；可切换原始文本逐字核对，未知或不支持的格式不丢弃内容。耗时实时更新，Token 只展示已返回统计，不估算未返回用量。上滚暂停跟随但继续接收；深色「事件日志」保留筛选、虚拟化和原始明细，摘要保留空白且不截断。底层引擎身份留在技术信息中，不作为主界面品牌。
- 首次读取按 after_seq 分页补齐全部历史，再从真实尾序号接续 SSE；重放去重，终态停止重连，历史失败可手动重试。状态轮询失败不遮挡已接收输出；刷新、失败和取消保留片段。诊断只展示已脱敏的结构化事件，不透传进程 stderr 或个人 Pi 会话。
- 案例工作区展示规划、SQL、执行结果、差异和评分；参考 SQL/金标必须显式请求后才返回。

## 11. 报告与证据导出

- 新 scorer 2.x 动态报告为 run-report-v4/result-quality-v2：业务结果与格式/政策/执行错误分开，资源按实际正确题归一；逐题实际调用证据与预检配置分开。历史 scorer 1.x 保留 v3/v1，已发布旧报告不改写。
- Web UI 下载当前运行报告 JSON；单场完整证据使用预览/确认导出，CLI 仍支持全量导出。
- `text-to-sql-evidence-v1`：公开证据目录合同。
- 所有已发布题库和所有持久化运行全量导出。
- 逐文件 SHA-256 与目录 `bundle_sha256`。
- 校验器发现缺文件、新增未登记文件或摘要变化即失败。
- 导出器脱敏常见 Provider 密钥、Authorization、项目根目录、用户主目录和应用临时路径。
- 不导出原始 SQLite、WAL/SHM、Keychain 等密钥存储值（仅历史数据可能存在）、Pi 凭据文件或二进制 DuckDB；DuckDB 可由公开 Schema/Seed 确定性重建。
- 终态运行可先只读预览脱敏报告、清单摘要和警告，再以预览摘要显式确认导出仅该运行和所属题库版本的 ZIP。
- “确认并导出发布包”只生成临时下载文件：不替换 `evidence/`，不复制 SQLite，也不代表内容已经上线或完成公网部署。
## 12. Web UI

- 模型配置、价格快照和健康状态。
- 只读题库说明：友好名称、独立版本号、最新发布版、题目范围及内容哈希；无草稿或编辑入口。
- 新建评测支持浏览器本地方案、题目子集与只读预检；本地就绪检查失效时不能开始运行。
- 实时页展示真实业务题意、全部作答与持久化日志；终态停止事件订阅，不持续重连。
- 报告分“结果概览 / 逐题分析 / 配置与证据”；题目得分差异按全部计划尝试和题目权重计算，历史回放明确标识为回放。
- 匿名预测显示结果前不展示身份、排名或分数；预测不计分。公开站关键题竞猜仅保存在浏览器，不生成票数。
- 对照先核验题库、案例、attempts、协议、工具版本、endpoint 指纹和隔离控制；不一致时不输出进退结论。
- 复测支持精确/当前配置、全部/失败未满分子集；导出发布包不代表部署。
- 统一采用 Shisui Design System，不提供深浅色切换：暖白页面、深海蓝标题与主按钮、麦穗金核心操作；宋体标题、黑体正文、等宽数字。主要正文 16px、辅助信息 14px，保留焦点可见与 reduced-motion。
- 录屏模式只隐藏导航，保存在当前 tab 的 sessionStorage；方案保存在 localStorage，不包含密钥。
- `frontend/src/tokens.css` 随项目保存官方品牌令牌，来源为 Hub 的 `shisui-design-system/cards/tokens.css`。报告、提示框及 SQL 证据对照共用这些令牌；品牌字体随本地静态资源分发。

## 13. 明确不支持

- 多用户账号、RBAC、团队隔离或公网部署安全模型。
- 云端队列、分布式 Worker 或多机并发。
- 除 DuckDB 外的执行方言。
- 自动化浏览器 E2E 测试；当前 UI 有 Vitest/Testing Library 测试和真实浏览器 smoke 验证。
- 基于单次运行的统计显著性声明。
- 防止公开题库被训练数据污染。
- Provider 实际账单、CLI 包月成本分摊、能耗、端到端网络延迟或吞吐排名。
