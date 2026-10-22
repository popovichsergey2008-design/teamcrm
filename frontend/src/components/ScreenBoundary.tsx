import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { isChunkError, reloadOnce } from '../lib/chunk-recovery';

// ТЗ-34 (5.2): экран сбоя Отдела заботы — своим куском, грузится только при сбое
const CareError = lazy(() => import('./support/CareError'));

/**
 * Перехват падения экрана (14.10).
 *
 * Раньше любой сбой при отрисовке ронял всё приложение — оставался пустой фон без
 * единого слова. Теперь: кусок старой сборки не загрузился — страница обновляется
 * сама; другая ошибка — падает только этот экран, остальное приложение живо, а на
 * месте экрана — понятное сообщение и кнопка «Обновить».
 */
export class ScreenBoundary extends Component<{ children: ReactNode; full?: boolean }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('screen crashed', error, info.componentStack);
    if (isChunkError(error)) reloadOnce();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkError(error);
    const plain = (
        <div className="screen-crash-card">
          <h2>{chunk ? 'Вышла новая версия' : 'Экран не загрузился'}</h2>
          <p className="dim">
            {chunk
              ? 'Обновите страницу — откроется свежая версия, данные на месте.'
              : 'Что-то пошло не так при отображении. Обновите страницу — обычно этого достаточно.'}
          </p>
          <div className="screen-crash-actions">
            <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => window.location.reload()}>Обновить</button>
            {!chunk && (
              <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => this.setState({ error: null })}>Попробовать ещё раз</button>
            )}
          </div>
        </div>
    );
    return (
      <div className={`screen-crash${this.props.full ? ' screen-crash-full' : ''}`} role="alert">
        {chunk ? plain : <Suspense fallback={plain}><CareError error={error.message || String(error)} /></Suspense>}
      </div>
    );
  }
}
