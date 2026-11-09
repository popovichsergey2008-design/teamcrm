#!/usr/bin/env python3
"""
#4804: недельный учёт переходов и регистраций по UTM-меткам.

Часть 1 — переходы на qevo.one из журнала nginx (архивы site-log-rotate.sh + текущий
журнал в контейнере). Часть 2 — регистрации из таблицы signup_attribution.

Наружу — только агрегаты: IP и браузер нужны лишь чтобы считать посетителя
(«IP + браузер» за сутки) и в файл не попадают.

Запуск: cron root, понедельник 06:00 МСК — за прошедшую неделю (пн–вс).
Вручную: `python3 utm_weekly.py --current` — неделя, идущая сейчас (для приёмки).

Файлы — в /opt/qevo-site/wp/wp-content/uploads/qevo-stats-<строка>/:
utm-weekly.csv и signups-weekly.csv (перезаписываются), архивы
utm-ГГГГ-ММ-ДД.csv и signups-ГГГГ-ММ-ДД.csv (дата — начало недели).
"""
import csv
import datetime as dt
import glob
import gzip
import io
import os
import re
import secrets
import subprocess
import sys
from urllib.parse import parse_qs, urlsplit

LOG_DIR = os.environ.get('SITE_LOG_DIR', '/opt/teamcrm/logs/site')
SITE = os.environ.get('SITE_DIR', '/opt/qevo-site')
UPLOADS = os.path.join(SITE, 'wp', 'wp-content', 'uploads')
TOKEN_FILE = os.path.join(SITE, 'stats-token')
PG = os.environ.get('PG_CONTAINER', 'teamcrm-crm-postgres-1')

BOTS = re.compile(
    r'bot|crawl|spider|preview|vkshare|telegrambot|facebookexternalhit|whatsapp|slackbot|'
    r'twitterbot|yandexbot|yandexmetrika|googlebot|curl|python|headlesschrome', re.I)
LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) \S+ "[^"]*" "([^"]*)"')
OK = {'200', '301', '302', '304'}
UTM = ('utm_source', 'utm_medium', 'utm_campaign', 'utm_content')


def week(current: bool) -> tuple[dt.date, dt.date]:
    today = dt.date.today()
    monday = today - dt.timedelta(days=today.weekday())
    if not current:
        monday -= dt.timedelta(days=7)
    return monday, monday + dt.timedelta(days=6)


def lines(start: dt.date, end: dt.date):
    """Строки журнала за неделю: архивы с запасом в день (архив пишется в 00:05) + текущий."""
    for path in sorted(glob.glob(os.path.join(LOG_DIR, 'qevo-site-*.log.gz'))):
        m = re.search(r'(\d{4}-\d{2}-\d{2})', path)
        if not m:
            continue
        d = dt.date.fromisoformat(m.group(1))
        if start - dt.timedelta(days=1) <= d <= end + dt.timedelta(days=1):
            with gzip.open(path, 'rt', encoding='utf-8', errors='replace') as f:
                yield from f
    edge = subprocess.run("docker ps --format '{{.Names}}' | grep -E 'crm-edge' | head -1",
                          shell=True, capture_output=True, text=True).stdout.strip()
    if edge:
        for name in ('qevo-site.log.1', 'qevo-site.log'):
            r = subprocess.run(['docker', 'exec', edge, 'cat', f'/var/log/nginx/{name}'],
                               capture_output=True, text=True, errors='replace')
            if r.returncode == 0:
                yield from io.StringIO(r.stdout)


def visits(start: dt.date, end: dt.date) -> list[list]:
    seen: set = set()
    groups: dict = {}
    for raw in lines(start, end):
        m = LINE.match(raw)
        if not m:
            continue
        ip, when, method, url, status, ua = m.groups()
        if method != 'GET' or status not in OK or 'utm_source=' not in url:
            continue
        if not ua.strip() or ua == '-' or BOTS.search(ua):
            continue
        try:
            day = dt.datetime.strptime(when.split()[0], '%d/%b/%Y:%H:%M:%S').date()
        except ValueError:
            continue
        if not start <= day <= end:
            continue
        q = parse_qs(urlsplit(url).query)  # parse_qs сам декодирует %xx и «+»
        key = tuple((q.get(k, [''])[0]).strip().lower() for k in UTM)
        g = groups.setdefault(key, {'visitors': 0, 'hits': 0})
        g['hits'] += 1
        v = (day, ip, ua, key)
        if v not in seen:  # тот же посетитель в тот же день — один раз
            seen.add(v)
            g['visitors'] += 1
    rows = [[start, end, *k, g['visitors'], g['hits']] for k, g in groups.items()]
    return sorted(rows, key=lambda r: (-r[6], r[2], r[3], r[4], r[5]))


def signups(start: dt.date, end: dt.date) -> list[list]:
    # activated: за 7 дней после регистрации поставил задачу или провёл созвон.
    # Задачи первых двух минут не в счёт: это знакомство с системой, а не работа.
    sql = f"""
      SELECT a.signup_utm_source, coalesce(a.signup_utm_medium, ''), coalesce(a.signup_utm_campaign, ''),
             count(*),
             count(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM tasks t WHERE t.created_by = a.user_id
                    AND t.created_at > a.signup_at + interval '2 minutes'
                    AND t.created_at < a.signup_at + interval '7 days')
               OR EXISTS (
                 SELECT 1 FROM meetings m WHERE m.created_by = a.user_id
                    AND m.created_at < a.signup_at + interval '7 days'))
        FROM signup_attribution a
       WHERE (a.signup_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN '{start}' AND '{end}'
       GROUP BY 1, 2, 3 ORDER BY 4 DESC, 1, 2, 3"""
    r = subprocess.run(['docker', 'exec', PG, 'psql', '-U', 'teamcrm', '-d', 'teamcrm', '-At', '-F', '\t', '-c', sql],
                       capture_output=True, text=True, check=True)
    out = []
    for line in r.stdout.splitlines():
        src, med, camp, n, act = line.split('\t')
        out.append([start, end, src, med, camp, int(n), int(act)])
    return out


def stats_dir() -> str:
    if not os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, 'w') as f:
            f.write(secrets.token_hex(12))  # 24 символа
        os.chmod(TOKEN_FILE, 0o600)
    token = open(TOKEN_FILE).read().strip()
    d = os.path.join(UPLOADS, f'qevo-stats-{token}')
    os.makedirs(d, exist_ok=True)
    index = os.path.join(d, 'index.html')
    if not os.path.exists(index):  # без списка файлов каталога
        open(index, 'w').close()
    return d


def write(d: str, name: str, archive: str, head: list, rows: list) -> None:
    for fn in (name, archive):
        path = os.path.join(d, fn)
        with open(path, 'w', encoding='utf-8', newline='') as f:
            w = csv.writer(f, delimiter=';', lineterminator='\n')
            w.writerow(head)
            w.writerows(rows)
        os.chmod(path, 0o644)


def main() -> None:
    start, end = week('--current' in sys.argv)
    d = stats_dir()
    write(d, 'utm-weekly.csv', f'utm-{start}.csv',
          ['week_start', 'week_end', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'visitors', 'hits'],
          visits(start, end))
    write(d, 'signups-weekly.csv', f'signups-{start}.csv',
          ['week_start', 'week_end', 'utm_source', 'utm_medium', 'utm_campaign', 'signups', 'activated'],
          signups(start, end))
    # файлы отдаёт Apache WordPress — каталог и файлы должны быть его
    subprocess.run(['chown', '-R', '33:33', d], check=False)
    os.chmod(d, 0o755)
    print(f'{start}..{end} → {d}')


if __name__ == '__main__':
    main()
