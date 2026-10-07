import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';

/**
 * Компонент, который грузится по первому показу (ТЗ-15, порог веса первого экрана).
 *
 * Обёртка сама держит Suspense, поэтому место использования не меняется: было
 * `import { TaskDrawer }`, стало `const TaskDrawer = lazyComponent(...)` — и всё.
 * `preload()` подтягивает кусок заранее, пока человек ещё не нажал: карточка задачи
 * тогда открывается так же быстро, как раньше.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyComponent<C extends ComponentType<any>>(load: () => Promise<C>, fallback: ReactNode = null) {
  let pending: Promise<C> | null = null;
  const once = () => (pending ??= load());
  const Lazy = lazy(() => once().then((c) => ({ default: c })));
  const Wrapped = (props: React.ComponentProps<C>) => (
    <Suspense fallback={fallback}><Lazy {...props} /></Suspense>
  );
  Wrapped.preload = () => { void once(); };
  return Wrapped;
}

/** Подгрузить, когда браузер простаивает: первый экран уже нарисован и ему не мешаем. */
export function preloadWhenIdle(...items: Array<{ preload: () => void }>) {
  const run = () => items.forEach((i) => i.preload());
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 4000 });
  else window.setTimeout(run, 1500);
}
