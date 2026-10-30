#!/usr/bin/env bash
# Разовые команды на сервере ролью-мигратором (D-073):
#   bash deploy/tool.sh migrate
#   bash deploy/tool.sh create-master --email anna@example.pl --account "Anna Nails" --slug anna-nails --name "Anna"
#   bash deploy/tool.sh legal:publish 2026-11-01
#   bash deploy/tool.sh admin list
set -euo pipefail
cd "$(dirname "$0")/.."
DC=(docker compose -f deploy/compose.yml --env-file deploy/.env)

command="${1:?Команда: migrate | create-master | legal:publish | admin}"
shift
case "$command" in
  migrate) script=apps/api/dist/db/migrate-cli.js ;;
  create-master) script=apps/api/dist/cli/create-master.js ;;
  legal:publish) script=apps/api/dist/cli/legal-publish.js ;;
  admin) script=apps/api/dist/cli/admin.js ;;
  *) echo "Неизвестная команда: $command" >&2; exit 1 ;;
esac
# -it: create-master спрашивает пароль, не оставляя его в истории shell.
if [ -t 0 ]; then tty=(-it); else tty=(-T); fi
exec "${DC[@]}" run --rm "${tty[@]}" tools node "$script" "$@"
