-- Резервирование бюджета общего ИИ до запроса (ТЗ консолей, §5.5; 02.11).
--
-- Раньше потолок месяца сверялся с уже записанным расходом, закэшированным на минуту:
-- десяток одновременных запросов проходили все и вместе перебирали потолок. Теперь
-- перед запросом общим ключом оценка стоимости резервируется ОДНИМ оператором
-- (UPDATE … WHERE spent + held + оценка <= потолок): проходят ровно столько, сколько
-- влезает. После ответа резерв заменяется фактом; при сбое списывается осторожная
-- оценка (судьба платной попытки неизвестна). Резерв процесса, который упал, снимается
-- через 10 минут. spent_usd раз в минуту сверяется с ai_usage — источником правды.

CREATE TABLE ai_budget_month (
  month      CHAR(7) PRIMARY KEY,               -- 'YYYY-MM' по UTC
  spent_usd  NUMERIC(14,6) NOT NULL DEFAULT 0,  -- израсходовано общим ключом (по ai_usage)
  held_usd   NUMERIC(14,6) NOT NULL DEFAULT 0,  -- зарезервировано идущими запросами
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_budget_reservations (
  id          BIGSERIAL PRIMARY KEY,
  month       CHAR(7) NOT NULL,
  tenant_id   BIGINT REFERENCES tenants(id) ON DELETE SET NULL,
  feature     VARCHAR(64) NOT NULL,
  est_usd     NUMERIC(14,6) NOT NULL,
  actual_usd  NUMERIC(14,6),
  -- held — запрос идёт; settled — списан факт; expired — снят по времени
  status      VARCHAR(10) NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'settled', 'expired')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at  TIMESTAMPTZ
);
CREATE INDEX ai_budget_reservations_held ON ai_budget_reservations (created_at) WHERE status = 'held';
