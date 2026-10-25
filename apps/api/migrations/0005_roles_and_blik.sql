-- Sprint 1: роли пользователей внутри Account и реквизиты BLIK (D-047, D-048).

-- staff.user_id ссылался на users(id) простым ключом: специалиста можно было привязать к пользователю
-- чужого Account. Связь делается составной, как все связи между таблицами арендаторов (D-038).
-- ON DELETE SET NULL (user_id): при удалении пользователя обнуляется только user_id, account_id остаётся.
ALTER TABLE staff DROP CONSTRAINT staff_user_id_fkey;
ALTER TABLE staff ADD CONSTRAINT staff_user_fk
  FOREIGN KEY (account_id, user_id) REFERENCES users (account_id, id) ON DELETE SET NULL (user_id);
-- Один пользователь соответствует не более чем одному специалисту.
CREATE UNIQUE INDEX staff_user_uq ON staff (user_id) WHERE user_id IS NOT NULL;

-- Реквизиты резервационной оплаты manual_blik (D-010). Деньги получает Account (мастер или салон),
-- поэтому номер хранится на Account. Номер публичен для клиентов в инструкции оплаты, не шифруется.
ALTER TABLE accounts
  ADD COLUMN blik_phone text CHECK (blik_phone ~ '^\+[1-9][0-9]{7,14}$'),
  ADD COLUMN payment_recipient text CHECK (char_length(payment_recipient) BETWEEN 1 AND 100);
