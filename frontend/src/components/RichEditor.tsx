import { useEffect, useRef, useState } from 'react';
import { Icon, IconName } from './Icon';
import { hydrateImages } from './RichText';
import { htmlToMd, mdToHtml } from '../lib/rich-text';

/**
 * Визуальный редактор описания — «как в WordPress».
 *
 * Заказчик: «сделать редактор, чтобы можно было и списки, и жирным, и фото
 * вставлять через Ctrl+V». Пишут в contentEditable и видят результат сразу;
 * в базу уходит лёгкая разметка (lib/rich-text) — её читают письма, Telegram,
 * ИИ и поиск, а HTML им не по зубам.
 *
 * Панель — ровно то, что умеет разбор: заголовок, жирный, курсив, зачёркнутый,
 * два списка, ссылка, картинка. Кнопок «цвет» и «шрифт» нет намеренно: их не во
 * что сохранить, и описание, раскрашенное в семь цветов, читать не легче.
 *
 * Вставка из буфера: картинка уезжает во вложения задачи и встаёт на место
 * курсора; текст вставляется ТЕКСТОМ — из Word и с сайтов приезжает разметка
 * со шрифтами и таблицами, и она превращала бы описание в кашу.
 */
export function RichEditor({ value, onChange, onUploadImage, placeholder, autoFocus, busy }: {
  /** Разметка (см. lib/rich-text). */
  value: string;
  onChange: (md: string) => void;
  /**
   * Куда девать картинку. Без него кнопка картинки и вставка снимка отключены —
   * например, в форме новой задачи, пока задачи, к которой прикладывать, ещё нет.
   */
  onUploadImage?: (file: File) => Promise<{ fileId: string; name: string }>;
  placeholder?: string;
  autoFocus?: boolean;
  /** Идёт загрузка вложения — показать, чтобы человек не вставил снимок дважды. */
  busy?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** Что мы сами отдали наверх: внешнее изменение отличаем от собственного эха. */
  const emitted = useRef<string | null>(null);
  const [empty, setEmpty] = useState(!value.trim());

  /*
    Уборка блобов картинок — только при уходе с редактора.

    Эффект ниже срабатывает на каждое собственное эхо `value` и тут же выходит;
    верни он уборку — React выполнил бы её перед следующим запуском, и картинки
    в редакторе гасли бы после первой же набранной буквы.
  */
  const cleanups = useRef<(() => void)[]>([]);
  useEffect(() => () => { cleanups.current.forEach((c) => c()); cleanups.current = []; }, []);

  // Загрузка содержимого — только при внешнем изменении: переписывать DOM на
  // каждый onChange значило бы терять курсор на каждой букве.
  useEffect(() => {
    const root = ref.current;
    if (!root || value === emitted.current) return;
    root.innerHTML = mdToHtml(value);
    emitted.current = value;
    setEmpty(!value.trim());
    cleanups.current.push(hydrateImages(root));
  }, [value]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const emit = () => {
    const root = ref.current;
    if (!root) return;
    const md = htmlToMd(root);
    emitted.current = md;
    setEmpty(!md.trim());
    onChange(md);
  };

  /** Команда форматирования — со снятием фокуса с кнопки, чтобы выделение не пропало. */
  const run = (command: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(command, false, arg);
    emit();
  };

  const insertImage = async (file: File) => {
    if (!onUploadImage) return;
    const up = await onUploadImage(file);
    ref.current?.focus();
    const alt = up.name.replace(/"/g, '');
    // Абзацем, а не внутри строки: снимок, слипшийся с текстом, не разглядеть.
    document.execCommand('insertHTML', false, `<p><img data-file-id="${up.fileId}" alt="${alt}"></p><p><br></p>`);
    const root = ref.current;
    /*
      Пока шла загрузка, выделение могло пропасть — человек щёлкнул мимо, переключил
      окно. Тогда `insertHTML` не вставляет ничего, и снимок пропадает молча: файл
      уже приложен к задаче, а в описании его нет. Проверяем и дописываем в конец.
    */
    if (root && !root.querySelector(`img[data-file-id="${up.fileId}"]`)) {
      const p = document.createElement('p');
      const img = document.createElement('img');
      img.dataset.fileId = String(up.fileId);
      img.alt = alt;
      p.appendChild(img);
      root.appendChild(p);
    }
    if (root) cleanups.current.push(hydrateImages(root));
    emit();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const image = items.find((i) => i.type.startsWith('image/'))?.getAsFile();
    if (image && onUploadImage) {
      e.preventDefault();
      void insertImage(image);
      return;
    }
    const text = e.clipboardData?.getData('text/plain');
    if (text) {
      e.preventDefault();
      document.execCommand('insertText', false, text);
      emit();
    }
  };

  const link = () => {
    const url = window.prompt('Адрес ссылки', 'https://');
    if (!url || !/^https?:\/\//i.test(url)) return;
    run('createLink', url);
  };

  /** Буквы вместо значков там, где буква и есть значок: «Ж» жирным понятнее любой пиктограммы. */
  const tools: { title: string; act: () => void; label?: string; icon?: IconName; cls?: string }[] = [
    { title: 'Заголовок', label: 'H', act: () => run('formatBlock', '<h2>') },
    { title: 'Обычный текст', label: '¶', act: () => run('formatBlock', '<p>') },
    { title: 'Жирный (Ctrl+B)', label: 'Ж', cls: 'rich-tool-b', act: () => run('bold') },
    { title: 'Курсив (Ctrl+I)', label: 'К', cls: 'rich-tool-i', act: () => run('italic') },
    { title: 'Зачёркнутый', label: 'S', cls: 'rich-tool-s', act: () => run('strikeThrough') },
    { title: 'Список', icon: 'list', act: () => run('insertUnorderedList') },
    { title: 'Нумерованный список', icon: 'sort', act: () => run('insertOrderedList') },
    { title: 'Ссылка', icon: 'link', act: link },
  ];

  return (
    <div className="rich-editor">
      <div className="rich-toolbar" role="toolbar" aria-label="Форматирование">
        {tools.map((t) => (
          <button
            key={t.title}
            type="button"
            className={`rich-tool${t.cls ? ` ${t.cls}` : ''}`}
            title={t.title}
            aria-label={t.title}
            onMouseDown={(e) => e.preventDefault()}
            onClick={t.act}
          >
            {t.icon ? <Icon name={t.icon} size={14} /> : <span>{t.label}</span>}
          </button>
        ))}
        {onUploadImage && (
          <button
            type="button"
            className="rich-tool"
            title="Картинка (или вставьте снимок из буфера — Ctrl+V)"
            aria-label="Вставить картинку"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="image" size={14} />
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          aria-hidden="true"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void insertImage(f); }}
        />
        {busy && <span className="dim rich-busy">Загружаю картинку…</span>}
      </div>
      <div
        ref={ref}
        className={`input rich-area${empty ? ' rich-empty' : ''}`}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Описание"
        data-placeholder={placeholder ?? ''}
        onInput={emit}
        onBlur={emit}
        onPaste={onPaste}
      />
    </div>
  );
}
