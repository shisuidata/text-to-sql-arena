# 贡献指南

## 开发原则

1. 结果必须可复核：功能行为、运行快照和证据合同优先于界面包装。
2. 不在模型 Prompt 中泄露 reference SQL、gold result、金标 AST 或评分答案。
3. 不降低 SQLGuard、Worker、CLI sandbox、Host/Origin/CSRF 或脱敏边界。
4. 发布过的题库不可就地修改。规则或数据变化必须创建新版本并生成新 content hash。
5. 历史未知字段保持 `null` 或明确标为回填；禁止推测补齐。
6. 新公共合同要有行为测试和文档，废弃合同要一次性迁移所有调用者。

## 本地环境

要求：Python 3.12、uv、Node.js 22、pnpm 10。

```bash
uv sync --frozen
cd frontend
pnpm install --frozen-lockfile
cd ..
```

启动：

```bash
uv run python -m backend.app.cli serve
```

## 提交前验证

执行完整门禁：

```bash
./script/verify.sh
```

它会执行：

- Python 锁文件安装；
- Ruff；
- strict mypy；
- 后端测试；
- 空 SQLite 数据库升级到 Alembic head；
- 全部公开证据验真；
- pnpm 锁文件安装；
- ESLint；
- TypeScript 检查；
- Vitest；
- 生产前端构建。

测试必须保护可观察合同和真实边界，不要只断言内部调用或源文本。

## 修改题库

- 题库源由 `schema_sql`、`seed_sql`、`semantic_model`、`prompt_template`、`cases` 和 builder/protocol 版本组成；
- `content_hash` 覆盖所有组成部分；
- 每个 reference query 必须在构建时成功并固化 gold result；
- 新题库必须包含边界测试：只读性、确定性、顺序语义、重复行、NULL、时间/Decimal 或该领域等价风险；
- 题库维护属于代码/离线构建流程，不提供 Web 草稿编辑或发布 API。修改维护源后生成新内容哈希并由 bootstrap 导入新版本，不改已发布版本或旧 evidence。

## 修改评分或比较器

- 先写能在旧实现失败的行为测试；
- 更新 scorer/protocol version；
- 更新 `docs/methodology.md`、`docs/contracts.md` 和相关能力文档；
- 不把旧运行重算成新规则结果。新规则必须产生新运行或清楚区分的派生报告。

## 添加模型适配器

适配器必须：

- 接收已冻结的 `AdapterRuntimeConfig`；
- 返回 `AdapterResponse`，包括原始输出、解析数据、耗时和可用的 Provider request ID；
- 提供录制协议 fixture，覆盖成功、事件流、错误和不完整响应；
- 明确真实模型 ID、传输层和工具能力；
- 对 CLI 给出可执行的隔离策略；没有可靠隔离时不得标记为 pure-model comparison；
- 不把密钥值写入日志、事件、数据库或错误消息。

## 数据库迁移

```bash
uv run alembic revision -m "描述"
uv run alembic upgrade head
```

迁移需要同时覆盖：

- 从当前公开版本升级；
- 早期兼容桥已创建部分列的现有安装；
- 空数据库从 base 升到 head。

不得修改已经发布的 Alembic revision。

## 公开证据

只有在运行或题库证据确实变化时才重新导出：

```bash
uv run python -m backend.app.cli export-evidence --output evidence
uv run python -m backend.app.cli verify-evidence --input evidence
```

导出会全量替换 `evidence/`。提交前检查 diff，确认：

- 失败和取消运行没有被丢弃；
- `null` 历史字段没有被伪造；
- 没有用户绝对路径或凭据；
- bundle manifest 与文件一致；
- `docs/historical-runs.md` 的结论仍准确。

不要提交 `var/`、本地 DB、CLI Home 或二进制 DuckDB。

## Pull Request

PR 应包含：

- 问题和用户可观察行为；
- 设计决定与安全/公平性影响；
- 新增或修改的合同；
- 实际运行的验证命令及结果；
- 如有 UI 变化，提供真实浏览器验证说明；
- 如有 evidence 变化，说明原因和 run/suite 数量。

一个 PR 只解决一个清晰问题。避免顺手抽象、兼容别名和未使用脚手架。

## 贡献许可

提交贡献即表示你有权提交该内容，并同意按 [Mozilla Public License 2.0](LICENSE) 对贡献授权。第三方代码、字体、数据或其他材料必须保留原许可证与归属声明。
