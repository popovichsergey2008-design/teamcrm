import { useEffect, useState } from 'react';
import { api, NewsFile, NewsPost, NewsType } from '../../lib/api';
import type { IconName } from '../../components/Icon';
import { MentionUser, withMentions } from '../../lib/mentions';
import { Linkify } from '../../components/Linkify';

/** Как называется и чем помечен каждый тип поста — одно место на весь раздел. */
export const TYPE_META: Record<NewsType, { label: string; icon: IconName; tone: string }> = {
  manual: { label: 'Новость', icon: 'chat', tone: 'manual' },
  announcement: { label: 'Важное объявление', icon: 'megaphone', tone: 'announcement' },
  kudos: { label: 'Спасибо', icon: 'heart', tone: 'kudos' },
  poll: { label: 'Опрос', icon: 'chart', tone: 'poll' },
  highlight: { label: 'AI-хайлайты дня', icon: 'sparkles', tone: 'highlight' },
  learnings: { label: 'Выводы недели', icon: 'bulb', tone: 'highlight' },
  milestone: { label: 'Веха завершена', icon: 'party', tone: 'release' },
  release: { label: 'Релиз', icon: 'rocket', tone: 'release' },
  victory: { label: 'Победа команды', icon: 'trophy', tone: 'release' },
};

/** Бейджи благодарности (§22) — те же ключи, что на сервере. */
export const BADGES: { key: string; label: string; emoji: string }[] = [
  { key: 'saver', label: 'Спаситель дня', emoji: '🛟' },
  { key: 'team', label: 'Командный игрок', emoji: '🤝' },
  { key: 'quality', label: 'Мастер качества', emoji: '💎' },
  { key: 'speed', label: 'Скорость света', emoji: '⚡' },
  { key: 'idea', label: 'Лучшее решение', emoji: '💡' },
  { key: 'help', label: 'Помощь коллегам', emoji: '🙌' },
];
export const badgeEmoji = (key?: string | null) => BADGES.find((b) => b.key === key)?.emoji ?? '❤️';

/** Реакции (§24) — пять, как на сервере. */
export const REACTIONS = ['❤️', '🔥', '👏', '🎉', '💡'];

export const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
};

/** «до 15 октября, 18:00» — срок опроса и «действует до». */
export const until = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/** Кому виден пост — подписью в шапке, чтобы автор не гадал, кто его прочтёт. */
export function audienceLabel(p: Pick<NewsPost, 'visibility' | 'groups' | 'projectName'>): string | null {
  if (p.visibility === 'department') return p.groups.join(', ') || 'отделу';
  if (p.visibility === 'project') return p.projectName ? `проект «${p.projectName}»` : 'участникам проекта';
  if (p.visibility === 'custom') return 'выбранным людям';
  return null;
}

/** Размер файла человеческими словами: «2,4 МБ» вместо 2516582. */
export function fileSize(bytes: number): string {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** Скачивание с токеном: голая ссылка на файл за авторизацией отдаёт отказ. */
export async function downloadFile(file: NewsFile): Promise<void> {
  try {
    const blob = await api.authedBlob(`/api/files/${file.fileId}`);
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 5000);
  } catch { /* кнопка — удобство; молчаливый отказ лучше ошибки поверх ленты */ }
}

/** Текст: упомянутые имена выделяем, всё остальное — как написано. */
export function Body({ text, team }: { text: string; team: MentionUser[] }) {
  return (
    <>
      {withMentions(text, team).map((part, i) =>
        typeof part === 'string'
          ? <span key={i}><Linkify text={part} /></span>
          : <span key={i} className="mention">@{part.name}</span>)}
    </>
  );
}

/**
 * Картинка новости. Файлы за авторизацией — тянем блоб с токеном. Грузим, только когда
 * карточка дошла до экрана (§72 «lazy media»): длинная лента иначе качает всё сразу.
 */
export function NewsImage({ file, onOpen, thumb }: {
  file: NewsFile;
  onOpen?: (p: { url: string; name: string; mime: string }) => void;
  thumb?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(false);
  const [box, setBox] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!box || visible) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) setVisible(true); }, { rootMargin: '300px' });
    io.observe(box);
    return () => io.disconnect();
  }, [box, visible]);

  useEffect(() => {
    if (!visible) return;
    let dead = false;
    let objectUrl = '';
    api.authedBlob(`/api/files/${file.fileId}`)
      .then((blob) => {
        if (dead) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { if (!dead) setFailed(true); });
    return () => { dead = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file.fileId, visible]);

  if (failed) return thumb ? null : <div className="dim">Картинка «{file.name}» не загрузилась</div>;
  if (!url) return <div ref={setBox} className={thumb ? 'feed-thumb-skeleton' : 'feed-banner-skeleton'} aria-hidden="true" />;
  if (file.mime.startsWith('video/')) {
    // видео не играет само (§72): превью — и «Play» по нажатию
    return <video className={thumb ? 'feed-thumb' : 'feed-video'} src={url} controls={!thumb} preload="metadata" />;
  }
  if (thumb || !onOpen) return <span className="feed-thumb"><img src={url} alt={file.name} loading="lazy" /></span>;
  return (
    <button className="feed-banner" onClick={() => onOpen({ url, name: file.name, mime: file.mime })} title="Открыть во весь экран">
      <img src={url} alt={file.name} />
    </button>
  );
}

/** Медиа поста: картинки и видео — показываем, остальное — файлом. */
export const isMedia = (f: NewsFile) => f.mime.startsWith('image/') || f.mime.startsWith('video/');
