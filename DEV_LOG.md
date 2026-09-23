# 开发记录（难点与决策）

> 项目：业务约束感知自适应规划 Agent（服务发布审批场景）
> 设计文档：Desktop\简历\业务约束感知自适应规划Agent - 技术方案与开发难点.md

## 2026-09-23 · 项目启动

1. **项目定位**（理论家确认）：业务规则托管于 RAG 知识库，Agent 工具调用前经确定性规则引擎校验，「LLM 懂语义、代码做判定」。场景选定：服务发布审批（时间/权限/配额/冲突四类约束全覆盖）。

2. **"自适应"的边界定义**：自适应 = 系统行为随规则知识库变化而变化（规则层自适应），不是模型权重自适应。面试防挑战的定义锚已写入设计文档。

3. **企业级差距的诚实定位**：架构思想企业级（确定性兜底/审计/fail-closed/冲突人工兜底），工程完整度实习级（无多租户/高可用/规则灰度）。两项低成本增强已纳入：规则版本化（P2）、Prompt 注入防护（P1）。

4. **技术选型**：
   - MCP：官方 @modelcontextprotocol/sdk，开发期 InMemoryTransport（真实协议帧、无子进程管理），部署期升级 Streamable HTTP——取舍原因：Next.js 内集成简单、Vercel 部署无障碍；
   - 表达式引擎：expr-eval（沙箱、支持 AST 解析用于变量白名单校验——这是选它的关键，其他库不暴露 AST）；
   - 弃用原文档的 Prisma+SQLite → 复用本地 Supabase（pgvector/tsvector/RRF 全套从 RAG 项目延续，栈统一）；
   - Agent 循环手写（非 LangChain AgentExecutor）：校验门槛必须内嵌在循环里，框架黑盒做不到。

5. **复用 RAG 项目清单**：本地 Supabase 栈与迁移模式、bigram 分词器、SSE 协议（encodeSSE/parseSSEBlock）、防抖节流、Markdown 流式渲染、AbortController 管控、评测方法论（诚实规模标注）。

## 2026-09-23 · P1 开发

6. **expr-eval 库存在优先级 bug，改为自研表达式解释器**（核心难点）：
   - 实测 expr-eval@2.0.2（npm 最新版，8 年未更新）：`hour >= 22 || hour < 6` 在 hour=14 时求值为 **true**（应为 false）——`||` 与比较运算符的优先级处理有 bug，规则引擎的判定会直接错误；
   - 其 AST 是扁平 token 流而非节点树，无法可靠提取标识符做白名单校验；
   - **决策：自研轻量布尔表达式解释器**（src/lib/expression.ts，约 180 行）：词法分析 + 递归下降 + AST 求值。理由：语法层面只实现布尔逻辑所需最小集合（&& || ! 比较 括号 字面量 标识符），函数调用/赋值不存在于语法中 → 注入风险为零（语法级沙箱）；AST 可控 → 标识符白名单直接遍历节点；词法/语法错误显式抛出 → fail-closed；
   - 测试：24 条单测全绿（解释器 10 条 + 规则引擎 14 条），覆盖优先级、短路、字符串比较、未声明变量、非法表达式、豁免覆盖、同优先级冲突、注入检测；
   - 面试价值升级：「连表达式解释器都是自研的」比「用了 expr-eval」强一档——但必须能讲清为什么（库的 bug + AST 不可控 + 语法级沙箱）。

7. **注入防护第一道防线落地**：INJECTION_PATTERNS 检测「忽略以上指令/ignore instructions」等模式。测试中发现初版英文正则在多修饰词场景（"all previous instructions"）漏检——正则是 `(all\s+|previous\s+)?` 只允许一个修饰词，改为 `((all|previous|above|following|other)\s+)*` 允许任意组合。教训：注入模式测试要用真实攻击文案变体。

8. **与 RAG 项目的联动集成决策**（理论家要求两个项目一起使用）：
   - 架构：RAG 项目 = 检索服务（新增独立端点 /api/retrieval，规则文档进 RAG 知识库）；Agent 项目 = 编排服务，「规则检索 MCP」通过 HTTP 调用 RAG 检索端点（RAG_API_BASE 环境变量，本地 http://localhost:3000）；
   - 运行时：本地双 dev server 并行（RAG:3000 / Agent:3001），共享同一本地 Supabase；
   - 理由：比 Agent 直连数据库更符合「复用项目一」的叙事，且与部署后的服务形态一致（两个服务各自部署，HTTP 互通）；
   - 部署注意：两项目云端 Supabase 各自独立项目，检索服务与编排服务通过环境变量指向对方生产地址。

## 2026-09-23 · P1 开发（续）

9. **手写 ReAct 循环的设计过程**（不用 LangChain AgentExecutor 的原因与实现要点）：
   - **为什么手写**：规则引擎校验必须内嵌在「模型产出工具调用」与「工具真正执行」之间——这是本项目的硬门槛，框架的 AgentExecutor 把工具执行封装在内部，没有插入校验钩子的位置。手写循环 = 把门槛写进控制流，代码结构上不可能绕过（难点 D 的对策）。
   - **循环结构**：model.invoke(messages) → 有 tool_calls 则逐个处理（无则取 content 为最终结论）→ 把 AIMessage（含 tool_calls）与 ToolMessage（结果）回填 messages → 下一轮。max 6 轮强制终止。
   - **每步工具调用的处理链**：Zod 校验入参 → 组装 ExecContext（动作/环境/配额等）→ 规则引擎 evaluateConstraints → 三分支：pass 走 MCP 执行 / block 把违规约束文本回填给模型让其重新规划（循环内自适应）/ conflict 暂停并结束本轮（P2 接人工裁决）。
   - **模型消息组装细节**：LangChain 消息对象（SystemMessage/HumanMessage/AIMessage/ToolMessage）链式追加；ToolMessage 必须带 tool_call_id 与模型产出的 tool_calls 一一对应，否则 API 报错。
   - **工具参数校验在 Agent 层而非 MCP 层**：Zod 校验模型入参 → 参数非法直接以 ToolMessage 反馈（不让非法调用进入引擎），这是第二重保险。
   - **审计时机**：应用侧在每次 pass/block 后自动落库（审计工具不暴露给模型，避免模型选择性记录）。

10. **漏召回的真实案例**（E2E 抓出，实证设计文档中的最大风险）：
    - 现象：冲突场景（夜间紧急发布）未触发 conflict，检查 constraints 事件发现「紧急发布管理规范」的两条规则根本没被召回——RAG 知识库残留 Phase 2 评测的 40 份语料文档，把 topK=6 名额挤掉；
    - 修复：① 清理知识库评测残留（41 份）；② 召回 topK 6→10；③ 检索 query 追加「业务约束规则」关键词；
    - 教训：漏召回 = 违规放行在本项目中是**真实发生过的故障**，fail-closed 阈值只能兜底"召回太少"的情况，兜不住"召回不完整"——规则文档少、库干净时风险可控，规则量大了必须做标签过滤 + 覆盖率评测（P3 评测集里加入"召回完整性"指标）。

11. **SSE 快速连续事件被静默丢弃**（emit 误用 desiredSize）：
    - 现象：冲突分支在同一微任务内连续 emit 4 个事件（validation → decision_request → tool_result → done），但客户端只收到 validation——后续事件全部丢失；
    - 根因：路由 emit 里写了 `if (!controller.desiredSize) return`，第一次 enqueue 后 desiredSize 归 0（默认高水位 1），未等消费者拉取就丢弃后续事件。这是对背压的误用——本地小事件流不需要应用层背压；
    - 修复：去掉 desiredSize 判断，改为 closed 标志 + enqueue try/catch（客户端断开时 enqueue 抛错即静默停止）；
    - 教训：ReadableStream 的 desiredSize 是给生产者做背压用的，连续 emit 场景下会误伤；事件完整性用 done 事件 + 序号校验兜底。

12. **演示时间模拟器**：时间类约束依赖服务器时钟，演示/评测不可控。任务输入增加 hourOverride（0-23）字段，UI 提供模拟时间控件——评测集可复现（P3 依赖此设计）。

## 2026-09-23 · P2：裁决面板与审计回放

13. **执行持久化与裁决闭环**：
    - executions 行在执行开始时创建（status=running + 上下文快照），每个终态路径统一走 finalize() 更新状态/步骤/结论——避免各 return 路径遗漏落库；
    - 审计事件（recordAudit）与工具步骤统一进 steps jsonb（audit 工具不暴露给模型，应用侧自动记录——模型无法选择性记录，审计可信）；
    - 冲突快照存入 steps 的 conflict 条目（含两侧规则完整信息），裁决 API 直接从 steps 提取——避免客户端回传数据造成的不一致（服务端数据是唯一事实源）；
    - 裁决 API 校验状态机：仅 conflict 状态可裁决，防重复裁决；
    - 前端：decision_request 事件触发裁决弹窗（禁止侧/豁免侧并排展示 + 裁决人输入），历史列表可展开回放步骤。
    - E2E 验证：冲突场景 → execution(conflict) → 裁决 allow 落 decisions → 详情含裁决记录。

14. **规则版本化（RAG 项目迁移 006）**：documents 加 version/is_latest；同名同内容跳过、同名不同内容 → 新版本插入旧版置非最新；match_chunks/hybrid_search 通过 join documents 过滤 is_latest——规则变更全程可追溯，检索永远命中最新规则。
