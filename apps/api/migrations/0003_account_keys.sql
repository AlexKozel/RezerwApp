-- Sprint 1: ключи данных для шифрования полей (envelope, D-025, D-042).
-- На каждый Account один ключ данных (DEK), хранится только в обёрнутом мастер-ключом виде.
-- Приложение может прочитать и один раз создать ключ своего Account; менять и удалять нельзя
-- (ротация будет отдельной процедурой мигратора).

CREATE TABLE account_keys (
  account_id   uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  -- Идентификатор провайдера мастер-ключа: env-v1 сейчас, KMS после выбора хостинга.
  provider     text NOT NULL,
  wrapped_key  bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE account_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON account_keys
  USING (account_id = app_current_account()) WITH CHECK (account_id = app_current_account());

-- Права по умолчанию (0001) уже выдали SELECT, INSERT, UPDATE, DELETE.
REVOKE UPDATE, DELETE ON account_keys FROM rezerwapp_app;
