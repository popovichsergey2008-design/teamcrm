-- Выпуски (ТЗ консолей, §4.2 «Версии и релизы», §8; 02.11).
--
-- Каждая выкладка — строка: какая сборка (commit, прогон CI, автор, заголовок), как
-- прошла проверка на dev.qevo.one (та же сборка, своя база — миграции проходят там
-- первыми), как прошла проверка прода, откатилась ли. Пишет deploy/release.sh прямо
-- в базу; консоль разработчика только читает. Первая выкладка с этой миграцией себя
-- не запишет — таблицы ещё нет, когда выкладка начинается.

CREATE TABLE release_versions (
  id           BIGSERIAL PRIMARY KEY,
  sha          VARCHAR(64) NOT NULL,
  run          VARCHAR(32),
  author       VARCHAR(200),
  subject      VARCHAR(500),
  commit_at    TIMESTAMPTZ,
  color        VARCHAR(8),
  -- deploying | success | failed (до переключения прода) | rolled_back (прод не ответил — вернули прежний)
  status       VARCHAR(12) NOT NULL DEFAULT 'deploying',
  dev_result   VARCHAR(300),
  prod_result  VARCHAR(300),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);
CREATE INDEX release_versions_started ON release_versions (started_at DESC);
