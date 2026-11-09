/*
  #4804, часть 2: метки кампании с qevo.one — на кнопки, ведущие в app.qevo.one.

  Подключается ко всем страницам сайта веб-сервером (sub_filter в nginx), файлы
  WordPress не трогаем. Пришли на qevo.one с utm_* в адресе — каждая ссылка на
  app.qevo.one («Регистрация», «Начать», «Войти») получает те же метки, а приложение
  сохраняет их при регистрации.

  Чтобы метки не терялись при переходах по сайту, они лежат в sessionStorage вкладки:
  живут до её закрытия и на сервер не уходят. Если юрист скажет, что хранить их без
  согласия на cookie нельзя, — STORE = false: метки пробрасываются только со страницы,
  на которую пришли, без хранения.

  Заодно — домен, откуда пришли (dzen.ru, vk.com), параметром qevo_ref: только домен,
  без пути чужой страницы. Метрику и cookie-баннер скрипт не трогает.
*/
(function () {
  var STORE = true;
  var KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var SKEY = 'qevo_utm';
  var APP = /^https:\/\/app\.qevo\.one(\/|$)/;

  var marks = null;
  try {
    var q = new URLSearchParams(location.search);
    KEYS.forEach(function (k) {
      var v = (q.get(k) || '').trim();
      if (v) { marks = marks || {}; marks[k] = v.slice(0, 200); }
    });
  } catch (e) { /* старый браузер — без меток */ }

  var ref = null;
  try {
    var h = document.referrer ? new URL(document.referrer).hostname.toLowerCase() : '';
    if (h && !/(^|\.)qevo\.one$/.test(h)) ref = h.replace(/^www\./, '');
  } catch (e) { /* без источника */ }

  if (STORE) {
    try {
      var saved = JSON.parse(sessionStorage.getItem(SKEY) || 'null');
      if (marks || ref) {
        sessionStorage.setItem(SKEY, JSON.stringify({ m: marks || (saved && saved.m) || null, r: ref || (saved && saved.r) || null }));
        if (!marks && saved) marks = saved.m;
      } else if (saved) {
        marks = saved.m; ref = saved.r;
      }
    } catch (e) { /* хранилище закрыто — работаем с адресом страницы */ }
  }
  if (!marks && !ref) return;

  function decorate(a) {
    if (!a || !a.href || !APP.test(a.href)) return;
    try {
      var u = new URL(a.href);
      if (marks) KEYS.forEach(function (k) { if (marks[k] && !u.searchParams.has(k)) u.searchParams.set(k, marks[k]); });
      if (ref && !u.searchParams.has('qevo_ref')) u.searchParams.set('qevo_ref', ref);
      if (u.toString() !== a.href) a.href = u.toString();
    } catch (e) { /* кривой адрес — оставляем как есть */ }
  }
  function all() { Array.prototype.forEach.call(document.querySelectorAll('a[href*="app.qevo.one"]'), decorate); }

  // кнопки, которые тема дорисовывает после загрузки, и клик по ещё не обработанной ссылке
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    decorate(a);
  }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', all); else all();
  // не чаще раза за кадр: у темы бывают анимации, и на каждую мутацию обходить страницу незачем
  var pend = 0;
  function later() { if (!pend) pend = requestAnimationFrame(function () { pend = 0; all(); }); }
  if (window.MutationObserver) new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true });
})();
