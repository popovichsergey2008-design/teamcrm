import { request } from './api';
import { isNativeShell, platform } from '../platform';

/**
 * Google Workspace (#1565): ручки и окно выбора файлов Google.
 *
 * Отдельно от `api`: первый экран про Google ничего не знает, а запас веса у него
 * почти кончился. Этот модуль приезжает вместе с карточкой задачи или настройками.
 */

export type GoogleEntity = 'task' | 'project' | 'client' | 'event';

export interface GoogleStatus {
  configured: boolean;
  picker: { apiKey: string; appId: string; clientId: string } | null;
  account: {
    email: string; name: string | null; status: 'active' | 'attention'; lastError: string | null;
    connectedAt: string; drive: boolean; calendar: boolean;
  } | null;
}

export interface GoogleFile {
  id: string; fileId: string; name: string; mimeType: string; url: string; iconUrl: string | null;
  owner: string | null; modifiedAt: string | null; origin: 'picked' | 'created'; addedBy: string | null;
  addedAt: string; canRemove: boolean;
}

export interface GoogleCalendarSettings {
  calendarId: string; calendarTitle: string | null; pushMeetings: boolean; pullEvents: boolean;
  lastPullAt: string | null; lastError: string | null;
}

export const google = {
  status: () => request<GoogleStatus>('GET', '/integrations/google/status'),
  connectUrl: (service: 'drive' | 'calendar' | 'all', returnTo?: string) =>
    request<{ url: string }>('GET', `/integrations/google/connect?service=${service}${returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ''}`),
  disconnect: () => request<{ disconnected: boolean }>('DELETE', '/integrations/google'),
  pickerToken: () => request<{ accessToken: string; expiresIn: number }>('POST', '/integrations/google/picker-token'),
  links: (type: GoogleEntity, id: string) =>
    request<GoogleFile[]>('GET', `/google-drive/links?entityType=${type}&entityId=${encodeURIComponent(id)}`),
  link: (type: GoogleEntity, id: string, fileIds: string[]) =>
    request<{ items: GoogleFile[]; failed: string[] }>('POST', '/google-drive/links', { entityType: type, entityId: id, fileIds }),
  unlink: (linkId: string) => request<{ removed: boolean }>('DELETE', `/google-drive/links/${linkId}`),
  createDoc: (type: GoogleEntity, id: string, blank = false) =>
    request<{ url: string; items: GoogleFile[] }>('POST', '/google-docs/create', { entityType: type, entityId: id, blank }),
  calendars: () => request<{ id: string; title: string; primary: boolean }[]>('GET', '/google-calendar/calendars'),
  calendarSettings: () => request<GoogleCalendarSettings | null>('GET', '/google-calendar/settings'),
  saveCalendarSettings: (b: Partial<Pick<GoogleCalendarSettings, 'calendarId' | 'calendarTitle' | 'pushMeetings' | 'pullEvents'>>) =>
    request<GoogleCalendarSettings | null>('PUT', '/google-calendar/settings', b),
  syncCalendar: () => request<{ pushed: number; pulled: number }>('POST', '/google-calendar/sync'),
};

/**
 * Уйти на экран согласия Google. В браузере — в этой же вкладке: Google вернёт сюда же.
 * В приложении — в системном браузере: внутри WebView Google вход запрещает, а
 * подключение всё равно сохраняется на сервере, и приложение увидит его при возврате.
 */
export async function connectGoogle(service: 'drive' | 'calendar' | 'all', returnTo?: string) {
  const back = returnTo ?? (window.location.pathname || '/settings/google');
  const { url } = await google.connectUrl(service, back);
  if (isNativeShell()) platform.openExternal(url);
  else window.location.assign(url);
}

// ── окно выбора файлов Google (Picker) ─────────────────────────────────

let pickerLoad: Promise<void> | null = null;

function loadPicker(): Promise<void> {
  if (pickerLoad) return pickerLoad;
  pickerLoad = new Promise<void>((resolve, reject) => {
    const w = window as any;
    const done = () => w.gapi.load('picker', { callback: () => resolve(), onerror: () => reject(new Error('picker')) });
    if (w.gapi?.load) { done(); return; }
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.async = true;
    s.onload = done;
    s.onerror = () => { pickerLoad = null; reject(new Error('Не удалось загрузить окно Google — проверьте интернет')); };
    document.head.appendChild(s);
  });
  return pickerLoad;
}

/**
 * Открыть окно Google «Выбрать файлы». Возвращает id выбранных; отмена — пустой список.
 * Токен короткий и только на это окно: ключ обновления браузер не получает никогда.
 */
export async function pickGoogleFiles(cfg: { apiKey: string; appId: string }): Promise<string[]> {
  const [{ accessToken }] = await Promise.all([google.pickerToken(), loadPicker()]);
  const gp = (window as any).google.picker;
  return new Promise<string[]>((resolve) => {
    const view = new gp.DocsView(gp.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false);
    const picker = new gp.PickerBuilder()
      .setOAuthToken(accessToken)
      .setDeveloperKey(cfg.apiKey)
      .setAppId(cfg.appId)
      .setLocale('ru')
      .addView(view)
      .addView(new gp.DocsUploadView())
      .enableFeature(gp.Feature.MULTISELECT_ENABLED)
      .enableFeature(gp.Feature.SUPPORT_DRIVES)
      .setCallback((data: any) => {
        const action = data[gp.Response.ACTION];
        if (action === gp.Action.PICKED) resolve((data[gp.Response.DOCUMENTS] ?? []).map((d: any) => String(d[gp.Document.ID])));
        else if (action === gp.Action.CANCEL) resolve([]);
      })
      .build();
    picker.setVisible(true);
  });
}

/** Что за файл — словами, по типу Google. */
export function googleKind(mime: string): string {
  if (mime.includes('google-apps.document')) return 'Google Документ';
  if (mime.includes('google-apps.spreadsheet')) return 'Google Таблица';
  if (mime.includes('google-apps.presentation')) return 'Google Презентация';
  if (mime.includes('google-apps.folder')) return 'Папка';
  if (mime.includes('google-apps.form')) return 'Google Форма';
  if (mime === 'application/pdf') return 'PDF';
  if (mime.startsWith('image/')) return 'Изображение';
  if (mime.startsWith('video/')) return 'Видео';
  return 'Файл';
}
