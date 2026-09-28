-- ТЗ-11, разд. 11-12: вход через Google и Telegram.
--
-- Связка «аккаунт - его личность у провайдера». Аккаунт глобальный (одна личность =
-- один аккаунт, организации подтягиваются членствами), поэтому и связка висит на
-- accounts, а не на users.
--
-- Для Telegram отдельной строки может и не быть: привязка бота из личного кабинета
-- живёт в telegram_accounts с 3-го этапа, и вход её переиспользует - кто уже нажал
-- «Открыть бота», тот входит сразу. Эта таблица нужна Google и будущим провайдерам.
CREATE TABLE IF NOT EXISTS account_socials (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id  BIGINT      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider    VARCHAR(16) NOT NULL,          -- google | telegram
    external_id VARCHAR(128) NOT NULL,         -- устойчивый id у провайдера, не почта и не ник
    email       VARCHAR(320) NULL,             -- каким адресом представился: для разбора жалоб
    linked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Одна личность у провайдера ведёт ровно в один аккаунт: иначе чужим входом
    -- можно было бы попасть не туда.
    UNIQUE (provider, external_id),
    -- И наоборот: у аккаунта по одной связке на провайдера.
    UNIQUE (account_id, provider)
);
