"""
#5011: база «вопрос — ответ» QEVO-бота (QEVOBOT_QA.docx, ТЗ страницы qevo.one/qevobot/, таблица 7.1)
в оба бота — на сайте и в приложении.

Источник — Word-файл заказчика: заголовок группы, под ним таблица «№ | Вопрос | Ответ бота | Кнопка».
Пометки в номере: ★ — первые подсказки, ⚠ — ждёт подтверждения владельца (ответ уже безопасный),
✎ — текст правился. Вопросы этой базы новее листов Excel (#4837): совпал вопрос — заменяем ответ.

  scripts/qa-base/qevobot-qa.json                 — сайт: формат Qevo-бота WordPress (+ "replace": id старого
                                                    ответа сайта, если вопрос тот же — его и обновляем);
  backend/src/modules/support/qa-base.data.json   — приложение (qa-match до модели): записи QB-*,
                                                    совпавшие вопросы — новый ответ в старой записи.

Запуск: python -I scripts/qa-base/build_qevobot_qa.py путь/к/QEVOBOT_QA.docx
"""
from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / 'backend' / 'src' / 'modules' / 'support' / 'qa-base.data.json'
SITE_OLD = ROOT / 'scripts' / 'qa-base' / 'site-chatbot.json'
SITE_OUT = ROOT / 'scripts' / 'qa-base' / 'qevobot-qa.json'


def text(xml: str) -> str:
    return ''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>', xml)).strip()


def unxml(s: str) -> str:
    return s.replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&apos;', "'").replace('&amp;', '&')


def parse(docx: Path) -> list[dict]:
    body = zipfile.ZipFile(docx).read('word/document.xml').decode('utf-8').split('<w:body>')[1]
    rows, group = [], ''
    for m in re.finditer(r'<w:tbl>.*?</w:tbl>|<w:p[ >].*?</w:p>', body, flags=re.S):
        blk = m.group(0)
        if not blk.startswith('<w:tbl>'):
            t = text(blk)
            # заголовок группы — короткая строка; строки оглавления «Зачем — 4» пропускаем
            if t and len(t) < 60 and not re.search(r'— \d+$', t):
                group = unxml(t)
            continue
        for row in re.findall(r'<w:tr[ >].*?</w:tr>', blk, flags=re.S):
            cells = ['\n'.join(x for x in (text(p) for p in re.findall(r'<w:p[ >].*?</w:p>', c, flags=re.S)) if x)
                     for c in re.findall(r'<w:tc>.*?</w:tc>', row, flags=re.S)]
            if len(cells) < 4 or cells[0] in ('№', ''):
                continue
            num = re.match(r'\d+', cells[0])
            rows.append({'n': int(num.group(0)) if num else len(rows) + 1, 'group': group,
                         'q': unxml(cells[1]), 'a': unxml(cells[2]), 'btn': unxml(cells[3]),
                         'star': '★' in cells[0], 'warn': '⚠' in cells[0]})
    return rows


# Страниц ещё нет на сайте (на 22.11 — 404): кнопку ведём к живому специалисту, а не в пустоту.
# Появится страница — убрать её отсюда и пересобрать.
MISSING_PAGES = ('qevo.one/partners/',)
CARE = {'type': 'link', 'label': 'Написать специалисту', 'url': 'https://t.me/qevo_care_ru'}


def actions(btn: str) -> list[dict]:
    """Колонка «Кнопка» → действия бота сайта. «раскрывает ответ №N» — кнопка-вопрос."""
    shown = re.search(r'ответ\s*№\s*(\d+)', btn)
    if shown:
        label = btn.partition('→')[0].strip().strip('«»') or 'Подробнее'
        out = [{'type': 'question', 'id': f"QB-{int(shown.group(1)):03d}", 'label': label}]
        if 'Попробовать' in btn:
            out.append({'type': 'signup', 'label': 'Попробовать 14 дней бесплатно'})
        return out
    a = action(btn)
    if a['type'] == 'link' and any(m in a['url'] for m in MISSING_PAGES):
        return [CARE]
    return [a]


def action(btn: str) -> dict:
    """«Подпись → адрес» из колонки «Кнопка» → действие бота сайта."""
    label, _, target = (x.strip() for x in btn.partition('→'))
    target = re.sub(r'\s*\(.*?\)\s*$', '', target).strip()
    if 'register' in target or not target or target.startswith('#'):
        return {'type': 'signup', 'label': label if 'register' in target else 'Попробовать 14 дней бесплатно'}
    if target.startswith('/'):
        target = 'qevo.one' + target
    return {'type': 'link', 'label': label, 'url': 'https://' + target.removeprefix('https://')}


def norm(s: str) -> str:
    return re.sub(r'[^а-яa-z0-9 ]', '', s.lower().replace('ё', 'е')).strip()


def main() -> None:
    rows = parse(Path(sys.argv[1]))
    assert len(rows) > 200, f'в документе нашлось только {len(rows)} вопросов — формат поменялся?'

    # сайт
    old_site = {norm(a['title']): a['id'] for a in json.loads(SITE_OLD.read_text('utf-8'))['answers']}
    site = []
    for r in rows:
        e = {'id': f"QB-{r['n']:03d}", 'title': r['q'], 'aliases': [], 'answer': r['a'], 'actions': actions(r['btn'])}
        if norm(r['q']) in old_site:
            e['replace'] = old_site[norm(r['q'])]
        site.append(e)
    SITE_OUT.write_text(json.dumps({'version': 1, 'source': 'QEVOBOT_QA.docx', 'answers': site},
                                   ensure_ascii=False, indent=1) + '\n', 'utf-8')

    # приложение: прежние QB-* убираем и собираем заново; совпавший вопрос — новый ответ в старой записи
    app = [e for e in json.loads(APP.read_text('utf-8')) if not e['id'].startswith('QB-')]
    by_q = {norm(e['question']): e for e in app}
    replaced = added = 0
    for r in rows:
        answer = r['a']
        a = actions(r['btn'])[0]
        if a['type'] == 'link' and '/docs/' in a.get('url', ''):
            answer += f"\nПодробнее: {a['url']}"
        hit = by_q.get(norm(r['q']))
        if hit:
            hit['answer'] = answer
            hit['handoff'] = False
            replaced += 1
            continue
        app.append({'id': f"QB-{r['n']:03d}", 'segment': f"QEVO-бот: {r['group']}", 'question': r['q'],
                    'aliases': [], 'answer': answer, 'bucket': 'A', 'handoff': False})
        added += 1
    APP.write_text(json.dumps(app, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    print(f'вопросов {len(rows)}; сайт: {len(site)} (обновят старые: {sum("replace" in e for e in site)}); '
          f'приложение: добавлено {added}, заменено {replaced}')


if __name__ == '__main__':
    main()
