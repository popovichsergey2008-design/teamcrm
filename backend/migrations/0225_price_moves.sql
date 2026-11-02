-- Перевод действующих подписок на новую цену (ТЗ консолей, §5.4; 02.11).
--
-- Новая версия тарифа сама по себе действующие подписки не трогает: они продлеваются
-- по цене, за которую платили (0222). Перевести их — отдельное решение владельца
-- платформы: с какой даты продления, на какую версию. Владельцам компаний уходит
-- письмо; новую цену списываем, только если письмо ушло не позже чем за 14 дней до
-- списания (иначе ещё один период по прежней цене). Перевод можно отменить до применения.

CREATE TABLE billing_price_moves (
  id              BIGSERIAL PRIMARY KEY,
  plan_code       VARCHAR(32) NOT NULL REFERENCES billing_plans(code),
  to_version      INT NOT NULL,
  -- цены целевой версии на момент решения: письмо и списание не зависят от следующих правок тарифа
  price_month_rub NUMERIC(12,2) NOT NULL,
  price_year_rub  NUMERIC(12,2),
  -- продления с этой даты (включительно) — по новой цене
  apply_from      DATE NOT NULL,
  note            VARCHAR(500),
  created_by      BIGINT REFERENCES pc_accounts(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at    TIMESTAMPTZ,
  cancelled_by    BIGINT REFERENCES pc_accounts(id)
);
CREATE INDEX billing_price_moves_live ON billing_price_moves (plan_code) WHERE cancelled_at IS NULL;
