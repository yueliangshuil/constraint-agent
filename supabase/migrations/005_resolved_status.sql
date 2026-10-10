-- 005_resolved_status.sql
-- 裁决后状态流转：conflict → resolved（用户实测：裁决后状态永远停在 conflict）
-- 裁决结果本身在 decisions 表可查，executions.status 标记"已裁决"

alter table executions drop constraint if exists executions_status_check;
alter table executions add constraint executions_status_check
  check (status in ('running', 'completed', 'blocked', 'conflict', 'cancelled', 'resolved'));
