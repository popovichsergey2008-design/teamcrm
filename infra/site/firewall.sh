#!/usr/bin/env bash
# Межсетевой экран для стека сайта компании (WordPress): из его контейнеров — только
# между собой и в интернет. Ни к CRM, ни к мониторингу, ни к соседним проектам.
#
# Зачем (26.10.2026): сети сайта отдельные, но контейнер может постучаться на адрес
# самого сервера — а там на 10.8.0.1 (VPN) опубликованы Postgres, Redis, MinIO, Grafana
# и RabbitMQ CRM. Проба из контейнера WordPress показала: порты открыты. Взломанный
# плагин сайта не должен даже видеть их. Опубликованные порты Docker проходят через
# DNAT и цепочку FORWARD → DOCKER-USER, здесь их и режем.
#
# Повторный запуск безопасен: свои правила сначала снимает (метка qevo-site).
# Автозапуск — systemd qevo-site-firewall.service после docker.service.
set -euo pipefail
TAG="qevo-site"
SITE_NETS=(qevo-site-web qevo-site_site-db qevo-site_site-sftp)

subnet() { docker network inspect "$1" --format '{{(index .IPAM.Config 0).Subnet}}' 2>/dev/null || true; }

# снять прежние свои правила
while iptables -S DOCKER-USER | grep -q -- "--comment $TAG"; do
  rule=$(iptables -S DOCKER-USER | grep -- "--comment $TAG" | head -1 | sed 's/^-A /-D /')
  eval iptables $rule
done

nets=()
for n in "${SITE_NETS[@]}"; do s=$(subnet "$n"); [ -n "$s" ] && nets+=("$s"); done
[ ${#nets[@]} -eq 0 ] && { echo "[$TAG] сетей сайта нет — правила не нужны"; exit 0; }

# Порядок важен: правила вставляем в начало цепочки, поэтому — снизу вверх.
for s in "${nets[@]}"; do
  iptables -I DOCKER-USER -s "$s" -d 172.16.0.0/12 -m comment --comment "$TAG" -j DROP
  iptables -I DOCKER-USER -s "$s" -d 10.0.0.0/8 -m comment --comment "$TAG" -j DROP
  iptables -I DOCKER-USER -s "$s" -d 192.168.0.0/16 -m comment --comment "$TAG" -j DROP
done
# внутри сетей сайта (WordPress ↔ база, edge ↔ WordPress) — можно
for s in "${nets[@]}"; do
  iptables -I DOCKER-USER -s "$s" -d "$s" -m comment --comment "$TAG" -j RETURN
done
# ответы на уже открытые соединения (edge → WordPress и обратно) не трогаем
iptables -I DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "$TAG" -j RETURN
echo "[$TAG] правила стоят для: ${nets[*]}"
