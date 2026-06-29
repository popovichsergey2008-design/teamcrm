# TEAMCRM — Инфраструктура (Этап 0)

Воспроизводимая инфраструктура как код. Сервер: **Contabo VPS, `109.199.99.13`**, Ubuntu 24.04 LTS, 6 vCPU / 11 ГБ RAM / 193 ГБ NVMe.

## Что развёрнуто

| Слой | Состояние |
|---|---|
| OS hardening | админ-юзер `deploy` (sudo), вход только по SSH-ключу, root-логин и пароли отключены |
| Периметр | `ufw` (allow 22/80/443/8080/51820udp, default deny), `fail2ban` (sshd), `unattended-upgrades` |
| VPN | WireGuard `wg0` 10.8.0.1/24, порт 51820/udp; админ-сервисы доступны только через VPN |
| Хранилища | Docker Compose: PostgreSQL 16 **+pgvector 0.8.3**, Redis 7 (пароль), RabbitMQ 4 (management) |
| Edge | nginx reverse-proxy, self-signed TLS, placeholder по IP (`:80/:443/:8080`) |
| Наблюдаемость | Prometheus + node-exporter + cAdvisor, Loki + Promtail, Grafana (датасорсы провижнятся) |
| Бэкапы | `cron` ежедневно 03:00 (`pg_backup.sh`), еженедельный контрольный restore Вс 04:00 |

## Структура

```
infra/
├── docker-compose.yml          # ядро хранилищ + edge nginx
├── .env.example                # шаблон секретов (реальный .env — на сервере, вне git)
├── postgres/init/01-extensions.sql   # CREATE EXTENSION vector/uuid-ossp/pg_trgm
├── nginx/{conf.d,html,certs}   # reverse-proxy, placeholder, self-signed cert
├── scripts/{pg_backup.sh,pg_restore_test.sh}
├── observability/              # отдельный compose: prometheus/grafana/loki/promtail/exporters
└── secrets/                    # SSH-ключ deploy + WireGuard-конфиг (НЕ в git)
```

## Раскладка портов

| Порт | Bind | Доступ |
|---|---|---|
| 22 | 0.0.0.0 | SSH (только ключ, юзер `deploy`) |
| 80/443/8080 | 0.0.0.0 | edge nginx (placeholder / будущее приложение) |
| 51820/udp | 0.0.0.0 | WireGuard |
| 5432 / 6379 / 15672 | **10.8.0.1** | Postgres / Redis / RabbitMQ-UI — **только VPN** |
| 3000 / 9090 | **10.8.0.1** | Grafana / Prometheus — **только VPN** |

> Админ-порты биндятся на WireGuard-адрес `10.8.0.1`, а не на `0.0.0.0`, т.к. Docker
> обходит `ufw` в nat-цепочке — бинд на VPN-интерфейс надёжнее firewall-правил.

## Эксплуатация

```bash
# подключение (из окружения автоматизации — paramiko по ключу infra/secrets/teamcrm_deploy)
ssh -i infra/secrets/teamcrm_deploy deploy@109.199.99.13

# управление стеком
cd /opt/teamcrm            && docker compose ps           # ядро хранилищ
cd /opt/teamcrm/observability && docker compose ps        # мониторинг

# бэкап вручную / контрольное восстановление
/opt/teamcrm/scripts/pg_backup.sh
/opt/teamcrm/scripts/pg_restore_test.sh
```

### Доступ к админ-плоскости (VPN)

1. Установить WireGuard, импортировать `infra/secrets/teamcrm_admin_vpn.conf`, поднять туннель.
2. Grafana → `http://10.8.0.1:3000`, Prometheus → `http://10.8.0.1:9090`,
   RabbitMQ → `http://10.8.0.1:15672`, Postgres → `10.8.0.1:5432`.

## Секреты

Хранятся в `.env` на сервере (`/opt/teamcrm/.env`, `/opt/teamcrm/observability/.env`, режим 600),
в git не попадают. SSH-ключ и VPN-конфиг — `infra/secrets/` (gitignored).

## Открытые пункты Этапа 0

- **TLS**: сейчас self-signed (домена нет). При появлении домена → Let's Encrypt (certbot/nginx).
- **Алерты**: правила заданы (disk/mem/instance/container down); нужен канал доставки
  (Telegram-бот или e-mail/SMTP) — настраивается в Grafana contact points.
- **CI/CD**: репозиторий + пайплайн автодеплоя на staging — требует выбора хостинга (GitHub/GitLab).
