/*
  #5023: service worker ТОЛЬКО для системных уведомлений браузера (кэша и перехвата запросов нет).

  Зачем: у обычного `new Notification()` в Windows щелчок из Центра уведомлений часто
  ничего не делает, а при двух открытых вкладках QEVO каждая показывала своё — два одинаковых.
  Через service worker уведомление одно на тег (тег = сообщение), а щелчок поднимает вкладку
  QEVO и открывает нужный чат; вкладок нет — открывает новую.
*/
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (e) => {
  const n = e.notification;
  const path = (n.data && n.data.path) || '/';
  const tag = n.tag || '';
  n.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const own = list.filter((c) => new URL(c.url).origin === self.location.origin);
    const target = own.find((c) => c.focused) || own.find((c) => c.visibilityState === 'visible') || own[0];
    if (target) {
      try { await target.focus(); } catch { /* браузер не дал — откроем ниже */ }
      target.postMessage({ type: 'qevo-notify-open', path, tag });
      return;
    }
    await self.clients.openWindow(path);
  })());
});
