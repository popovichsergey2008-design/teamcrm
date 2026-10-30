import { Icon } from './Icon';
import './task-drafts.css';
import { humanSize } from '../lib/attachments';
import { mergeFiles, tooBig } from '../lib/task-files';

/**
 * Файлы к задаче, которой ещё нет (#4664): кнопка, перетаскивание, список выбранных.
 *
 * Одно поле на окна постановки — «Новую задачу» и быструю команду. В быстрой команде
 * (#4615) прикрепить файл было нельзя вовсе: окно умело только текст и голос, и
 * снимок экрана, ради которого задачу и заводили, приходилось доносить в карточку.
 *
 * Поле `type=file` лежит прозрачным слоем поверх кнопки (`.file-pick-input`): так оно
 * получает фокус с клавиатуры, а в приложении на телефоне открывает системный выбор —
 * галерею, камеру, файлы.
 */
export function TaskFilesField({ files, onChange, disabled, progress, hint, restored }: {
  files: File[];
  onChange: (next: File[]) => void;
  disabled?: boolean;
  /** Идёт загрузка: «2 из 3 — макет.png». */
  progress?: string;
  hint?: string;
  /** Имена файлов из черновика, которые вернуть не удалось: их нужно выбрать заново. */
  restored?: string[];
}) {
  const big = files.filter((f) => tooBig(f));
  return (
    <div className="tff">
      <div
        className="file-drop tc-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); if (!disabled) onChange(mergeFiles(files, e.dataTransfer.files)); }}
      >
        <label className={`ui-btn ui-btn-outline ui-btn-sm file-pick${disabled ? ' is-disabled' : ''}`}>
          <Icon name="paperclip" size={15} /> Прикрепить файлы
          <input
            className="file-pick-input"
            type="file"
            multiple
            disabled={disabled}
            aria-label="Выбрать файлы для задачи"
            onChange={(e) => { onChange(mergeFiles(files, e.target.files)); e.target.value = ''; }}
          />
        </label>
        <span className="ui-cell-dim">{hint ?? 'или перетащите сюда, снимок экрана — Ctrl+V'}</span>
      </div>
      {files.length > 0 && (
        <div className="file-picked">
          {files.map((f, i) => (
            <span key={`${f.name}-${f.size}-${i}`} className="people-chip" title={humanSize(f.size)}>
              <Icon name="file" size={12} /> {f.name}
              <button
                type="button"
                className="people-chip-x"
                disabled={disabled}
                onClick={() => onChange(files.filter((_, j) => j !== i))}
                title="Убрать файл"
                aria-label={`Убрать ${f.name}`}
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {big.length > 0 && (
        <div className="error-text tff-note" role="alert">
          Слишком большие — сервер такие не примет (файл до 25 МБ, видео до 400 МБ): {big.map((f) => f.name).join(', ')}
        </div>
      )}
      {!!restored?.length && (
        <div className="ui-cell-dim tff-note">
          В черновике были файлы, их нужно прикрепить заново: {restored.join(', ')}
        </div>
      )}
      {progress && (
        <div className="tv2-note tff-note" role="status">
          <span className="ui-spinner" style={{ width: 13, height: 13 }} /> {progress}
        </div>
      )}
    </div>
  );
}
