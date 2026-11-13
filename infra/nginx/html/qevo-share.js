/*
  #4863 «Отправить коллеге»: в демо на главной qevo.one, в синей плашке после результата —
  ссылка рядом с «Сохранить задачу и начать 14 дней бесплатно». Перед созданием ссылки —
  предупреждение «Ссылку увидит любой, у кого она есть». Ссылка qevo.one/demo/<код> с
  исходным сообщением и карточкой задачи хранится 30 дней, без личных данных (сервер
  вырезает контакты). Кнопки: Скопировать, Telegram, VK, WhatsApp; цель Метрики demo_share.

  WordPress не трогаем: скрипт подключается ко всем страницам сайта через nginx (как
  qevo-utm.js) и ничего не делает там, где демо нет.
*/
(function () {
  'use strict';
  var view = document.getElementById('task-view');
  if (!view) return;

  function goal(name) {
    try {
      var id = (window.QEVO_CONFIG && window.QEVO_CONFIG.metrikaId) || window.YM_COUNTER_ID;
      if (id && typeof window.ym === 'function') window.ym(id, 'reachGoal', name);
      (window.dataLayer = window.dataLayer || []).push({ event: name });
    } catch (e) { /* без Метрики */ }
  }
  function text(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (html != null) n.textContent = html;
    return n;
  }

  /** Карточка и сообщение — с экрана демо, как их видит человек. */
  function collect() {
    var card = view.querySelector('.task');
    if (!card) return null;
    var fields = {};
    Array.prototype.forEach.call(card.querySelectorAll('.field'), function (f) {
      var label = text(f.querySelector('small')).toLowerCase();
      var value = text(f.querySelector('b'));
      if (value === '—') value = '';
      if (label.indexOf('проект') === 0) fields.project = value;
      else if (label.indexOf('исполнитель') === 0) fields.who = value;
      else if (label.indexOf('срок') === 0) fields.due = value;
    });
    var prio = card.querySelector('.task-top .chip:not(.chip-ai)');
    var check = Array.prototype.map.call(card.querySelectorAll('.check li'), function (li) { return text(li); }).filter(Boolean);
    var msgs = Array.prototype.filter.call(document.querySelectorAll('#chat-view .msg'), function (m) {
      return text(m.querySelector('.msg-meta b')) !== 'QEVO' && text(m.querySelector('.msg-text'));
    }).slice(-4).map(function (m) {
      var who = text(m.querySelector('.msg-meta b'));
      return (who && who !== 'Вы' ? who + ': ' : '') + text(m.querySelector('.msg-text'));
    });
    return {
      message: msgs.join('\n'),
      task: { title: text(card.querySelector('h3')), project: fields.project || null, who: fields.who || null, due: fields.due || null, check: check, priority: prio ? text(prio) : null },
    };
  }

  function sharePanel(box, url) {
    box.innerHTML = '';
    var input = el('input', { type: 'text', readonly: '', value: url, 'aria-label': 'Ссылка на результат', style: 'width:100%;margin:6px 0;padding:8px 10px;border-radius:10px;border:1px solid rgba(0,0,0,.15);font:inherit' });
    box.appendChild(input);
    var row = el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px' });
    var copy = el('button', { type: 'button', class: 'btn btn-ghost' }, 'Скопировать');
    copy.addEventListener('click', function () {
      var done = function () { copy.textContent = 'Скопировано'; setTimeout(function () { copy.textContent = 'Скопировать'; }, 2000); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done).catch(function () { input.select(); });
      else { input.select(); try { document.execCommand('copy'); done(); } catch (e) { /* выделено */ } }
    });
    row.appendChild(copy);
    var msg = 'Смотри, как ИИ QEVO сделал задачу из сообщения';
    [
      ['Telegram', 'https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(msg)],
      ['VK', 'https://vk.com/share.php?url=' + encodeURIComponent(url)],
      ['WhatsApp', 'https://wa.me/?text=' + encodeURIComponent(msg + ' ' + url)],
    ].forEach(function (s) {
      row.appendChild(el('a', { class: 'btn btn-ghost', href: s[1], target: '_blank', rel: 'noopener' }, s[0]));
    });
    box.appendChild(row);
  }

  function attach(hook) {
    if (hook.querySelector('[data-qevo-share]')) return;
    var cta = hook.querySelector('[data-lead="sandbox"]');
    var link = el('button', { type: 'button', 'data-qevo-share': '', class: 'btn btn-ghost', style: 'margin-left:8px' }, 'Отправить коллеге');
    var box = el('div', { 'data-qevo-share-box': '', style: 'margin-top:10px;display:none' });
    link.addEventListener('click', function () {
      box.style.display = 'block';
      box.innerHTML = '';
      box.appendChild(el('p', { style: 'margin:0 0 8px' }, 'Ссылку увидит любой, у кого она есть.'));
      var make = el('button', { type: 'button', class: 'btn' }, 'Создать ссылку');
      var cancel = el('button', { type: 'button', class: 'btn btn-ghost', style: 'margin-left:8px' }, 'Отмена');
      cancel.addEventListener('click', function () { box.style.display = 'none'; });
      make.addEventListener('click', function () {
        var data = collect();
        if (!data || !data.task.title) return;
        make.disabled = true; make.textContent = 'Создаю…';
        fetch('/api/public/demo-shares', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error((j && j.error && j.error.message) || 'Не получилось'); return j.data || j; }); })
          .then(function (j) { goal('demo_share'); sharePanel(box, j.url); })
          .catch(function (e) { make.disabled = false; make.textContent = 'Создать ссылку'; box.appendChild(el('p', { style: 'margin:8px 0 0;color:#b42318' }, e.message || 'Не получилось — попробуйте ещё раз')); });
      });
      box.appendChild(make); box.appendChild(cancel);
    });
    if (cta && cta.parentNode === hook) cta.insertAdjacentElement('afterend', link); else hook.appendChild(link);
    hook.appendChild(box);
  }

  function scan() { var hook = view.querySelector('.hook'); if (hook) attach(hook); }
  scan();
  if (window.MutationObserver) new MutationObserver(scan).observe(view, { childList: true, subtree: true });
})();
