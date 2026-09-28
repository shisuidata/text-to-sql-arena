# 安全策略

## 支持范围

| 版本 | 状态 |
| --- | --- |
| 0.2.x | 接受安全修复 |
| 0.1.x | 仅作为历史证据保留，不再修复 |

## 威胁模型

SQL 擂台是单用户、本地优先的评测工具，默认只绑定 `127.0.0.1`。它不是多租户服务，也不应直接暴露到公网。

核心安全边界：

- 评测台不持有凭据：凭据由本机 Pi 管理（`~/.pi/agent/auth.json`，0600 明文；`openai-codex` 可用既有 `~/.codex/auth.json`），信任边界下移到 Pi；评测台只保存 `pi-auth:<provider>` 引用，运行时只读、不复制、不写入、不刷新，密钥值不进入 profile、事件或公开证据；
- 模型不接收 reference SQL、gold result、金标 AST 或评分答案；
- SQL 先经过 SQLGlot 只读 AST 守卫，再在独立进程的只读 DuckDB 中执行；
- Codex CLI 在 macOS Seatbelt 中运行，项目、SSH 目录和默认用户文件读取被拒绝；
- Claude/Gemini CLI 关闭工具能力；
- 非 loopback 绑定必须显式设置 `LLM_TEST_ALLOW_LAN=1`；这不会自动增加认证、授权或租户隔离；
- Host、Origin 和状态变更请求的 CSRF 规则在应用层校验；
- `var/` 是私有本地状态，不属于公开证据。

已知边界和残余风险见 [docs/architecture.md](docs/architecture.md) 与 [docs/open-source-audit.md](docs/open-source-audit.md)。

## 报告漏洞

公开仓库建立后，请在 GitHub 仓库的 **Security → Report a vulnerability** 中提交私密报告。请勿把未脱敏的漏洞细节、密钥、数据库、用户路径或 Provider 响应发布为公开 Issue。

报告应包含：

1. 受影响版本和操作系统；
2. 最小复现步骤；
3. 实际结果与预期边界；
4. 影响范围；
5. 已脱敏的日志或概念验证；
6. 建议修复（如有）。

维护者会先确认收到，再复现、评估影响、准备修复和发布说明。没有固定响应 SLA；高危凭据泄露、隔离绕过和任意写入会优先处理。

## 不应提交的材料

- `var/app.db`、WAL/SHM 或备份；
- CLI Home、`auth.json`、Keychain 导出；
- `.env`；
- 未脱敏的完整 Provider 请求/响应；
- 可以识别个人设备、账号或文件系统的路径。

公开复核只使用 `evidence/` 中经过双层脱敏并由 SHA-256 清单锁定的材料。
