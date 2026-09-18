-- Этап 3 коммерческой архитектуры поддержки: очередь, навыки и назначение.
--
-- До этой миграции очередь была общим списком: кто первым увидел, тот и взял. На десятке
-- обращений это работает, на сотне — нет. Разберут лёгкие и знакомые, а тяжёлые зависнут
-- внизу, и ждать их будет тот, кому хуже всех.
--
-- Дальше обращение назначается само: по навыку, по загрузке и по тому, кто уже вёл этого
-- клиента. Ручное «взять себе» остаётся — маршрутизатор ошибается, и человек должен
-- иметь возможность его поправить.

/*
  Часы очереди и почему обращение оказалось у этого человека.

  `queued_at` и `assigned_at` — то, без чего нельзя ответить на вопрос «сколько люди
  ждут»: до сих пор считалось только время до первого ответа, а ожидание в очереди и
  ожидание ответа взятого разговора — разные беды с разными причинами.

  `routing_reason` — словами: «по навыку», «вёл этого клиента», «свободнее всех»,
  «вручную». Это первое, что спросят, когда назначение окажется неудачным.

  `escalation_level` — сколько раз обращение уходило на второй круг (вернули в работу,
  открыли заново). По нему видно застрявшие истории, которые по статусу выглядят живыми.
*/
ALTER TABLE support_conversations
    ADD COLUMN human_requested_at TIMESTAMPTZ NULL,
    ADD COLUMN queued_at          TIMESTAMPTZ NULL,
    ADD COLUMN assigned_at        TIMESTAMPTZ NULL,
    ADD COLUMN routing_reason     VARCHAR(48) NULL,
    ADD COLUMN escalation_level   SMALLINT NOT NULL DEFAULT 0;

/*
  Сколько разговоров человек тянет одновременно.

  Без предела один дежурный набирает себе двадцать обращений и ни одному не отвечает
  вовремя. Пять — рабочее умолчание; меняется в консоли, потому что зависит от людей и
  от продукта, а не от нашего представления о них.

  Доступность берём из живого присутствия (кто сейчас в системе), а не из ручного
  статуса: статус забывают переключать, и он врёт ровно тогда, когда важен.
*/
ALTER TABLE platform_staff
    ADD COLUMN max_conversations SMALLINT NOT NULL DEFAULT 5;

/*
  Журнал решений маршрутизатора.

  Хранит не только выбор, но и КОГО рассматривали и с какими оценками. Без этого на
  вопрос «почему обращение ушло Максиму, а не Алине» ответить нечем — а спросят его
  обязательно, и обычно в неудачный день.
*/
CREATE TABLE support_routing_events (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
    chosen_agent_id BIGINT NULL REFERENCES users(id),
    reason          VARCHAR(48) NOT NULL,
    required_skill  VARCHAR(48) NULL,
    /** Кандидаты с оценками: [{userId, score, skills, load, online}] */
    candidates      JSONB NOT NULL DEFAULT '[]'::jsonb,
    by_user_id      BIGINT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_routing_events_conv ON support_routing_events (conversation_id, created_at DESC);

/*
  Назначения отдельной строкой.

  У обращения есть текущий исполнитель (assigned_agent_id) — но история назначений
  отвечает на другой вопрос: сколько раз его перекидывали и между кем. Разговор, прошедший
  через четверых, выглядит в статусе так же, как разговор, который сразу попал к своему.
*/
CREATE TABLE support_assignments (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
    agent_id        BIGINT NULL REFERENCES users(id),
    reason          VARCHAR(48) NOT NULL,
    by_user_id      BIGINT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_assignments_conv ON support_assignments (conversation_id, created_at DESC);

-- Уже идущие разговоры: считаем, что в очередь они встали при создании, а назначены
-- тогда же, когда их взяли. Точнее восстановить неоткуда, а пустые часы исказят сводку.
UPDATE support_conversations
   SET queued_at = COALESCE(queued_at, created_at),
       assigned_at = CASE WHEN assigned_agent_id IS NOT NULL THEN COALESCE(assigned_at, updated_at) END
 WHERE closed_at IS NULL;

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM support_conversations WHERE closed_at IS NULL;
  RAISE NOTICE 'маршрутизация включена, открытых обращений: %', n;
END $$;
