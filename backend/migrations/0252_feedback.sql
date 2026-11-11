-- ТЗ 10.11: оценка «Порекомендовали бы QEVO коллеге?» и отзывы для сайта.
-- nps_state — когда спрашивать: после первого созвона с ИИ-протоколом или 10-й задачи,
-- созданной ИИ; не чаще раза в 60 дней (last_prompt_at).
CREATE TABLE IF NOT EXISTS nps_state (
  tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ai_tasks       INT NOT NULL DEFAULT 0,
  protocol_at    TIMESTAMPTZ NULL,
  last_prompt_at TIMESTAMPTZ NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS nps_answers (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  score      INT NOT NULL CHECK (score BETWEEN 0 AND 10),
  improve    TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Отзыв для qevo.one: из опроса (9–10) или со вкладки «Оставить отзыв». Публикуется
-- только с согласием; приходит письмом тому, кто ведёт сайт.
CREATE TABLE IF NOT EXISTS site_reviews (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  name          VARCHAR(120) NOT NULL,
  position      VARCHAR(120) NULL,
  company       VARCHAR(160) NULL,
  body          TEXT NOT NULL,
  photo_file_id BIGINT NULL REFERENCES files(id) ON DELETE SET NULL,
  consent       BOOLEAN NOT NULL,
  source        VARCHAR(16) NOT NULL,
  score         INT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
