-- «Пригласить команду · +1 мес» (Борис, чат 10.11): пространство, куда пришли 6 человек
-- (не считая владельца), один раз получает месяц бесплатно — к пробному периоду или к
-- оплаченному сроку. Отметка ставится в той же транзакции, что и продление: дважды не дать.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS team_bonus_at TIMESTAMPTZ NULL;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS team_bonus_until TIMESTAMPTZ NULL;
