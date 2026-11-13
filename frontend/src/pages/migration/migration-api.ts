import { ApiError, request, tokens } from '../../lib/api';
import { apiUrl } from '../../lib/origin';

/**
 * Ручки переезда из Slack и Telegram (#4902, п. 4).
 *
 * Лежат рядом с экраном, а не в общем `api`: экран открывают раз в жизни компании,
 * и тянуть его вызовы в первый экран незачем (бюджет бандла почти исчерпан).
 */

export type MigrationSource = 'slack' | 'telegram';
export type MigrationChatKind = 'channel' | 'private' | 'dm' | 'mpim' | 'tg_group' | 'tg_channel' | 'tg_personal';

export interface MigrationScanChat {
  key: string;
  title: string;
  kind: MigrationChatKind;
  messages: number;
  files: number;
  selected: boolean;
  firstAt: string | null;
  lastAt: string | null;
}

export interface MigrationScan {
  source: MigrationSource;
  chats: MigrationScanChat[];
  people: number;
  peopleWithEmail: number;
  messages: number;
  files: number;
  warnings: string[];
}

export interface MigrationProgress {
  stage?: 'start' | 'read' | 'invite' | 'chat' | 'files' | 'messages' | 'done';
  chat?: string;
  done?: number;
  total?: number;
  files?: number;
  chatsDone?: number;
  chatsTotal?: number;
}

export interface MigrationReport {
  chats: number;
  chatsCreated: number;
  projectsCreated: string[];
  messages: number;
  duplicates: number;
  files: number;
  filesFailed: number;
  usersMatched: number;
  outsiders: number;
  invited: number;
  invitedEmails: string[];
  relinked: number;
  skippedService: number;
  failed: { what: string; reason: string }[];
  failedTotal: number;
  chatList: { title: string; chatId: string; messages: number }[];
  durationMs: number;
}

export interface MigrationJob {
  id: string;
  source: MigrationSource;
  fileName: string;
  sizeBytes: number;
  status: 'scanning' | 'ready' | 'running' | 'done' | 'failed';
  scan: MigrationScan | null;
  options: { chatKeys?: string[]; invite?: boolean; projects?: boolean } | null;
  progress: MigrationProgress | null;
  report: MigrationReport | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Загрузка архива с ходом отправки.
 *
 * XHR, а не fetch: только у него есть `upload.onprogress`, а архив Telegram с фото
 * весит сотни мегабайт — без процентов человек решит, что всё зависло.
 * Протухший за время загрузки токен обновляем через `request` и шлём ещё раз.
 */
export function uploadArchive(
  source: MigrationSource, file: File, onProgress: (part: number) => void, signal?: AbortSignal, retried = false,
): Promise<MigrationJob> {
  return new Promise((ok, fail) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const x = new XMLHttpRequest();
    x.open('POST', apiUrl(`/api/migration-import/upload?source=${source}`));
    if (tokens.access) x.setRequestHeader('Authorization', `Bearer ${tokens.access}`);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let env: { ok?: boolean; data?: MigrationJob; error?: { code?: string; message?: string } } | null = null;
      try { env = JSON.parse(x.responseText); } catch { /* не JSON — ниже по статусу */ }
      if (x.status === 401 && !retried) {
        // любой запрос через request обновит токен; затем повторяем загрузку
        request('GET', '/me')
          .then(() => uploadArchive(source, file, onProgress, signal, true))
          .then(ok, fail);
        return;
      }
      if (env?.ok && env.data) return ok(env.data);
      if (!env && x.status === 413) return fail(new ApiError('PAYLOAD_TOO_LARGE', 'Архив слишком большой для загрузки'));
      if (!env && x.status >= 502 && x.status <= 504) return fail(new ApiError('UNAVAILABLE', 'Сервер обновляется — повторите через минуту'));
      fail(new ApiError(env?.error?.code ?? 'INTERNAL', env?.error?.message ?? `Архив не загрузился (${x.status})`));
    };
    x.onerror = () => fail(new ApiError('OFFLINE', 'Нет связи с сервером — архив не загружен'));
    x.onabort = () => fail(new DOMException('aborted', 'AbortError'));
    signal?.addEventListener('abort', () => x.abort());
    x.send(fd);
  });
}

export const migrationApi = {
  job: (id: string) => request<MigrationJob>('GET', `/migration-import/jobs/${encodeURIComponent(id)}`),
  jobs: () => request<MigrationJob[]>('GET', '/migration-import/jobs'),
  start: (id: string, body: { chatKeys: string[]; invite: boolean; projects: boolean }) =>
    request<MigrationJob>('POST', `/migration-import/jobs/${encodeURIComponent(id)}/start`, body),
};
