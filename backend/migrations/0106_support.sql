-- Служба заботы ANTHILL (ТЗ-8): живой разговор вместо заявок.
--
-- Почему это своя сущность, а не задача. Задача — работа команды: у неё исполнитель,
-- срок, колонка на доске. Обращение — разговор с человеком: у него другая жизнь
-- (первая линия ИИ, передача специалисту, «проверьте, пожалуйста», оценка, повторное
-- открытие). Свести их в одно значило бы испортить обе стороны. Связь с задачей нужна
-- ровно в одном месте — когда из разговора родился баг (ТЗ-8, разд. 24).
--
-- Слова «тикет» здесь нет намеренно (разд. 2.2): внутренний номер существует, но для
-- человека это всегда живой разговор.
CREATE TABLE support_conversations (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- кто обратился; разговор всегда принадлежит человеку, а не отделу
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- new | ai | waiting_agent | in_progress | waiting_user | resolved | closed
    status            VARCHAR(24) NOT NULL DEFAULT 'new',
    -- normal | high | critical: считается по последствиям, а не по громкости просьбы
    priority          VARCHAR(16) NOT NULL DEFAULT 'normal',
    assigned_agent_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    -- о чём разговор: первая строка обращения, чтобы список читался
    subject           VARCHAR(200) NOT NULL DEFAULT '',
    -- разговор AnthillBot, который ведёт первую линию: он помнит всю нить
    ai_session_id     BIGINT NULL,
    /*
      SLA колонками, а не отдельной таблицей событий (ТЗ-8, разд. 48).

      Величины те же — когда ответили впервые и когда решили, — а запросов и кода
      вдвое меньше. Отдельная таблица понадобилась бы для истории ИЗМЕНЕНИЙ этих
      величин, а её ни один отчёт не спрашивает.
    */
    first_response_at TIMESTAMPTZ NULL,
    resolved_at       TIMESTAMPTZ NULL,
    closed_at         TIMESTAMPTZ NULL,
    -- оценка ставится при закрытии: 1 — «плохо», 4 — «отлично» (разд. 31)
    csat_score        SMALLINT NULL,
    csat_reason       VARCHAR(64) NULL,
    -- сколько раз проблему открывали заново: мера того, что «решили» не по-настоящему
    reopens           INT NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Два вопроса к этой таблице: «мои разговоры» и «кто сейчас ждёт специалиста».
CREATE INDEX idx_support_conv_user ON support_conversations (tenant_id, user_id, created_at DESC);
CREATE INDEX idx_support_conv_queue ON support_conversations (tenant_id, status, created_at)
    WHERE status IN ('waiting_agent', 'in_progress', 'waiting_user');

-- Кто в разговоре: обратившийся, специалист, подключённый инженер.
CREATE TABLE support_participants (
    conversation_id BIGINT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- user | agent | engineer
    role            VARCHAR(16) NOT NULL,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at         TIMESTAMPTZ NULL,
    PRIMARY KEY (conversation_id, user_id)
);

/*
  Сообщения разговора.

  `author_kind` отделяет человека от помощника и от системных отметок («подключился
  Максим»): в ленте они выглядят по-разному, и путать их нельзя — иначе ответ ИИ
  читается как слова специалиста.
*/
CREATE TABLE support_messages (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    conversation_id BIGINT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
    -- у ИИ и системных отметок автора нет
    author_id       BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    -- user | agent | ai | system
    author_kind     VARCHAR(12) NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    file_id         BIGINT NULL REFERENCES files(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at       TIMESTAMPTZ NULL
);
CREATE INDEX idx_support_messages_conv ON support_messages (conversation_id, created_at);

/*
  Технический контекст обращения (разд. 15).

  Собираем ровно то, что видно на экране и помогает понять поломку. Паролей, токенов,
  буфера обмена и чужих данных здесь нет и быть не может (разд. 16) — это правило
  держится и здесь, и в коде, который контекст принимает.
*/
CREATE TABLE support_context (
    conversation_id BIGINT PRIMARY KEY REFERENCES support_conversations(id) ON DELETE CASCADE,
    url             VARCHAR(500) NULL,
    route           VARCHAR(120) NULL,
    entity_type     VARCHAR(32) NULL,
    entity_id       VARCHAR(64) NULL,
    browser         VARCHAR(120) NULL,
    os              VARCHAR(80) NULL,
    app_version     VARCHAR(40) NULL,
    build_id        VARCHAR(64) NULL,
    last_error      TEXT NULL,
    request_id      VARCHAR(64) NULL,
    network         VARCHAR(24) NULL,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Журнал действий поддержки (разд. 39): кто, что, над чем, с подтверждением человека.
CREATE TABLE support_actions (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id  BIGINT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
    actor_id         BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    action           VARCHAR(48) NOT NULL,
    entity_type      VARCHAR(32) NULL,
    entity_id        VARCHAR(64) NULL,
    before_json      JSONB NULL,
    after_json       JSONB NULL,
    approved_by_user BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_support_actions_conv ON support_actions (conversation_id, created_at);

/*
  Дежурные.

  Явный список, а не «все менеджеры»: дежурство — это обязанность, и человек должен
  быть в неё назначен. Пока список пуст, обращения идут владельцу — человек с
  проблемой не должен упираться в «сначала назначьте дежурного».
*/
CREATE TABLE support_agents (
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- навыки для будущей маршрутизации: api, billing, imports, frontend… (разд. 33)
    skills    TEXT[] NOT NULL DEFAULT '{}',
    active    BOOLEAN NOT NULL DEFAULT TRUE,
    added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id)
);

-- Баг, выросший из разговора (разд. 24 и 47). Заводится в MVP 2, таблица — сразу:
-- связь нужна обеим сторонам, и дописывать её потом в живой базе дороже.
CREATE TABLE support_issue_links (
    conversation_id BIGINT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
    task_id         BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    issue_type      VARCHAR(24) NOT NULL DEFAULT 'bug',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, task_id)
);
