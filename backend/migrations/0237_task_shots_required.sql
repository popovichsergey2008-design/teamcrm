-- #4763: «Не принимать без скриншотов результата» — как «без выполненного чек-листа»
-- (0142): решает постановщик. Включено по умолчанию у НОВЫХ задач; у уже идущих — нет:
-- иначе в день выкладки ни одну начатую задачу нельзя было бы сдать без снимка.
-- Скриншот — любое изображение в файлах задачи или в её обсуждении.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS shots_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tasks ALTER COLUMN shots_required SET DEFAULT TRUE;
