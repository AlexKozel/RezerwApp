#!/usr/bin/env bash
# Обновление на сервере (D-073): свежий код, сборка, резервная копия, миграции, перезапуск.
#   bash deploy/update.sh            # ветка, на которой стоит сервер (обычно main)
set -euo pipefail
cd "$(dirname "$0")/.."
DC=(docker compose -f deploy/compose.yml --env-file deploy/.env)

git pull --ff-only
"${DC[@]}" build
# Копия перед миграциями: откат = восстановить её (deploy/README.md).
bash deploy/backup.sh
"${DC[@]}" run --rm tools node apps/api/dist/db/migrate-cli.js
"${DC[@]}" up -d
docker image prune -f >/dev/null
"${DC[@]}" ps
