#!/usr/bin/env bash
# Резервная копия базы (D-073): дамп в deploy/backups, хранится 14 дней; при BACKUP_REMOTE ещё и копия вне
# сервера через rclone (например, BACKUP_REMOTE=b2:rezerwapp-backups). Телефоны и заметки в дампе зашифрованы:
# для восстановления нужен и дамп, и FIELD_MASTER_KEY из deploy/.env.
#   bash deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DC=(docker compose -f deploy/compose.yml --env-file deploy/.env)

mkdir -p deploy/backups
file="deploy/backups/rezerwapp-$(date +%Y-%m-%d-%H%M).dump"
"${DC[@]}" exec -T postgres pg_dump -U rezerwapp -Fc rezerwapp > "$file"
chmod 600 "$file"
find deploy/backups -name 'rezerwapp-*.dump' -mtime +14 -delete
if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy "$file" "$BACKUP_REMOTE"
fi
echo "Копия: $file ($(du -h "$file" | cut -f1))"
