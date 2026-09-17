-- Известные проблемы и оповещение о массовом сбое (ТЗ-8, разд. 42 и 43).
--
-- Обе таблицы — про одно и то же чувство: человек не должен выяснять в одиночку то,
-- что мы уже знаем. Если поломка известна — скажем об этом в первую же минуту; если
-- она массовая — скажем всем сразу, не дожидаясь, пока каждый напишет сам.

/*
  Известные проблемы.

  Не отдельная сущность с описанием и статусом, а ПОМЕТКА на уже существующей
  задаче: описание, исполнитель и ход работы у неё и так есть. Дублировать это
  вторым списком значит завести два источника правды о состоянии починки.

  `pattern` — слова, по которым узнаём проблему в чужом обращении. Поиск идёт по
  простому вхождению: тут важнее предсказуемость, чем ловкость, — ложная подсказка
  «похоже на известную проблему» отправляет человека ждать того, чего не чинят.
*/
CREATE TABLE support_known_issues (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    task_id    BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title      VARCHAR(200) NOT NULL,
    -- слова-приметы через запятую: «вложени, файл не приклад»
    pattern    VARCHAR(500) NOT NULL DEFAULT '',
    active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, task_id)
);
CREATE INDEX idx_known_issues_active ON support_known_issues (tenant_id, active);

/*
  Массовый сбой.

  Пока инцидент открыт, о нём видит каждый — в панели поддержки и в открытых
  разговорах. Закрыли — всем уходит «исправлено». Одно честное сообщение вместо
  двадцати одинаковых разговоров.
*/
CREATE TABLE support_incidents (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    title       VARCHAR(200) NOT NULL,
    message     TEXT NOT NULL,
    -- open | resolved
    status      VARCHAR(16) NOT NULL DEFAULT 'open',
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ NULL,
    created_by  BIGINT NULL REFERENCES users(id) ON DELETE SET NULL
);
-- Спрашивают всегда одно: «есть ли сейчас открытый сбой».
CREATE INDEX idx_support_incidents_open ON support_incidents (tenant_id, status, started_at DESC);

-- Предложенное действие ждёт разрешения человека (разд. 38): пока не разрешил —
-- ничего не произошло. Отмена хранится тут же: «до» записано в before_json.
ALTER TABLE support_actions
    ADD COLUMN status      VARCHAR(16) NOT NULL DEFAULT 'done',
    ADD COLUMN preview     VARCHAR(500) NOT NULL DEFAULT '',
    ADD COLUMN params_json JSONB NULL,
    ADD COLUMN decided_at  TIMESTAMPTZ NULL;
