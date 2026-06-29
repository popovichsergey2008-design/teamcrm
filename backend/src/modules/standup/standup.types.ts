export type StandupKind = 'transcribe' | 'parse' | 'apply';

export interface StandupMessage {
  kind: StandupKind;
  tenantId: string;
  submissionId: string;
  dedupKey: string;
}

export const STATUS_COLUMN: Record<string, string> = {
  DONE: 'Done',
  IN_PROGRESS: 'In Progress',
  TODO: 'To Do',
};
