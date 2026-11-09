-- #4807 §6.5, п. 6: «Входящие» — по каждому типу «Входящие и push» / «Только входящие» /
-- «Не показывать». Строки `inbox.<тип>` в тех же настройках уведомлений; пусто — «и push».
ALTER TABLE notification_prefs ADD COLUMN IF NOT EXISTS mode VARCHAR(8);
