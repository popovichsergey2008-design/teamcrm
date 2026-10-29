import { useCallback, useEffect, useMemo, useState } from 'react';
import { SIGNED_OUT_EVENT, tokens } from '../lib/api';
import { apiUrl } from '../lib/origin';
import { Icon } from '../components/Icon';
import { applyTelegramTheme, closeApp, loadTelegram, type TgWebApp } from './telegram';
import { crmSource, type TgSource } from './source';
import { DEMO_TASK_ID, demoSource } from './demo';
import { TgBoardView, TgTaskView } from './TgViews';
import { setPlatformBridge } from '../platform';
import { browserBridge } from '../platform/browser';
import '../tg.css';

/**
 * Telegram Mini App (#4619, этап 5): шторка QEVO поверх чата Telegram.
 *
 * Адреса: `/tg/board` (доска), `/tg/board?demo=1` (пример до регистрации),
 * `/tg/task/<id>` (карточка; `/tg/task/demo` — задача из примера).
 *
 * Вход — по initData, которую Telegram подписывает токеном нашего бота. Токены живут
 * ТОЛЬКО в памяти окна: в Telegram Web шторка — это iframe на нашем же домене, и запись
 * в localStorage подменила бы сессию человека, открытую рядом в браузере.
 */

/*
  Хранилище токенов — память окна, и подменяется оно при загрузке этого куска, то есть
  ДО любого запроса: в Telegram Web шторка — iframe на нашем домене с общим localStorage,
  и сессия Mini App не должна ни читать, ни затирать сессию человека в соседней вкладке.
  Каждое открытие шторки входит заново по свежей initData.
*/
const mem = new Map<string, string>();
setPlatformBridge({
  ...browserBridge,
  secureStorage: {
    ready: () => Promise.resolve(),
    get: (k) => mem.get(k) ?? null,
    set: (k, v) => { mem.set(k, v); },
    remove: (k) => { mem.delete(k); },
  },
});

type Route = { kind: 'board'; projectId: string | null; demo: boolean } | { kind: 'task'; id: string };

function parse(loc: Location): Route {
  const q = new URLSearchParams(loc.search);
  const m = /^\/tg\/task\/([^/]+)\/?$/.exec(loc.pathname);
  if (m) return { kind: 'task', id: decodeURIComponent(m[1]) };
  return { kind: 'board', projectId: q.get('project'), demo: q.get('demo') === '1' };
}

type Session =
  | { state: 'loading' }
  | { state: 'crm'; name: string }
  | { state: 'demo'; why: 'asked' | 'unlinked' | 'outside' }
  | { state: 'outside' }
  | { state: 'error'; message: string };

/** Один вход на окно: StrictMode в разработке вызывает эффекты дважды — сессий не плодим. */
let loginOnce: Promise<{ linked: boolean; name: string }> | null = null;

async function login(initData: string): Promise<{ linked: boolean; name: string }> {
  const res = await fetch(apiUrl('/api/auth/telegram-webapp'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData }),
  });
  const env = await res.json().catch(() => null) as
    | { ok: boolean; data?: { linked: boolean; accessToken?: string; refreshToken?: string; user?: { fullName?: string } }; error?: { message?: string } }
    | null;
  if (!env?.ok || !env.data) throw new Error(env?.error?.message ?? 'Сервер QEVO сейчас не отвечает');
  if (!env.data.linked) return { linked: false, name: '' };
  // у человека включён вход по коду: шесть цифр в шторке Telegram не спрашиваем
  if ((env.data as { mfaRequired?: boolean }).mfaRequired) {
    throw new Error('У вас включён вход по коду из приложения — откройте QEVO в браузере или в приложении');
  }
  tokens.set(env.data.accessToken!, env.data.refreshToken!);
  return { linked: true, name: env.data.user?.fullName ?? '' };
}

export default function TgApp() {
  const [wa, setWa] = useState<TgWebApp | null | undefined>(undefined);
  const [route, setRoute] = useState<Route>(() => parse(window.location));
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const [demo] = useState(demoSource);

  // Telegram: скрипт, «готов», развернуть на всю высоту, тема
  useEffect(() => {
    let alive = true;
    void loadTelegram().then((w) => {
      if (!alive) return;
      applyTelegramTheme(w);
      try { w?.ready(); w?.expand(); } catch { /* вне Telegram */ }
      w?.onEvent?.('themeChanged', () => applyTelegramTheme(w));
      setWa(w);
    });
    return () => { alive = false; };
  }, []);

  const signIn = useCallback((w: TgWebApp | null, force = false) => {
    const initData = w?.initData ?? '';
    if (!initData) { setSession({ state: 'outside' }); return; }
    if (force || !loginOnce) loginOnce = login(initData);
    loginOnce
      .then((r) => setSession(r.linked ? { state: 'crm', name: r.name } : { state: 'demo', why: 'unlinked' }))
      .catch((e: Error) => setSession({ state: 'error', message: e.message }));
  }, []);

  useEffect(() => {
    if (wa === undefined) return;
    if (route.kind === 'board' && route.demo) { setSession({ state: 'demo', why: 'asked' }); return; }
    if (route.kind === 'task' && route.id === DEMO_TASK_ID) { setSession({ state: 'demo', why: 'asked' }); return; }
    signIn(wa);
    // вход — один раз на окно; смена адреса внутри шторки сессию не трогает
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wa]);

  // сессия кончилась (refresh не прошёл) — входим заново по той же initData, пока она свежая
  useEffect(() => {
    const onOut = () => signIn(wa ?? null, true);
    window.addEventListener(SIGNED_OUT_EVENT, onOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onOut);
  }, [wa, signIn]);

  useEffect(() => {
    const onPop = () => setRoute(parse(window.location));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /** `fromBoard` — карточку открыли с доски: тогда «Назад» = шаг по истории. */
  const go = useCallback((path: string, replace = false, fromBoard = false) => {
    const st = { tg: true, fromBoard };
    if (replace) window.history.replaceState(st, '', path);
    else window.history.pushState(st, '', path);
    setRoute(parse(window.location));
    window.scrollTo(0, 0);
  }, []);

  /* Ссылка t.me/<бот>/<app>?startapp=task_123 — сразу в карточку. */
  useEffect(() => {
    const sp = wa?.initDataUnsafe?.start_param ?? '';
    const m = /^task_(\d+)$/.exec(sp);
    if (m && route.kind === 'board' && !route.projectId) go(`/tg/task/${m[1]}`, true);
    // только при первом появлении Telegram
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wa]);

  const source: TgSource | null = useMemo(
    () => (session.state === 'crm' ? crmSource : session.state === 'demo' ? demo : null),
    [session.state, demo],
  );

  if (session.state === 'loading' || wa === undefined) {
    return <div className="tg-app tg-center" aria-busy="true"><div className="spinner" /></div>;
  }

  if (session.state === 'outside') {
    return (
      <div className="tg-app tg-center">
        <div className="tg-note">
          <h1 className="tg-title">Окно QEVO для Telegram</h1>
          <p className="tg-dim">Эта страница открывается из бота QEVO в Telegram — там вход происходит сам.</p>
          <div className="tg-actions">
            <button type="button" className="ui-btn ui-btn-primary ui-btn-md" onClick={() => { go('/tg/board?demo=1', true); setSession({ state: 'demo', why: 'outside' }); }}>
              Посмотреть пример доски
            </button>
            <a className="ui-btn ui-btn-outline ui-btn-md" href="/">Открыть QEVO</a>
          </div>
        </div>
      </div>
    );
  }

  if (session.state === 'error' || !source) {
    return (
      <div className="tg-app tg-center">
        <div className="tg-note" role="alert">
          <Icon name="alert" size={22} />
          <h1 className="tg-title">Не получилось войти</h1>
          <p className="tg-dim">{session.state === 'error' ? session.message : 'Попробуйте ещё раз.'}</p>
          <div className="tg-actions">
            <button type="button" className="ui-btn ui-btn-primary ui-btn-md" onClick={() => { setSession({ state: 'loading' }); signIn(wa, true); }}>
              Повторить
            </button>
            <button type="button" className="ui-btn ui-btn-outline ui-btn-md" onClick={() => closeApp(wa)}>Закрыть</button>
          </div>
        </div>
      </div>
    );
  }

  const demoBanner = session.state === 'demo' ? (
    <div className="tg-demo" role="note">
      <p><b>Это пример.</b> Создайте своё пространство в боте — +7 дней бесплатно.</p>
      <button type="button" className="ui-btn ui-btn-primary ui-btn-md" onClick={() => closeApp(wa)}>
        Создать в боте
      </button>
    </div>
  ) : null;

  return (
    <div className="tg-app">
      {route.kind === 'board' ? (
        <TgBoardView
          key={`b-${route.projectId ?? ''}`}
          wa={wa} source={source} projectId={source.demo ? null : route.projectId} banner={demoBanner}
          onOpen={(id) => go(`/tg/task/${encodeURIComponent(id)}`, false, true)}
          onProject={(id) => go(`/tg/board?project=${encodeURIComponent(id)}`, true)}
        />
      ) : (
        <TgTaskView
          key={`t-${route.id}`}
          wa={wa} source={source} taskId={route.id} banner={demoBanner}
          onBack={(projectId) => {
            // пришли с доски — назад по истории; открыли карточку сразу из бота — на доску её проекта
            if ((window.history.state as { fromBoard?: boolean } | null)?.fromBoard) window.history.back();
            else go(source.demo ? '/tg/board?demo=1' : `/tg/board?project=${encodeURIComponent(projectId)}`, true);
          }}
        />
      )}
    </div>
  );
}
