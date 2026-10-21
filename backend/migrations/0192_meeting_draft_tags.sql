-- Теги черновика задачи со встречи (#4604, 21.10): ИИ подбирает их из тегов компании
-- сразу после разбора, человек может поправить до создания задачи.
-- NULL — ещё не подбирали (старые черновики), '{}' — подбирали, подходящих нет.
ALTER TABLE meeting_task_drafts ADD COLUMN IF NOT EXISTS tag_ids BIGINT[] NULL;
-- что предложил ИИ: для журнала «человек поправил подсказку» после создания задачи
ALTER TABLE meeting_task_drafts ADD COLUMN IF NOT EXISTS ai_tag_ids BIGINT[] NULL;
