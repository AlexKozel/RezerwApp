#!/usr/bin/env bash
# Первый запуск на сервере (D-073): секреты, база, миграции, пароль роли приложения, запуск.
#   bash deploy/first-run.sh rezerwapp.pl admin@rezerwapp.pl
# Повторный запуск безопасен: секреты не перегенерируются, миграции применяются только новые.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=deploy/.env
DC=(docker compose -f deploy/compose.yml --env-file "$ENV_FILE")

if [ ! -f "$ENV_FILE" ]; then
  DOMAIN="${1:?Укажите домен, например: bash deploy/first-run.sh rezerwapp.pl admin@rezerwapp.pl}"
  EMAIL="${2:?Укажите email для сертификатов HTTPS}"
  # Только буквы и цифры: пароли попадают в адреса подключения и в SQL без экранирования.
  rand() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | cut -c1-"$1"; }
  umask 077
  cat > "$ENV_FILE" <<EOF
DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
POSTGRES_PASSWORD=$(rand 32)
APP_DB_PASSWORD=$(rand 32)
# Секрет поиска клиентов по номеру (D-042). НЕ МЕНЯТЬ после появления данных.
PHONE_HASH_PEPPER=$(rand 48)
# Ключ шифрования телефонов и заметок (D-042). Потеря = данные не расшифровать.
FIELD_MASTER_KEY=$(openssl rand -base64 32)
# Код из SMS для альфы (D-035), пока нет SMS-провайдера: знают только тестировщики.
ALPHA_OTP_CODE=$(( 100000 + RANDOM % 900000 ))
EOF
  echo "Создан $ENV_FILE. Сохраните его копию вне сервера (менеджер паролей): без него не расшифровать данные."
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

"${DC[@]}" build
"${DC[@]}" up -d postgres redis
"${DC[@]}" run --rm tools node apps/api/dist/db/migrate-cli.js
# Роль приложения создаётся миграцией без входа; пароль задаётся здесь (README, раздел про БД).
"${DC[@]}" exec -T postgres psql -U rezerwapp -d rezerwapp -v ON_ERROR_STOP=1 -q \
  -c "ALTER ROLE rezerwapp_app LOGIN PASSWORD '$APP_DB_PASSWORD'"
"${DC[@]}" up -d

cat <<EOF

Готово.
  Страница записи:   https://$DOMAIN/<slug мастера>
  Кабинет мастера:   https://app.$DOMAIN
  Код из SMS (альфа): $ALPHA_OTP_CODE

Дальше:
  1. Тексты документов (без них запись клиентов закрыта):  bash deploy/tool.sh legal:publish <версия>
  2. Доступ мастеру:  bash deploy/tool.sh create-master --email anna@example.pl --account "Anna Nails" --slug anna-nails --name "Anna"
  3. Резервные копии по расписанию: deploy/README.md
EOF
