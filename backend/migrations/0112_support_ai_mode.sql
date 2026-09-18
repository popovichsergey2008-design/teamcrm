-- Этап 2 коммерческой архитектуры поддержки: помощник как первая линия и как копилот.
--
-- Три вещи, которых не хватало обращению, чтобы с ним можно было работать дальше.
--
-- 1. РЕЖИМ. До подключения человека помощник — собеседник клиента; после — копилот
--    специалиста и клиенту не пишет (02_ANTHILLBOT §7). Раньше это было следствием
--    условия в коде («агент ещё не назначен»), а не свойством разговора: пока обращение
--    ждало в очереди, помощник продолжал отвечать поверх уже запрошенного человека.
--
-- 2. КЛАССИФИКАЦИЯ. Обращение уходило человеку без темы, навыка и срочности —
--    маршрутизировать (этап 3) было нечем.
--
-- 3. ЧЕСТНЫЕ ЧАСЫ. Один `first_response_at` на двоих смешивал ответ помощника и ответ
--    человека: статистика «за сколько отвечаем» переставала что-либо значить
--    (02_ANTHILLBOT §16).

/*
  Кто сейчас разговаривает с клиентом.

  `agent`   — помощник отвечает сам;
  `copilot` — помощник молчит и работает на специалиста.

  Значение переключается при передаче человеку и возвращается только явным действием
  специалиста: «вернуть помощника» — это его решение, а не побочный эффект статуса.
*/
ALTER TABLE support_conversations
    ADD COLUMN ai_mode VARCHAR(16) NOT NULL DEFAULT 'agent'
        CHECK (ai_mode IN ('agent', 'copilot'));

/*
  Что помощник понял об обращении.

  `intent` и `required_skill` — для маршрутизации (этап 3): по ним выбирается дежурный.
  `ai_summary` — суть в одну строку; `handoff_note` — записка специалисту о том, что уже
  пробовали, чтобы он не спрашивал заново (02_ANTHILLBOT §14).
  `escalated_reason` — почему разговор ушёл человеку: попросили, не хватило уверенности,
  ошибка помощника. Без этого разбирать долю эскалаций бессмысленно.
*/
ALTER TABLE support_conversations
    ADD COLUMN intent           VARCHAR(48) NULL,
    ADD COLUMN required_skill   VARCHAR(48) NULL,
    ADD COLUMN ai_confidence    VARCHAR(8)  NULL,
    ADD COLUMN ai_summary       VARCHAR(500) NULL,
    ADD COLUMN handoff_note     TEXT NULL,
    ADD COLUMN escalated_reason VARCHAR(32) NULL;

/*
  Часы отдельно у помощника и у человека.

  Колонку переименовываем, а не заводим вторую с тем же смыслом: `first_response_at`
  всегда означал ответ ЧЕЛОВЕКА (его ставили ответ специалиста и «решено»), и оставить
  прежнее имя рядом с `ai_first_response_at` — значит каждый раз вспоминать, чей же он.
*/
ALTER TABLE support_conversations RENAME COLUMN first_response_at TO human_first_response_at;
ALTER TABLE support_conversations ADD COLUMN ai_first_response_at TIMESTAMPTZ NULL;

DO $$
DECLARE live INT;
BEGIN
  SELECT count(*) INTO live FROM support_conversations WHERE closed_at IS NULL;
  RAISE NOTICE 'режим помощника задан, открытых обращений: %', live;
END $$;
