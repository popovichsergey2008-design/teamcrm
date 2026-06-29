# TEAMCRM

AI-Driven CRM нового поколения — «CRM, которую не нужно заполнять руками».
Пересечение проектного управления, real-time юнит-экономики и проактивного ИИ.

> Каноническая спецификация — в [`specs/`](specs/) (master + этапы 0–5).

## Стек

NestJS (TypeScript) · React (Vite) · PostgreSQL + **pgvector** · Redis · RabbitMQ ·
Socket.io · JWT/RBAC · Docker Compose.

## Структура

| Путь | Содержимое |
|---|---|
| `specs/` | спецификация (master + этапы) |
| `backend/` | NestJS API, домен, realtime, миграции, тесты, нагрузочный smoke |
| `frontend/` | React SPA (дизайн-система, логин, канбан, realtime) |
| `infra/` | инфраструктура как код (Docker Compose, nginx, observability, бэкапы) |
| `.github/workflows/` | CI/CD (lint, test, e2e, build, автодеплой на staging) |

## Статус

- **Этап 0 (инфраструктура)** — готово: hardening, ufw/fail2ban, WireGuard VPN,
  Docker (pg+pgvector/redis/rabbitmq), nginx+TLS, Prometheus/Grafana/Loki, бэкапы с проверкой восстановления.
- **Этап 1 (каркас)** — готово: гибридная БД, JWT/RBAC, projects/tasks/deals/board,
  realtime (изоляция клиентских комнат от финансов), React SPA с канбаном.
  e2e 12/12 на живых хранилищах; нагрузочный smoke realtime — 120 сокетов, 72k событий, 0 потерь.

## Локальная разработка

```bash
# backend
cd backend && npm ci && npm run start:dev      # требует PG/Redis/RabbitMQ (см. infra/)
# frontend
cd frontend && npm ci && npm run dev            # Vite на :5173, проксирует /api на :3000
```

Инфраструктура и деплой — см. [`infra/README.md`](infra/README.md).
