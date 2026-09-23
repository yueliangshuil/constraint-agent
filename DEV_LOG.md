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
