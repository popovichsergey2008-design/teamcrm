import { ApiError, tokens } from './api';
import { apiUrl } from './origin';

/**
 * Загрузка клипа в чат с ходом загрузки (#4643).
 *
 * XHR, а не fetch: только у него есть ход отправки (`upload.onprogress`), и он работает
 * в WebView Android. На мобильной сети проценты показывают, что запись идёт, а не зависла.
 * Сервер отвечает сразу после загрузки — расшифровка приходит потом событием.
 */
export function uploadClip(
  chatId: string, blob: Blob, kind: 'voice' | 'screen', signal?: AbortSignal, onProgress?: (part: number) => void,
): Promise<any> {
  const fd = new FormData();
  // Расширение — по настоящему формату: старый WebView пишет mp4, а распознавание
  // и ffmpeg на сервере определяют формат по имени файла
  const ext = /mp4|aac|m4a/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
  fd.append('file', blob, `${kind === 'voice' ? 'Голосовое' : 'Запись экрана'} ${new Date().toLocaleString('ru-RU')}.${ext}`);
  fd.append('kind', kind);
  return new Promise((ok, fail) => {
    const x = new XMLHttpRequest();
    x.open('POST', apiUrl(`/api/chats/${chatId}/clip`));
    if (tokens.access) x.setRequestHeader('Authorization', `Bearer ${tokens.access}`);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onload = () => {
      let env: any = { ok: false };
      try { env = JSON.parse(x.responseText); } catch { /* не JSON — ошибка ниже */ }
      if (env.ok) ok(env.data);
      else fail(new ApiError(env.error?.code ?? 'INTERNAL', env.error?.message ?? 'Запись не отправлена'));
    };
    x.onerror = () => fail(new ApiError('NETWORK', 'Нет связи с сервером'));
    x.onabort = () => fail(new DOMException('aborted', 'AbortError'));
    signal?.addEventListener('abort', () => x.abort());
    x.send(fd);
  });
}
