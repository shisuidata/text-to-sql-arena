# 开源前完整审计

审计范围：应用源码、测试、题库、构建产物、SQLite 历史状态、18 次运行、依赖、密钥/路径、迁移、公开证据和 GitHub 发布准备。

状态定义：

- 已解决：代码、测试或仓库结构已修改并验证。
- 已接受：限制真实存在，已明确文档化，不伪装成已解决。
- 待维护者决策：必须由代码权利人确认，不能由自动化审计代选。

## 1. 结论

代码和历史证据已达到可建立公开仓库的技术条件：

- 后端/前端源码和测试完整；
- 2 个发布题库、18 次运行、264 个证据文件已全量导出；
- 公开证据可离线校验，当前为 2 suite / 18 run；
- 证据文本未发现已知密钥模式或用户绝对路径；
- 原始 SQLite、WAL/SHM、CLI Home、认证和二进制 DuckDB 不会进入 Git；
- Python 和 Node 锁定依赖的在线漏洞审计均报告无已知漏洞；
- 评分、隔离、事件和快照的主要审计发现已修复。

发布阻塞已解除：MPL-2.0、仓库名和点风险确认均已完成，初始公开提交 `e6494e4df634` 已推送到 `rockythink/text-to-sql-arena` 的 `main` 分支。

## 2. 审计发现

### A-01 原始运行目录不可公开

- 严重性：Critical
- 原状态：`var/app.db`、WAL/SHM、DuckDB、CLI Home 和健康详情含绝对用户路径、认证上下文或密钥引用。
- 风险：直接提交会泄露个人环境和潜在凭据；原始 DB 也不是稳定公开合同。
- 处理：已解决。
- 变更：
  - `var/` 整体进入 `.gitignore`；
  - 新增 `evidence.py` 全量静态导出；
  - 路径和常见凭据递归脱敏；
  - 原始数据库、CLI Home 和二进制仓库明确排除；
  - 导出后独立扫描没有 `/Users/`、`/home/` 或已知密钥模式。

### A-02 历史报告依赖可变 profile 名称

- 严重性：High
- 原状态：报告通过 `model_profile_id` 读取当前 profile 名称；改名会重写历史叙述。
- 风险：历史报告和截图无法稳定复核。
- 处理：已解决。
- 变更：ModelRun 新增 `profile_name_snapshot`；新运行创建时冻结；exact rerun 复制；历史报告只读快照；集成测试在 profile 改名后验证报告仍保留旧名。
- 历史限制：旧运行名称由迁移时仍关联 profile 回填，这是可恢复元数据，不等于当时原生保存。

### A-03 运行缺少协议和依赖版本快照

- 严重性：High
- 原状态：报告使用当前 app/scorer/DuckDB/SQLGlot 版本，旧运行可能被错误标成新版本。
- 风险：评分可重复性和依赖漂移不可判断。
- 处理：已解决。
- 变更：ComparisonRun 冻结 app/scorer/DuckDB/SQLGlot/output contract；报告和证据只读快照；0.1.0 历史值按已知部署基线回填。

### A-04 Provider request ID 和生成耗时没有持久化

- 严重性：Medium
- 原状态：适配器返回字段，但 CaseRun 丢弃。
- 风险：无法按 Provider 请求追踪，生成耗时证据不完整。
- 处理：已解决（向前）。
- 变更：CaseRun 新增 `provider_request_id` 和 `generation_ms`，成功和可解析失败路径均落库并进入 API/报告/证据。
- 历史限制：旧运行保留 `null`，没有推测填充。

### A-05 `model.started` 被误用为运行启动事件

- 严重性：High
- 原状态：ComparisonRun 启动时发出没有 model ID 的 `model.started`；真正模型启动没有标准事件。
- 风险：事件消费者无法区分 run/model 生命周期，日志和重放语义错误。
- 处理：已解决。
- 变更：新增 `run.started`；每个 ModelRun 启动时发送带 `model_run_id` 的 `model.started`；前端 SSE 类型和集成测试同步。

### A-06 Codex Seatbelt 对用户目录读取过宽

- 严重性：High
- 原状态：策略允许读取项目和 `~/.ssh` 之外的绝大多数文件数据。
- 风险：虽然金标所在项目被拒绝，但 CLI 仍可能读取其他用户文件。
- 处理：已解决。
- 变更：
  - 默认拒绝；
  - 文件数据只允许用户主目录之外的运行时路径；
  - 用户主目录内仅精确放行 Codex 原生二进制和 `~/.codex/auth.json`；
  - 项目与 `~/.ssh` 显式拒绝；
  - 案例临时目录精确读写放行。
- 验证：真实 `sandbox-exec` 下案例文件可读、仓库文件被拒、`codex-cli 0.147.0 --version` 可启动。

### A-07 只有动态 API 报告，没有可提交证据

- 严重性：High
- 原状态：报告必须依赖本地 SQLite 和当前应用进程；GitHub 无静态运行证据。
- 风险：外部审查者无法复核历史，数据库又不适合公开。
- 处理：已解决。
- 变更：
  - `run-report-v1` 统一在线和静态报告；
  - `text-to-sql-evidence-v1` 全量导出；
  - suite/run 逐文件和整包 SHA-256；
  - 篡改、缺失和额外文件检测；
  - 当前已导出 18/18 次运行，包括失败和取消。

### A-08 当前领域枚举阻止历史题库重建

- 严重性：High
- 原状态：`radar_dimension` 被硬编码为 v2 六维 Literal；v1 的“连接语义”等历史值无法通过当前模型校验，首次全量导出失败。
- 风险：应用演进破坏不可变历史。
- 处理：已解决。
- 变更：雷达维度改为题库版本数据（非空、长度限制）；v2 六维平衡由题库测试保护；v1 成功重建且原 content hash 不变。

### A-09 Alembic 忽略应用数据库 URL，兼容桥与迁移冲突

- 严重性：High
- 原状态：`alembic.ini` 固定 `var/app.db`，测试环境变量不生效；早期 `ensure_schema()` 已加列时，新迁移会 duplicate column。
- 风险：迁移测试误改真实数据库；现有安装无法正确升级盖章。
- 处理：已解决。
- 变更：Alembic 使用 `settings.database_url`；0.2.0 迁移按列存在性执行；空库升级和现有 DB 升级均已验证到 `c4e8b9f7a102`。

### A-10 运行原始输出和错误路径缺少统一落库脱敏

- 严重性：High
- 原状态：EventWriter 脱敏，但 CaseRun 的 raw output、plan、summary、错误、Token 元数据不都经过同一处理。
- 风险：本地 DB 之后导出时可能传播 Provider 密钥片段。
- 处理：已解决。
- 变更：成功/失败落库路径统一调用 `redact_secrets`；公开导出再做第二层路径/密钥脱敏；测试在 Provider 错误中注入假密钥并验证历史、导出都不泄漏。

### A-11 Python strict typing 和 React hooks 静态告警

- 严重性：Medium
- 原状态：mypy 3 个错误；RunLivePage effect 缺少稳定函数依赖。
- 风险：CI 无法作为可信门禁；history 查询可能使用陈旧闭包。
- 处理：已解决。
- 变更：修复测试类型收窄和返回类型；`queryFor` 改为 `useCallback`；Ruff/mypy/ESLint/TypeScript 均通过。

### A-12 未使用的 OpenAPI 生成入口

- 严重性：Low
- 原状态：package 声明 `openapi-typescript` 和生成脚本，但无生成文件、客户端也不使用生成类型。
- 风险：增加依赖面，制造不存在的开发流程。
- 处理：已解决。
- 变更：删除脚本和依赖，保留当前手写客户端合同；锁文件刷新。

### A-13 题库和金标通过作者 API 可见

- 严重性：Medium
- 原状态：`GET /api/suites` 是完整本地管理接口，包含作者所需参考信息。
- 风险：若把应用误当成不可信多用户远程评测服务，参赛者可读取答案。
- 处理：已接受并明确边界。
- 理由：产品是本地作者工具，题库本来要开源；公平性来自“模型实际 Prompt 和 CLI 运行时不含答案”，不是对本机操作者保密。
- 防误用：文档明确应用不是多用户/公网竞赛服务器；实际 Prompt 全量公开可审查。

### A-14 自动化 UI 证据不是浏览器 E2E

- 严重性：Medium
- 原状态：6 个前端测试使用 jsdom 和 mock API。
- 风险：可能错误宣称完整 E2E。
- 处理：已接受并明确边界。
- 补充：发布前执行生产构建和真实浏览器 smoke；文档不称现有测试为 E2E。

### A-15 上游测试和工具警告

- 严重性：Low
- 状态：已接受。
- 详情：
  - Starlette TestClient 发出向 `httpx2` 迁移的上游 deprecation warning；测试不受影响。
  - pnpm 解析的 ESLint 9.39.5 标记生命周期结束，但当前 TypeScript ESLint 兼容范围仍在 9.x；没有已知漏洞。升级 ESLint 10 需要整套兼容性迁移，不在本次开源切片中。
  - `whatwg-encoding` 是 jsdom 的已弃用传递依赖；仅开发测试使用，没有已知漏洞。

### A-16 缺少许可证

- 严重性：发布阻塞 / 法律
- 状态：已解决（权利人决策）。
- 原风险：没有 `LICENSE` 时，GitHub 可见不等于开源，第三方默认没有复制、修改或分发许可。
- 变更：维护者选择 MPL-2.0；写入的标准文本已与 Mozilla 官方许可页和 SPDX License List 交叉核对，SHA-256 为 `66a3107d5ad6a058aab753eaac2047ccb2ed0e39465dd0fe5844da3e300d5172`。
- 范围：README 明确覆盖仓库内原创代码、测试、文档、题库、历史报告、日志与证据；第三方依赖和字体继续适用各自许可证。

### A-17 报告页生产分包超过 Vite 默认提示线

- 严重性：Low / 性能预算。
- 状态：已接受并记录。
- 事实：生产构建的 `ReportPage` chunk 为 580.92 kB minified / 198.05 kB gzip，超过 Vite 默认 500 kB 提示线；其余路由 chunk 均低于提示线。
- 评估：报告页已经路由级懒加载，ECharts 已使用 `echarts/core`、按需 chart/component 和单一 SVG renderer，不会进入首屏 chunk。继续拆分会增加图表加载状态与缓存边界，当前收益不足。
- 门禁：构建成功；警告未被调高阈值掩盖。未来新增报告图表时应重新审视 gzip 预算。

### A-18 手机宽度不是受支持界面

- 严重性：Low / 支持范围。
- 状态：已接受并公开说明。
- 事实：生产页面在 1024px 和 768px 视口无横向溢出；390px 视口的 document scroll width 为 631px，模型卡、设置栏和启动区仍保留工作台最小宽度。
- 决定：该产品包含 Monaco、SQL 结果表、事件工作区和多图报告，是桌面/平板本地工作台；本版本不承诺手机布局。README 明确最低已验证宽度，避免把现有局部 media query 误读为手机支持。

### A-19 模型卡片脚注样式未跟随类名迁移

- 严重性：Low / UI 可读性。
- 原状态：JSX 使用 `model-card-foot`，CSS 仍只定义已删除的 `model-meta`，状态徽标与“响应”文本无间距贴连。
- 处理：已解决。
- 变更：完整迁移六处 CSS selector，删除废弃类路径；生产构建后实测为 flex/center/10px gap，并以截图确认无遮挡。

## 3. 依赖审计

### Python

- 权威锁：`uv.lock`。
- 生产依赖在线审计命令：

```bash
uv export --frozen --no-dev --format requirements-txt \
  | uvx pip-audit -r /dev/stdin --no-deps --disable-pip
```

- 结果：`No known vulnerabilities found`。
- 首次默认 pip-audit 模式因当前 Darwin/Python `ensurepip` 子进程 SIGABRT 失败；改用完整锁导出、禁用 pip 解析后审计成功。失败过程不是“无漏洞”证据，第二次成功输出才是。

### Node

- 权威锁：`frontend/pnpm-lock.yaml`。
- `pnpm audit --prod`：No known vulnerabilities found。
- `pnpm audit`：No known vulnerabilities found。
- 未使用的 `openapi-typescript` 已删除；`@testing-library/jest-dom` 固定到兼容的 6.9.1。

### 许可证

- Python 直接依赖元数据主要为 MIT/BSD/Apache；aiosqlite 和 DuckDB 分发包包含许可证文件，但元数据 License 字段不完整。
- Node 生产依赖许可证统计未发现 copyleft 冲突；主要为 MIT、Apache-2.0、ISC、BSD-3-Clause 和 0BSD。
- 三个字体均随源和生产构建提交对应 OFL 文本。
- 详见 `THIRD_PARTY_NOTICES.md` 和锁文件；此审计不是法律意见。

## 4. 密钥与隐私审计

### 源码扫描

未发现：

- GitHub token；
- OpenAI `sk-*`；
- Google `AIza*`；
- 明文 Authorization Bearer；
- `.env` 内容；
- 硬编码用户绝对路径。

### 原始数据库扫描

- 未发现实际已知密钥模式。
- 发现 99 处绝对用户路径，主要来自 CLI health/isolation 快照；因此原始 DB 明确不公开。

### 公开证据扫描

- 4.7 MB，264 个文本文件（生成 README 前统计；README 不进入 bundle）。
- 未发现 `/Users/`、`/home/`、GitHub/OpenAI/Google 密钥模式或测试假密钥。
- 摘要校验：2 suite、18 run。

## 5. 测试可信度审计

强证据：

- 题库内容哈希和全金标重建；
- 18 个 reference query 走完整评分为 100；
- SQL AST + 独立只读 Worker；
- 结果比较边界；
- 四种录制 Provider 协议；
- 双模型状态机、取消、SSE 续传、exact rerun、报告快照；
- 真实 Seatbelt 文件边界和 Codex 二进制启动；
- 全量证据导出与主动篡改检测。

有限证据：

- API 集成模型是 FixtureAdapter，不能证明真实模型质量；
- 前端测试是 mock/jsdom，不是 E2E；
- 历史运行 attempts 多为 1，不支持显著性结论；
- 公开 benchmark 无法排除训练污染。

## 6. 公开仓库边界

应提交：

- `backend/`、`frontend/`、`alembic/`、`tests/`；
- `uv.lock`、`pnpm-lock.yaml`；
- 生产前端 `backend/app/static/`；
- `evidence/` 全部公开证据；
- 方法、合同、测试、审计、安全和贡献文档；
- 许可证（待选择）；
- CI/Dependabot 配置。

不得提交：

- `var/`；
- `.venv/`、`node_modules/`、Python/TS 缓存；
- `.env*`；
- Keychain/CLI 认证文件；
- 本地 DB 备份；
- 未脱敏的临时日志或截图。

## 7. 发布前最后步骤

- [x] 维护者选择 MPL-2.0。
- [x] 维护者选择 `rockythink/text-to-sql-arena`。
- [x] 写入标准 `LICENSE` 并更新 README、贡献指南和审计状态。
- [x] 完成全套验证、生产构建、证据校验、暂存边界与敏感模式扫描。
- [x] 在实际执行 GitHub public create/push 前完成点风险确认，并按确认范围公开推送。

## 8. 公开发布验证

- 初始公开仓库为 `rockythink/text-to-sql-arena`；当前规范地址为 <https://github.com/shisuidata/text-to-sql-arena>。可见性 `PUBLIC`，默认分支 `main`。
- 初始公开提交：`e6494e4df634b2bf7c4df0467000939ca88ffe47`。
- 远端 README、标准 MPL-2.0 `LICENSE` 和 `evidence/index.json` 均已读取验证；远端证据索引声明 `text-to-sql-evidence-v1`、2 suite / 18 run。
- 远端 `LICENSE` SHA-256：`66a3107d5ad6a058aab753eaac2047ccb2ed0e39465dd0fe5844da3e300d5172`，与本地和 SPDX 标准文本一致。
- GitHub Actions 初始提交 CI：<https://github.com/rockythink/text-to-sql-arena/actions/runs/33297542769>，结论 `success`。
