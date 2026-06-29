export type EconomicsKind = 'recompute_task' | 'recompute_project' | 'recompute_on_rate_change';
export type EconomicsReason = 'time_log_closed' | 'scheduled_tick' | 'rate_changed';

export interface EconomicsMessage {
  kind: EconomicsKind;
  tenantId: string;
  taskId?: string;
  projectId?: string;
  userId?: string;
  reason: EconomicsReason;
  dedupKey: string;
}
