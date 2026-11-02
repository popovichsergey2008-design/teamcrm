/* Тестовая среда dev.qevo.one (02.11): заметная плашка, чтобы её не путали с рабочей CRM.
   Отдельным файлом из public — не в сборке и не в бюджете стартового бандла. */
(function () {
  if (location.hostname.indexOf('dev.') !== 0) return;
  var show = function () {
    var b = document.createElement('div');
    b.textContent = 'Тестовая среда — данные не настоящие';
    b.setAttribute('role', 'note');
    b.style.cssText = 'position:fixed;left:50%;bottom:6px;transform:translateX(-50%);z-index:2147483000;'
      + 'background:#b4332b;color:#fff;font:600 12px/1 system-ui,sans-serif;padding:5px 10px;border-radius:6px;pointer-events:none;opacity:.9';
    document.body.appendChild(b);
  };
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
})();
