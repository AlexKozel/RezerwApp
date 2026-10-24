#!/usr/bin/env bash
# Проверка слоя БД на настоящем PostgreSQL без Node-зависимостей:
# гонки по слоту, EXCLUDE-ограничение, Row-Level Security, права роли приложения, ограничения услуг.
#
# Использование:
#   PG_ADMIN_URL=postgres://rezerwapp:rezerwapp@localhost:5432/postgres scripts/verify-db.sh
# Нужны psql и суперпользователь (создаёт и удаляет базу rezerwapp_verify).

set -uo pipefail

ADMIN_URL="${PG_ADMIN_URL:-postgres://rezerwapp:rezerwapp@localhost:5432/postgres}"
DB="${VERIFY_DB:-rezerwapp_verify}"
BASE="${ADMIN_URL%/*}"
ADMIN_DB_URL="$BASE/$DB"
APP_DB_URL="$(echo "$BASE" | sed -E 's#^(postgres(ql)?://)[^@]*@#\1rezerwapp_app:rezerwapp_app@#')/$DB"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [ -n "${2:-}" ] && echo "       $2"; }

admin() { psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 -qtA "$@"; }

# app ACCOUNT SQL: выполняет SQL от роли приложения в транзакции с контекстом Account.
app() {
  local acct="$1" sql="$2"
  printf "BEGIN;\nSELECT set_config('app.account_id', '%s', true) \\\\gset\n%s\nCOMMIT;\n" "$acct" "$sql" |
    psql "$APP_DB_URL" -v ON_ERROR_STOP=1 -qtA -f - 2>&1
}
# app_nocontext SQL: без объявленного Account.
app_nocontext() { printf "%s\n" "$1" | psql "$APP_DB_URL" -v ON_ERROR_STOP=1 -qtA -f - 2>&1; }

assert_eq() { # имя ожидаемое фактическое
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "ожидалось '$2', получено '$3'"; fi
}
assert_fails() { # имя шаблон-ошибки команда...
  local name="$1" pattern="$2"; shift 2
  local out; out="$("$@")"; local st=$?
  if [ $st -ne 0 ] && echo "$out" | grep -qiE "$pattern"; then pass "$name"; else fail "$name" "статус=$st вывод=$(echo "$out" | head -2 | tr '\n' ' ')"; fi
}

A=aaaaaaaa-0000-4000-8000-000000000001
B=bbbbbbbb-0000-4000-8000-000000000002
C=cccccccc-0000-4000-8000-000000000003
SA1=a1a1a1a1-0000-4000-8000-000000000011
SA2=a2a2a2a2-0000-4000-8000-000000000012
SB1=b1b1b1b1-0000-4000-8000-000000000013
CA1=ca000001-0000-4000-8000-000000000021
CB1=cb000001-0000-4000-8000-000000000022
SVA=5a000001-0000-4000-8000-000000000031
SVB=5b000001-0000-4000-8000-000000000032
VRA=7a000001-0000-4000-8000-000000000041
VRB=7b000001-0000-4000-8000-000000000042
LOC=10c00001-0000-4000-8000-000000000051

ins() { # account staff client start end buffer status [capacity]
  local acct="$1" staff="$2" client="$3" s="$4" e="$5" buf="$6" status="$7" cap="${8:-1}"
  local hold="NULL"; [ "$status" = "pending" ] && hold="now() + interval '2 hours'"
  echo "INSERT INTO bookings (account_id, staff_id, client_id, service_id, variant_id, starts_at, ends_at, buffer_min, status, hold_expires_at, capacity) VALUES ('$acct', '$staff', '$client', '$SVA', '$VRA', '$s', '$e', $buf, '$status', $hold, $cap);"
}

echo "== Подготовка базы $DB"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB" || exit 2
for f in "$ROOT"/apps/api/migrations/*.sql; do
  admin -f "$f" >/dev/null || { echo "Миграция $f не применилась"; exit 2; }
done
admin -c "ALTER ROLE rezerwapp_app LOGIN PASSWORD 'rezerwapp_app'" >/dev/null

admin <<SQL >/dev/null
INSERT INTO accounts (id, name) VALUES ('$A', 'Salon A'), ('$B', 'Master B'), ('$C', 'Outsider C');
INSERT INTO staff (id, account_id, display_name, public_slug) VALUES
  ('$SA1', '$A', 'A1', 'a1'), ('$SA2', '$A', 'A2', 'a2'), ('$SB1', '$B', 'B1', 'b1');
INSERT INTO clients (id, account_id, name, phone_encrypted, phone_hash) VALUES
  ('$CA1', '$A', 'Client A', '\x01', '\x0a'), ('$CB1', '$B', 'Client B', '\x02', '\x0b');
INSERT INTO services (id, account_id) VALUES ('$SVA', '$A'), ('$SVB', '$B');
INSERT INTO service_variants (id, account_id, service_id, duration_min, buffer_min, price) VALUES
  ('$VRA', '$A', '$SVA', 60, 10, 100), ('$VRB', '$B', '$SVB', 60, 10, 100);
INSERT INTO locations (id, account_id, name, public_slug) VALUES ('$LOC', '$A', 'Salon', 'salon-a');
INSERT INTO location_memberships (location_id, location_account_id, member_account_id, status)
  VALUES ('$LOC', '$A', '$B', 'active');
INSERT INTO consent_documents (type, language, version, body) VALUES ('terms', 'pl', '1', 'Regulamin');
SQL

echo "== Роль приложения"
assert_eq "роль приложения не обходит RLS и не суперпользователь" "f|f" \
  "$(admin -c "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname='rezerwapp_app'" | tr -d ' ')"
assert_eq "RLS включён и FORCE на всех таблицах арендаторов" "0" \
  "$(admin -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('consent_documents') AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")"

echo "== Гонка: 20 параллельных заявок на один слот"
RACE_DIR="$(mktemp -d)"
for i in $(seq 1 20); do
  (
    app "$A" "$(ins "$A" "$SA1" "$CA1" '2030-01-07 10:00+00' '2030-01-07 11:00+00' 10 confirmed)
SELECT pg_sleep(0.4);" >"$RACE_DIR/err.$i" 2>&1
    echo $? >"$RACE_DIR/st.$i"
  ) &
done
wait
OK_COUNT=$(cat "$RACE_DIR"/st.* | grep -c '^0$')
CONFLICTS=$(cat "$RACE_DIR"/err.* | grep -ci 'bookings_no_overlap')
assert_eq "ровно одна заявка из 20 прошла" "1" "$OK_COUNT"
assert_eq "остальные 19 отклонены ограничением bookings_no_overlap" "19" "$CONFLICTS"
assert_eq "в базе ровно одна запись на этот слот" "1" \
  "$(admin -c "SELECT count(*) FROM bookings WHERE staff_id='$SA1' AND starts_at='2030-01-07 10:00+00'")"
rm -rf "$RACE_DIR"

echo "== Границы слота и буфер"
assert_eq "слот хранится как [старт, конец+буфер): 10:00..11:10" "[\"2030-01-07 10:00:00+00\",\"2030-01-07 11:10:00+00\")" \
  "$(admin -c "SELECT slot FROM bookings WHERE staff_id='$SA1'")"
assert_fails "запись в 11:00 пересекается с буфером" 'bookings_no_overlap' \
  app "$A" "$(ins "$A" "$SA1" "$CA1" '2030-01-07 11:00+00' '2030-01-07 12:00+00' 10 pending)"
assert_fails "запись внутри занятого интервала отклонена" 'bookings_no_overlap' \
  app "$A" "$(ins "$A" "$SA1" "$CA1" '2030-01-07 10:30+00' '2030-01-07 11:30+00' 0 confirmed)"
app "$A" "$(ins "$A" "$SA1" "$CA1" '2030-01-07 11:10+00' '2030-01-07 12:00+00' 0 confirmed)" >/dev/null \
  && pass "запись ровно после буфера (11:10) разрешена" || fail "запись ровно после буфера (11:10) разрешена"
app "$A" "$(ins "$A" "$SA2" "$CA1" '2030-01-07 10:00+00' '2030-01-07 11:00+00' 10 confirmed)" >/dev/null \
  && pass "тот же час у другого специалиста разрешён" || fail "тот же час у другого специалиста разрешён"

echo "== Освобождение слота"
admin -c "UPDATE bookings SET status='cancelled_by_client' WHERE staff_id='$SA1' AND starts_at='2030-01-07 10:00+00'" >/dev/null
app "$A" "$(ins "$A" "$SA1" "$CA1" '2030-01-07 10:00+00' '2030-01-07 11:00+00' 10 pending)" >/dev/null \
  && pass "после отмены слот снова доступен" || fail "после отмены слот снова доступен"
admin -c "UPDATE bookings SET status='expired', hold_expires_at=NULL WHERE staff_id='$SA1' AND status='pending'" >/dev/null
app "$A" "$(ins "$A" "$SA1" "$CA1" '2030-01-07 10:00+00' '2030-01-07 11:00+00' 10 confirmed)" >/dev/null \
  && pass "после истечения hold слот доступен" || fail "после истечения hold слот доступен"

echo "== capacity > 1 не блокируется ограничением (групповые занятия, v2)"
app "$A" "$(ins "$A" "$SA2" "$CA1" '2030-02-01 10:00+00' '2030-02-01 11:00+00' 0 confirmed 5)
$(ins "$A" "$SA2" "$CA1" '2030-02-01 10:00+00' '2030-02-01 11:00+00' 0 confirmed 5)" >/dev/null \
  && pass "две записи capacity=5 на один час разрешены" || fail "две записи capacity=5 на один час разрешены"

echo "== Целостность бронирования"
assert_fails "pending без hold_expires_at отклонён" 'bookings_pending_has_hold' \
  app "$A" "INSERT INTO bookings (account_id, staff_id, client_id, service_id, variant_id, starts_at, ends_at, status) VALUES ('$A','$SA2','$CA1','$SVA','$VRA','2031-01-01 10:00+00','2031-01-01 11:00+00','pending');"
assert_fails "конец раньше начала отклонён понятной ошибкой" 'ends_at must be after starts_at' \
  app "$A" "$(ins "$A" "$SA2" "$CA1" '2031-01-01 12:00+00' '2031-01-01 11:00+00' 0 confirmed)"
assert_fails "неизвестный статус отклонён" 'violates check constraint' \
  app "$A" "$(ins "$A" "$SA2" "$CA1" '2031-02-01 10:00+00' '2031-02-01 11:00+00' 0 teleported)"

echo "== Изоляция Account (RLS)"
assert_eq "Account A видит только свои 1 клиента" "1" "$(app "$A" "SELECT count(*) FROM clients;")"
assert_eq "Account B не видит клиентов A" "0" "$(app "$B" "SELECT count(*) FROM clients WHERE id='$CA1';")"
assert_eq "без контекста Account строк не видно (fail closed)" "0" "$(app_nocontext "SELECT count(*) FROM clients;")"
assert_eq "Account B не видит брони A" "0" "$(app "$B" "SELECT count(*) FROM bookings;")"
assert_eq "UPDATE чужих строк затрагивает 0 строк" "0" "$(app "$B" "WITH u AS (UPDATE clients SET name='hacked' WHERE id='$CA1' RETURNING 1) SELECT count(*) FROM u;")"
assert_eq "DELETE чужих строк затрагивает 0 строк" "0" "$(app "$B" "WITH d AS (DELETE FROM clients WHERE id='$CA1' RETURNING 1) SELECT count(*) FROM d;")"
assert_eq "имя клиента A не изменилось" "Client A" "$(admin -c "SELECT name FROM clients WHERE id='$CA1'")"
assert_fails "вставка строки в чужой Account отклонена (WITH CHECK)" 'row-level security' \
  app "$B" "INSERT INTO clients (account_id, name, phone_encrypted, phone_hash) VALUES ('$A', 'x', '\\x03', '\\x0c');"
assert_fails "смена account_id своей строки на чужой отклонена" 'row-level security' \
  app "$B" "UPDATE clients SET account_id='$A' WHERE id='$CB1';"
assert_fails "бронь Account B на клиента Account A отклонена (составной FK)" 'foreign key|violates' \
  app "$B" "INSERT INTO bookings (account_id, staff_id, client_id, service_id, variant_id, starts_at, ends_at, status) VALUES ('$B','$SB1','$CA1','$SVB','$VRB','2032-01-01 10:00+00','2032-01-01 11:00+00','confirmed');"
assert_eq "Account видит только себя в accounts" "1" "$(app "$A" "SELECT count(*) FROM accounts;")"
assert_eq "посторонний Account C не видит подключений" "0" "$(app "$C" "SELECT count(*) FROM location_memberships;")"
assert_eq "салон A видит подключение мастера" "1" "$(app "$A" "SELECT count(*) FROM location_memberships;")"
assert_eq "мастер B видит своё подключение" "1" "$(app "$B" "SELECT count(*) FROM location_memberships;")"
assert_eq "салон A не видит клиентов подключённого мастера B" "0" "$(app "$A" "SELECT count(*) FROM clients WHERE account_id='$B';")"

echo "== Права роли приложения"
admin -c "INSERT INTO booking_events (account_id, booking_id, type, actor) SELECT account_id, id, 'created', 'system' FROM bookings LIMIT 1" >/dev/null
assert_fails "UPDATE журнала событий запрещён" 'permission denied' app "$A" "UPDATE booking_events SET type='x';"
assert_fails "DELETE журнала событий запрещён" 'permission denied' app "$A" "DELETE FROM booking_events;"
assert_fails "DELETE аудита запрещён" 'permission denied' app "$A" "DELETE FROM audit_log;"
app "$A" "INSERT INTO audit_log (account_id, action) VALUES ('$A', 'client.read');" >/dev/null \
  && pass "добавление в аудит разрешено" || fail "добавление в аудит разрешено"
assert_eq "юридические тексты читаются" "1" "$(app "$A" "SELECT count(*) FROM consent_documents;")"
assert_fails "юридические тексты нельзя менять" 'permission denied' app "$A" "INSERT INTO consent_documents VALUES ('terms','ru','1','x');"

echo "== Ограничения услуг (D-014, D-010)"
assert_fails "процент задатка выше 50% отклонён" 'services_deposit_percent_cap' \
  app "$A" "INSERT INTO services (account_id, prepayment_method, deposit_mode, deposit_value) VALUES ('$A', 'manual_blik', 'percent', 60);"
assert_fails "задаток без способа предоплаты отклонён" 'services_deposit_needs_method' \
  app "$A" "INSERT INTO services (account_id, prepayment_method, deposit_mode, deposit_value) VALUES ('$A', 'none', 'fixed', 30);"
assert_fails "сумма при режиме none отклонена" 'services_deposit_none_zero' \
  app "$A" "INSERT INTO services (account_id, deposit_mode, deposit_value) VALUES ('$A', 'none', 10);"
app "$A" "INSERT INTO services (account_id, prepayment_method, deposit_mode, deposit_value) VALUES ('$A', 'manual_blik', 'percent', 50);" >/dev/null \
  && pass "ровно 50% разрешено" || fail "ровно 50% разрешено"

echo "== Уникальность"
assert_fails "дубль телефона (хеша) внутри Account отклонён" 'duplicate key' \
  app "$A" "INSERT INTO clients (account_id, name, phone_encrypted, phone_hash) VALUES ('$A', 'dup', '\\x09', '\\x0a');"
app "$B" "INSERT INTO clients (account_id, name, phone_encrypted, phone_hash) VALUES ('$B', 'same phone other account', '\\x09', '\\x0a');" >/dev/null \
  && pass "тот же хеш телефона в другом Account разрешён (баз не склеиваем)" || fail "тот же хеш телефона в другом Account разрешён"

echo
echo "Итого: ok=$PASS fail=$FAIL"
psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1
[ "$FAIL" -eq 0 ]
