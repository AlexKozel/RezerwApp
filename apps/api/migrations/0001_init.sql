-- RezerwApp: начальная схема (Sprint 0).
-- Решения: DECISIONS.md D-014, D-020..D-025, D-031, D-032, D-037.
-- Применяется ролью-мигратором (владелец схемы). Приложение работает под ролью rezerwapp_app
-- без SUPERUSER/BYPASSRLS; Row-Level Security включён и FORCE на всех таблицах арендаторов.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rezerwapp_app') THEN
    CREATE ROLE rezerwapp_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- Текущий Account берётся из настройки транзакции app.account_id (set_config(..., true)).
-- Пустая или отсутствующая настройка даёт NULL: сравнения не проходят, строки не видны (fail closed).
CREATE FUNCTION app_current_account() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.account_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Account и пользователи
-- ---------------------------------------------------------------------------

CREATE TABLE accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL DEFAULT 'individual' CHECK (type IN ('individual', 'business')),
  name          text NOT NULL,
  plan          text NOT NULL DEFAULT 'alpha',
  locale        text NOT NULL DEFAULT 'pl' CHECK (locale IN ('pl', 'uk', 'ru', 'en')),
  timezone      text NOT NULL DEFAULT 'Europe/Warsaw',
  sms_included  integer NOT NULL DEFAULT 40 CHECK (sms_included >= 0),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner', 'staff', 'assistant')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
-- Вход мастера до выбора Account потребует отдельной SECURITY DEFINER функции (Sprint 1).
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

-- ---------------------------------------------------------------------------
-- Location и подключение Independent-мастеров (D-021, D-022)
-- ---------------------------------------------------------------------------

CREATE TABLE locations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name         text NOT NULL,
  address      text,
  public_slug  text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);

CREATE TABLE location_memberships (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id          uuid NOT NULL,
  location_account_id  uuid NOT NULL,
  member_account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'ended')),
  -- Салон видит у Independent только занятость слотов, не клиентов.
  shared_calendar_scope text NOT NULL DEFAULT 'busy_only' CHECK (shared_calendar_scope IN ('busy_only')),
  started_at           timestamptz,
  ended_at             timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (location_account_id, location_id) REFERENCES locations (account_id, id) ON DELETE CASCADE,
  CHECK (member_account_id <> location_account_id),
  UNIQUE (location_id, member_account_id)
);

-- ---------------------------------------------------------------------------
-- Политики, услуги, специалисты
-- ---------------------------------------------------------------------------

CREATE TABLE policies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  version               integer NOT NULL CHECK (version >= 1),
  free_cancel_hours     integer NOT NULL DEFAULT 24 CHECK (free_cancel_hours >= 0),
  max_reschedules       integer NOT NULL DEFAULT 1 CHECK (max_reschedules >= 0),
  hold_minutes          integer NOT NULL DEFAULT 120 CHECK (hold_minutes BETWEEN 5 AND 1440),
  deposit_on_late_cancel text NOT NULL DEFAULT 'keep' CHECK (deposit_on_late_cancel IN ('keep', 'transfer', 'refund')),
  texts_i18n            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, version),
  UNIQUE (account_id, id)
);

CREATE TABLE services (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name_i18n                jsonb NOT NULL DEFAULT '{}'::jsonb,
  category                 text,
  -- D-010: способ предоплаты как абстракция; D-014: потолок процента 50% на уровне БД.
  prepayment_method        text NOT NULL DEFAULT 'none' CHECK (prepayment_method IN ('none', 'manual_blik', 'provider_link')),
  deposit_mode             text NOT NULL DEFAULT 'none' CHECK (deposit_mode IN ('none', 'fixed', 'percent')),
  deposit_value            numeric(10, 2) NOT NULL DEFAULT 0 CHECK (deposit_value >= 0),
  deposit_scope            text NOT NULL DEFAULT 'new_clients' CHECK (deposit_scope IN ('new_clients', 'all')),
  requires_manual_confirm  boolean NOT NULL DEFAULT true,
  cancel_policy_id         uuid,
  cost_price               numeric(10, 2) CHECK (cost_price IS NULL OR cost_price >= 0),
  active                   boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, cancel_policy_id) REFERENCES policies (account_id, id),
  CONSTRAINT services_deposit_percent_cap CHECK (deposit_mode <> 'percent' OR deposit_value <= 50),
  CONSTRAINT services_deposit_none_zero CHECK (deposit_mode <> 'none' OR deposit_value = 0),
  CONSTRAINT services_deposit_needs_method CHECK (deposit_mode = 'none' OR prepayment_method <> 'none')
);

CREATE TABLE service_variants (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL,
  service_id             uuid NOT NULL,
  name_i18n              jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_min           integer NOT NULL CHECK (duration_min > 0),
  buffer_min             integer NOT NULL DEFAULT 0 CHECK (buffer_min >= 0),
  price                  numeric(10, 2) NOT NULL CHECK (price >= 0),
  custom_fields_schema   jsonb NOT NULL DEFAULT '{}'::jsonb,
  active                 boolean NOT NULL DEFAULT true,
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, service_id) REFERENCES services (account_id, id) ON DELETE CASCADE
);

CREATE TABLE staff (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_id           uuid REFERENCES users (id) ON DELETE SET NULL,
  location_id       uuid,
  display_name      text NOT NULL,
  public_slug       text NOT NULL UNIQUE,
  vertical_template text NOT NULL DEFAULT 'beauty',
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, location_id) REFERENCES locations (account_id, id)
);

CREATE TABLE staff_services (
  account_id            uuid NOT NULL,
  staff_id              uuid NOT NULL,
  service_id            uuid NOT NULL,
  override_duration_min integer CHECK (override_duration_min IS NULL OR override_duration_min > 0),
  override_price        numeric(10, 2) CHECK (override_price IS NULL OR override_price >= 0),
  PRIMARY KEY (staff_id, service_id),
  FOREIGN KEY (account_id, staff_id) REFERENCES staff (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, service_id) REFERENCES services (account_id, id) ON DELETE CASCADE
);

CREATE TABLE working_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL,
  staff_id    uuid NOT NULL,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  CHECK (end_time > start_time),
  FOREIGN KEY (account_id, staff_id) REFERENCES staff (account_id, id) ON DELETE CASCADE
);

CREATE TABLE time_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL,
  staff_id    uuid NOT NULL,
  range       tstzrange NOT NULL CHECK (NOT isempty(range)),
  reason      text,
  FOREIGN KEY (account_id, staff_id) REFERENCES staff (account_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Клиенты (база принадлежит Account, D-020, D-023)
-- ---------------------------------------------------------------------------

CREATE TABLE clients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name             text NOT NULL,
  -- Телефон шифруется приложением; для поиска и blacklist используется HMAC-хеш.
  phone_encrypted  bytea NOT NULL,
  phone_hash       bytea NOT NULL,
  email            text,
  language         text NOT NULL DEFAULT 'pl' CHECK (language IN ('pl', 'uk', 'ru', 'en')),
  trust_level      text NOT NULL DEFAULT 'new' CHECK (trust_level IN ('new', 'trusted')),
  anonymized_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, phone_hash)
);

CREATE TABLE client_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL,
  client_id       uuid NOT NULL,
  body_encrypted  bytea NOT NULL,
  sensitivity     text NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'health')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, client_id) REFERENCES clients (account_id, id) ON DELETE CASCADE
);

CREATE TABLE consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL,
  client_id     uuid NOT NULL,
  type          text NOT NULL CHECK (type IN ('privacy', 'terms', 'health', 'marketing')),
  text_version  text NOT NULL,
  given_at      timestamptz NOT NULL DEFAULT now(),
  ip_hash       bytea,
  revoked_at    timestamptz,
  FOREIGN KEY (account_id, client_id) REFERENCES clients (account_id, id) ON DELETE CASCADE
);

-- Глобальные юридические тексты (общие для всех Account, только чтение для приложения).
CREATE TABLE consent_documents (
  type        text NOT NULL,
  language    text NOT NULL CHECK (language IN ('pl', 'uk', 'ru', 'en')),
  version     text NOT NULL,
  body        text NOT NULL,
  valid_from  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (type, language, version)
);

CREATE TABLE blacklist_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  phone_hash  bytea NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '2 years'),
  UNIQUE (account_id, phone_hash)
);

-- ---------------------------------------------------------------------------
-- Бронирования (D-031)
-- ---------------------------------------------------------------------------

CREATE TABLE bookings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL,
  staff_id          uuid NOT NULL,
  client_id         uuid NOT NULL,
  service_id        uuid NOT NULL,
  variant_id        uuid NOT NULL,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  buffer_min        integer NOT NULL DEFAULT 0 CHECK (buffer_min >= 0),
  -- Заполняется триггером: [starts_at, ends_at + buffer).
  slot              tstzrange NOT NULL,
  capacity          integer NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN (
                      'pending', 'confirmed', 'rejected', 'expired',
                      'cancelled_by_client', 'cancelled_by_master',
                      'completed', 'no_show', 'rescheduled')),
  hold_expires_at   timestamptz,
  policy_id         uuid,
  policy_version    integer,
  reschedule_count  integer NOT NULL DEFAULT 0 CHECK (reschedule_count >= 0),
  rescheduled_from  uuid,
  custom_fields     jsonb NOT NULL DEFAULT '{}'::jsonb,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK (ends_at > starts_at),
  CONSTRAINT bookings_pending_has_hold CHECK (status <> 'pending' OR hold_expires_at IS NOT NULL),
  FOREIGN KEY (account_id, staff_id)         REFERENCES staff (account_id, id),
  FOREIGN KEY (account_id, client_id)        REFERENCES clients (account_id, id),
  FOREIGN KEY (account_id, service_id)       REFERENCES services (account_id, id),
  FOREIGN KEY (account_id, variant_id)       REFERENCES service_variants (account_id, id),
  FOREIGN KEY (account_id, policy_id)        REFERENCES policies (account_id, id),
  FOREIGN KEY (account_id, rescheduled_from) REFERENCES bookings (account_id, id),
  -- Двойная запись невозможна на уровне БД для слотов с capacity = 1.
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (staff_id WITH =, slot WITH &&)
    WHERE (status IN ('pending', 'confirmed') AND capacity = 1)
);

CREATE INDEX bookings_account_starts_idx ON bookings (account_id, starts_at);
CREATE INDEX bookings_pending_hold_idx ON bookings (hold_expires_at) WHERE status = 'pending';

CREATE FUNCTION bookings_set_slot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ends_at <= NEW.starts_at THEN
    RAISE EXCEPTION 'bookings: ends_at must be after starts_at'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bookings_time_order';
  END IF;
  NEW.slot := tstzrange(NEW.starts_at, NEW.ends_at + make_interval(mins => NEW.buffer_min), '[)');
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER bookings_set_slot_trg
  BEFORE INSERT OR UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_set_slot();

CREATE TABLE booking_events (
  id          bigserial PRIMARY KEY,
  account_id  uuid NOT NULL,
  booking_id  uuid NOT NULL,
  type        text NOT NULL,
  actor       text NOT NULL CHECK (actor IN ('client', 'master', 'system', 'offline_sync')),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, booking_id) REFERENCES bookings (account_id, id) ON DELETE CASCADE
);
CREATE INDEX booking_events_booking_idx ON booking_events (booking_id, at);

CREATE TABLE payment_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL,
  booking_id  uuid NOT NULL,
  mode        text NOT NULL CHECK (mode IN ('manual_blik', 'provider_link')),
  amount      numeric(10, 2) NOT NULL CHECK (amount > 0),
  code        text NOT NULL,
  status      text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'confirmed', 'kept', 'returned')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, code),
  FOREIGN KEY (account_id, booking_id) REFERENCES bookings (account_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Журналы (только добавление)
-- ---------------------------------------------------------------------------

CREATE TABLE sms_ledger (
  id          bigserial PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  delta       integer NOT NULL,
  reason      text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  actor_id     uuid,
  action       text NOT NULL,
  object_type  text,
  object_id    uuid,
  at           timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Row-Level Security (D-032)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'locations', 'policies', 'services', 'service_variants', 'staff',
    'staff_services', 'working_hours', 'time_blocks', 'clients', 'client_notes',
    'consents', 'blacklist_entries', 'bookings', 'booking_events',
    'payment_requests', 'sms_ledger', 'audit_log'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (account_id = app_current_account()) WITH CHECK (account_id = app_current_account())',
      t
    );
  END LOOP;
END
$$;

-- Account видит и меняет только себя. Новый Account создаётся с id, равным объявленному контексту.
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY accounts_self ON accounts
  USING (id = app_current_account()) WITH CHECK (id = app_current_account());

-- Подключение к Location видят обе стороны: салон и подключаемый мастер.
ALTER TABLE location_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_parties ON location_memberships
  USING (location_account_id = app_current_account() OR member_account_id = app_current_account())
  WITH CHECK (location_account_id = app_current_account() OR member_account_id = app_current_account());

-- ---------------------------------------------------------------------------
-- Права роли приложения
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO rezerwapp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rezerwapp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rezerwapp_app;

-- Журналы только добавляются; юридические тексты только читаются.
REVOKE UPDATE, DELETE ON booking_events, audit_log, sms_ledger FROM rezerwapp_app;
REVOKE INSERT, UPDATE, DELETE ON consent_documents FROM rezerwapp_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rezerwapp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO rezerwapp_app;
