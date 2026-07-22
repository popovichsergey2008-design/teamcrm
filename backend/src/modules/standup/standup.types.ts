export type StandupKind = 'transcribe' | 'parse' | 'apply';

export interface StandupMessage {
  kind: StandupKind;
  tenantId: string;
  submissionId: string;
  dedupKey: string;
}

// Standup ищет колонку по «корзине» (см. ProjectsRepository.findColumnByBucket) — понимает EN+RU наборы.
