-- Принятие мастером документов платформы (D-055, LEGAL_CHECKLIST.md L-10, L-11, L-12).
-- Тексты всех документов (и клиентских, и платформенных) хранятся в consent_documents по типу, языку и версии;
-- публикует их мигратор командой legal:publish. Здесь: кто, когда и какую версию принял от имени Account.

-- Типы документов: клиентские (принимаются при записи, таблица consents) и платформенные (принимает owner).
ALTER TABLE consent_documents ADD CONSTRAINT consent_documents_type_check
  CHECK (type IN ('terms', 'privacy', 'health', 'marketing', 'platform_terms', 'dpa', 'platform_privacy'));

CREATE TABLE platform_acceptances (
  id             bigserial PRIMARY KEY,
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Кто принял. При удалении пользователя обнуляется, а запись о принятии Account остаётся.
  user_id        uuid,
  document_type  text NOT NULL CHECK (document_type IN ('platform_terms', 'dpa', 'platform_privacy')),
  version        text NOT NULL,
  language       text NOT NULL CHECK (language IN ('pl', 'uk', 'ru', 'en')),
  accepted_at    timestamptz NOT NULL DEFAULT now(),
  -- HMAC адреса (доказательство без хранения IP в открытом виде).
  ip_hash        bytea,
  UNIQUE (account_id, document_type, version),
  FOREIGN KEY (account_id, user_id) REFERENCES users (account_id, id) ON DELETE SET NULL (user_id)
);

ALTER TABLE platform_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_acceptances
  USING (account_id = app_current_account()) WITH CHECK (account_id = app_current_account());
-- Доказательство согласия: только добавление (права по умолчанию из 0001 выданы, лишние отзываем).
REVOKE UPDATE, DELETE ON platform_acceptances FROM rezerwapp_app;
