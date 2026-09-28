# 评测方法

## 1. 可复核单位

最小可复核单位不是“模型总分”，而是一个 CaseRun：

```text
题库内容哈希
+ 运行与模型快照
+ 实际 Prompt
+ 模型原始输出
+ 解析后的 plan/SQL
+ SQL 守卫和执行结果
+ 固定金标
+ 结果差异
+ 评分明细
+ 有序事件
```

总分只是这些案例证据按公开公式聚合后的派生值。

## 2. 题库版本与确定性

每个发布版本由以下源内容决定：

- `schema.sql`
- `seed.sql`
- `semantic.json`
- `prompt.md`
- `cases.yaml`

发布过程对规范化源计算 SHA-256。内容变化必须产生新哈希和新版本。

构建环境固定：

- DuckDB 1.5.5；
- `TimeZone='UTC'`；
- `threads=1`；
- `enable_external_access=false`；
- Seed 完全由 SQL 表达，不依赖当前时间、随机数或外部文件。

发布时执行参考 SQL，保存原始类型化结果和摘要；发布构建不自动运行完整评分器。发布前回归验收另将全部参考 SQL 走完整评分器，当前内置 v4 的 18 个案例全部通过并得到 100 分。

## 3. 当前案例矩阵

v4 共 18 题，每个雷达维度 3 题：

| 维度 | 主要能力 |
| --- | --- |
| 基础查询 | 过滤、空值/布尔/日期语义、基础投影 |
| 连接与粒度 | 多表连接、外连接、连接基数和结果粒度 |
| 聚合与指标 | 业务口径、分组、条件聚合、重复事实处理 |
| 时间与窗口 | 时间边界、分区排序、ROW_NUMBER/SUM/LAG |
| 复杂查询 | 相关子查询、NOT EXISTS、深层查询、CTE |
| 数据开发 | 数据质量、孤立维度、对账、多事实表预聚合 |

难度分布：3 easy、10 medium、5 hard。默认每题权重为题库中公开的 `weight`；模型总分按权重聚合，不按维度二次平均。

v1（12 题）、v2（18 题）及历史评分保持原样，不能与 scorer 2.0.0 直接混排。v3 加入跨年端点、原始均值过滤、并列且不足三项、空月和零收入、重复退货、金额分档端点、未完成订单支付、无销量品类与缺明细对账。v3 试运行发现累计消费的订单头/明细口径未明确，因此 v4 仅澄清该题及业务规则，金标内容不变；v3 诊断成绩不能当作 v4 模型成绩。

## 4. 盲测 Prompt 合同

模型收到：

- DuckDB 方言说明；
- 发布时结构快照；
- 语义层实体、关系、指标、维度和业务规则；
- 当前自然语言问题；
- `query-plan-v1` JSON Schema。

模型不收到：

- `reference_sql`；
- 金标结果；
- `required_ast`；
- 评分权重；
- 题库目录、数据库路径或 Git 仓库路径。

每个实际 Prompt 原样保存。公平性审查应优先检查 Prompt 证据，而不是相信模板源码。

## 5. 输出协议

严格输出必须是单个 JSON 对象：

```json
{
  "plan": {
    "grain": "结果粒度",
    "sources": ["来源"],
    "joins": ["连接"],
    "filters": ["过滤"],
    "metrics": ["指标"],
    "steps": ["步骤"],
    "risks": ["风险"]
  },
  "sql": "SELECT ...",
  "summary": "简短说明",
  "assumptions": []
}
```

- 直接满足 JSON Schema：`protocol_strict=true`，协议项 5 分。
- 只允许恢复单个 ` ```json ` fence，且 fence 前后不能有其他文本；恢复后协议项 0 分。
- 缺字段、额外字段、类型错误、多 fence 或解释性前后缀：`output_contract_error`。

协议分只衡量输出契约，不表示 SQL 正确。

## 6. SQL 守卫

模型 SQL 必须：

- 能按 DuckDB 方言解析；
- 只有一条语句；
- 根节点是只读 Query；
- 不含写入、DDL、事务、附加数据库或危险 AST；
- 不调用外部读取/扫描函数；
- 只引用 `main` 中的发布表或查询自己的 CTE。

通过静态守卫后才会进入独立 DuckDB Worker。Worker 以只读模式打开固定仓库，关闭外部访问，限制 512 MB、单线程、UTC、5 秒和案例最大行数。

## 7. 结果归一化与比较

### 单元格

- `NULL` 保持独立类型。
- 整数、浮点和 Decimal 转为 Decimal，保留实际精度；`decimal_scale` 不再参与判等、预览或摘要定标。
- 金标类型为整数的计数/ID 列要求精确数值相等：12 与 12.0 等价，12.4 不等价；不会套用同题金额容差。
- DECIMAL/DOUBLE 等非整数数值列按下面的绝对/相对容差判断：

$$
|e-a| \le \max(\text{abs\_tolerance},\; \text{rel\_tolerance}\times\max(|e|,|a|))
$$

- 日期转 ISO 日期。
- 时间戳转 UTC，固定微秒格式。
- 字符串做 Unicode NFC；不会擅自 trim 内容。
- NaN 和 Infinity 拒绝。

### 列

1. 列数先比较。
2. 列名去 SQL 引用符并 casefold。
3. 名称集合一致时按金标列顺序重排实际结果。
4. 名称无法唯一对齐时优先尝试精确列指纹，再用类型与容差约束的二分图寻找唯一映射。
5. 仍有多个合法映射时返回 `column_alignment_ambiguous`，不猜测，也不枚举指数级排列。

列被成功重排仍可能失去“列名完全相同”的 5 分，但行内容可以继续客观比较。

### 行

- `duplicate_policy` 固定为 `multiset`；重复行按次数计数。
- 无容差的完全相同多重集走快速路径。
- 有容差时构造行相等二分图，以 Hopcroft–Karp 风格最大匹配计算匹配数。
- `precision = matched / actual_count`。
- `recall = matched / expected_count`。
- `F1 = 2PR/(P+R)`。
- 若 `row_order_significant=false`，F1=1 即顺序项通过。
- 若 `row_order_significant=true`，必须逐行相等。

## 8. 单案例评分

| 项 | 满分 | 判定 |
| --- | ---: | --- |
| 严格输出协议 | 5 | `protocol_strict=true` |
| 只读 AST 守卫 | 5 | SQL 通过静态守卫 |
| 可执行 | 10 | Worker 成功返回结果 |
| 列数 | 5 | 与金标列数一致 |
| 列名 | 5 | 归一化列名及原顺序一致 |
| 行结果 | 45 | `45 × F1` |
| 顺序 | 10 | 按案例顺序合同通过 |
| SQL 能力 | 15 | 无规则时全部给分；有规则时按通过比例 |

$$
S_{case}=S_{protocol}+S_{guard}+S_{exec}+S_{column\ count}+S_{column\ names}+45F_1+S_{order}+S_{AST}
$$

总分四舍五入到两位。重要边界：

- SQL 解析/守卫失败时，仍可能保留严格协议 5 分，其余与 SQL 相关项为 0。
- SQL 通过守卫但执行失败时，可保留协议、守卫和已计算的 AST 能力分。
- Provider/输出合同失败且没有可评分 SQL 时，案例总分记 0。
- `SQL 能力` 不是代码风格分；只检查案例公开定义的结构能力规则。

## 9. 聚合

### 多次尝试

同一案例的尝试保存：

- mean；
- nonzero score rate：得分大于 0 的尝试比例，仅表示“拿到过分”，不是成功率或结果正确率；
- population stddev：分母为尝试数 $N$。

### 模型总分

先得到每个案例的尝试均值，再按案例权重计算：

$$
S_{model}=\frac{\sum_i w_i\bar S_i}{\sum_i w_i}
$$

分类和雷达维度使用同一案例权重聚合。失败和取消案例不会从分母消失；其已落库分数（通常为 0）参与聚合，防止“只统计成功案例”。

### 结果质量与覆盖率

scorer 2.0.0 的新运行使用 `run-report-v4`、`result-quality-v2`。主指标 `result_correct` 只要求执行成功、列数、行结果与题目要求的排序通过，不要求列名或指定 AST 写法；`format_ok` 单独统计 JSON、列名、列数格式合同。政策拒绝、协议、执行、Provider 和基础设施错误分别计入 `failure_kind`/`failure_counts`，未执行的业务正确性为未知，不冒充错解。scorer 1.x 的动态报告继续使用 v3/v1 和原列名要求；已发布报告原字节不变。

模型质量统计的 `total` 是计划尝试总数，所有比率均以它为分母；`evaluated` 表示具备完整判定证据的尝试数，因此运行中或历史资料不完整时必须同时展示 `evaluated / total` 覆盖率。案例快照只附题目与权重，不附 reference SQL 或金标。已发布证据继续保留原报告合同和 `success_rate` 字段，不原地迁移。

### Token、费用与时间效率

新 `efficiency-v2` 按实际业务正确题数归一，不再把部分分当作正确题。令 C 为 `result_correct=true` 的题数：

$$
T_{\text{per correct}}=T_{\text{total}}/C,\quad \text{Cost}_{\text{per correct}}=\text{Cost}_{\text{total}}/C
$$

- 先报告结果正确率与错误分类，综合分仅作辅助分解。
- Token、费用和生成耗时各自按正确题数归一；C=0 或该指标记录不完整时单位消耗为 null。
- 模型生成耗时 P95 与本地 SQL 执行耗时分开，不能当作同一种速度。
- Pi 的 input 已是不含缓存的输入 Token，不能再减 cacheRead；总量为 input + cacheRead + cacheWrite + output。reasoning_output 为输出子集，不重复累计。
- 订阅 OAuth 无单题账单和冻结单价，费用保持 null。价格快照估算不等于实际账单。
- 历史 `efficiency-v1` 保留 C_eq=sum(score/100) 的“得分折算题”口径，明确标注，不与新指标混排。

## 10. 公平性分类

新 Pi 运行冻结并披露：

- `adapter_kind=pi` 与 `response_mode=text`；
- Provider、`auth_mode`、请求/解析模型身份；
- 固定超时以及显式 temperature/reasoning effort；API Key Provider 还可披露 max tokens，`openai-codex` 的输出上限由 Provider 管理；
- Pi harness/bridge/policy、单轮、无工具、生成尝试次数、上下文隔离和系统 Prompt 摘要。

分类：

- `single_model`：只有一个模型。
- `controlled_harness`：至少两个新模型共享 Pi、文本响应、单轮、无工具、无重试和固定 Prompt 合同。Provider、认证、模型和显式生成参数仍是披露变量；该标签不表示同端点或同模型。
- `pure_model` / `access_path`：仅用于原样解释既有历史报告；历史快照不迁移、不重新分类。

`controlled_harness` 不等于实验室意义上的完全控制。模型配置与本地预检不证明实际请求；报告 `case.invocation` 从 provider 事件记录实际参数、wire_generation、SDK/bridge/lock/policy/系统 Prompt 摘要、单次调用和工具状态。请求预算不证明 Provider 内部推理量。跨运行结果差异判断要求所有计划请求有完成证据且实际控制项一致；缺证据不当作一致。

## 11. 身份和版本证据

新运行保存：

- profile 显示名；
- 请求模型 ID；
- Provider 独立返回的解析模型 ID；Pi 当前仅有 requested_catalog 身份，因此 resolved_model_id=null，不用请求值冒充服务端确认；
- Provider request ID；
- Pi harness/bridge/policy 版本；
- Provider、认证、显式参数和隔离配置；
- 生成耗时和 SQL 执行耗时；
- app/scorer/DuckDB/SQLGlot/output contract 版本。

0.2.0 之前的历史运行没有持久化的 Provider request ID 和生成耗时，公开报告保留 `null`。应用/评分器/DuckDB/SQLGlot 值按当时已知部署基线回填；显示名由迁移时仍关联的 profile 回填。这些字段是“可恢复历史元数据”，不应被描述为当时原生保存的证明。

## 12. 如何解释结果

可以据此回答：

- 在指定测试集版本和调用路径下，哪个模型在本次运行的结果正确率更高？
- 哪些题拉开结果差异，哪些题共同未全对、需要先复核题意和口径？差异来自哪些结果行、指定 SQL 写法或失败类型？
- 模型是否稳定遵守输出合同和只读边界？
- 同一快照精确复跑后是否得到相近结果？

不能据此单独回答：

- 哪个模型“普遍更聪明”？
- 差值是否具有统计显著性？
- 模型在其他语言、方言、行业数据和 Schema 规模下如何？
- 公开题库是否已进入模型训练数据？
- 没有完整 Token、价格或耗时覆盖时，哪个方案成本或延迟更优？

建议公开比较至少报告：测试集内容哈希、运行 ID、日期、attempts、请求模型及身份来源、实际调用控制项、结果正确率、共同失分与区分题、格式/失败分类、辅助综合分、每正确题 Token/估算费用、生成耗时 P95、各项覆盖率与证据链接。未执行或政策拒绝的题不能当作业务错解；所有模型共同失分的题不构成区分能力的证据，须先核对口径。历史得分折算口径单独标注。同请求模型的可比复跑逐轮保留正确率并展示已观察到的范围，不把次数叠加成一个新排名；仅请求模型 ID 相同不证明服务端版本相同。两轮只能给出两次观察，三轮也只能描述波动，不能证明统计显著性；公开单一零售 schema 的结果不能外推全行业 SQL 能力。只贴排行榜截图不构成可复核报告。
