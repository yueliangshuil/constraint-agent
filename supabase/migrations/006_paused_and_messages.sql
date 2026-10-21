-- 006_paused_and_messages.sql
-- 任务中断恢复（Checkpoint）：
-- 1) 取消语义升级：cancelled → paused（用户主动取消/超时清扫均可恢复执行）
-- 2) executions.messages：每轮循环后持久化对话现场（system/assistant 工具调用/tool 结果），
--    恢复执行时据此重建模型上下文，跳过已执行动作继续 ReAct 循环

alter table executions drop constraint if exists executions_status_check;
alter table executions add constraint executions_status_check
  check (status in ('running', 'paused', 'completed', 'blocked', 'conflict', 'cancelled', 'resolved'));

alter table executions add column if not exists messages jsonb not null default '[]';
