# 第三方声明

本项目依赖第三方开源软件，并随本地工具前端分发四种字体。各第三方组件仍受其各自许可证约束；项目根许可证不会替代这些许可证。

版本以 `uv.lock` 和 `frontend/pnpm-lock.yaml` 为准。下表记录本次开源审计时解析到的直接生产依赖；传递依赖及其精确版本见锁文件和安装包元数据。

## Python 直接生产依赖

| 包 | 锁定版本 | 许可证 |
| --- | ---: | --- |
| aiosqlite | 0.22.1 | MIT（分发包 `LICENSE`） |
| Alembic | 1.19.1 | MIT |
| DuckDB | 1.5.5 | MIT（分发包 `LICENSE`） |
| FastAPI | 0.141.1 | MIT |
| HTTPX | 0.28.1 | BSD-3-Clause |
| Pydantic | 2.13.5 | MIT |
| python-multipart | 0.0.32 | Apache-2.0 |
| PyYAML | 6.0.3 | MIT |
| SQLAlchemy | 2.0.52 | MIT |
| SQLGlot | 30.17.0 | MIT |
| Uvicorn | 0.52.4 | BSD-3-Clause |

## Node 直接生产依赖

| 包 | 锁定版本 | 许可证 |
| --- | ---: | --- |
| @monaco-editor/react | 4.7.0 | MIT |
| @radix-ui/react-dialog | 1.1.23 | MIT |
| @radix-ui/react-progress | 1.1.16 | MIT |
| @radix-ui/react-select | 2.3.7 | MIT |
| @radix-ui/react-tabs | 1.1.21 | MIT |
| @radix-ui/react-tooltip | 1.2.16 | MIT |
| @tanstack/react-query | 5.102.8 | MIT |
| @tanstack/react-table | 8.21.3 | MIT |
| @tanstack/react-virtual | 3.14.10 | MIT |
| @xyflow/react | 12.11.5 | MIT |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| clsx | 2.1.1 | MIT |
| Apache ECharts | 6.1.0 | Apache-2.0 |
| lucide-react | 0.542.0 | ISC |
| monaco-editor | 0.52.2 | MIT |
| React | 19.2.8 | MIT |
| react-dom | 19.2.8 | MIT |
| react-router-dom | 7.18.3 | MIT |
| Sonner | 2.0.8 | MIT |
| tailwind-merge | 3.6.0 | MIT |
| Zustand | 5.0.15 | MIT |

## 字体

字体源文件和生产构建副本均保留对应的 SIL Open Font License 1.1 全文：

| 字体 | 文件 | 声明 |
| --- | --- | --- |
| Noto Sans SC | `noto-sans-sc.woff2` / `OFL-Noto-Sans-SC.txt` | SIL Open Font License 1.1；原分发许可文本随文件保留 |
| Noto Serif SC | `noto-serif-sc.woff2` / `OFL-Noto-Serif-SC.txt` | SIL Open Font License 1.1；600 字重，Google Fonts 原字体转为 WOFF2 |
| IBM Plex Sans | `ibm-plex-sans-regular.woff2`、`ibm-plex-sans-semibold.woff2` / `OFL-IBM-Plex-Sans.txt` | SIL Open Font License 1.1；400、600 字重，Google Fonts 原字体转为 WOFF2 |
| JetBrains Mono | `jetbrains-mono.woff2` / `OFL-JetBrains-Mono.txt` | SIL Open Font License 1.1；400 字重，Google Fonts 原字体转为 WOFF2 |

源目录：`frontend/public/fonts/`。生产副本：`backend/app/static/fonts/`。

## 获取完整许可证

- Python：安装后查看各 distribution 的 `licenses/` 或 `METADATA`；
- Node：查看 `frontend/node_modules/<package>/LICENSE*` 和 `package.json`；
- 字体：查看上述 `OFL-*.txt`；
- 精确依赖图：查看两个锁文件。

本文件用于归档第三方声明，不构成法律意见。
