# RezerwApp: SaaS для записи клиентов к независимым мастерам

Репозиторий: https://github.com/AlexKozel/RezerwApp

> Статус: черновик документации v2 (итерации 1-3 обсуждения). Дата: 2026-10-24.
> Рынок первого запуска: Польша, Варшава. Языки: PL, UK, RU, EN.

## Суть продукта

Инструмент записи для мастеров и небольших студий, которые приводят клиентов из Instagram/TikTok сами.
Не маркетплейс: нет комиссий за клиентов, плоская подписка. Ключевое:
- защита от неявок (запрос на запись, резервационная оплата, политика отмен),
- офлайн-доступ к расписанию (PWA),
- 4 языка,
- архитектура под несколько вертикалей (бьюти, тату, репетиторы, тренеры и т.д.), см. `VERTICALS.md`.

## Карта документов (читать в этом порядке)

| Файл | О чём |
|---|---|
| `DECISIONS.md` | Все принятые и открытые решения с идентификаторами. **Источник правды.** |
| `ARCHITECTURE.md` | Стек, модули, безопасность, офлайн, уведомления. |
| `DATA_MODEL.md` | Сущности, владение данными, ограничения БД. |
| `BOOKING_FLOW.md` | Статусы записи, hold, отмена, перенос, задаток. |
| `LEGAL_CHECKLIST.md` | Юридические и RODO-задачи. Не заменяет юриста. |
| `VERTICALS.md` | План вертикалей и конфигурация под ниши. |
| `UNIT_ECONOMICS.md` | Цена, SMS, расчёты, допущения. |
| `ROADMAP.md` | Этапы MVP / v1.1 / v2, критерии готовности, alpha-тест. |

## Разработка (Sprint 0)

Нужны Node 22+, pnpm 10, PostgreSQL 16 (или Docker) и `psql`.

```bash
pnpm install --frozen-lockfile
docker compose up -d         # PostgreSQL 16 и Redis (или свой PostgreSQL)
cp .env.example .env
set -a; . ./.env; set +a     # pnpm и node сами .env не читают: переменные нужны в окружении
pnpm build                   # shared, затем api
pnpm db:migrate              # применяет apps/api/migrations ролью-мигратором
psql "$MIGRATOR_DATABASE_URL" -c "ALTER ROLE rezerwapp_app LOGIN PASSWORD 'rezerwapp_app'"
pnpm typecheck
pnpm test                    # нужен PostgreSQL: TEST_PG_ADMIN_URL (по умолчанию localhost, rezerwapp/rezerwapp)
pnpm verify:db               # гонки, EXCLUDE, RLS и права на живой БД, без Node
pnpm --filter @rezerwapp/api start   # затем: curl localhost:3000/health → {"status":"ok"}
```

Без локального `psql` (например, на Windows) psql и проверку БД можно запустить в контейнере:

```bash
docker compose exec postgres psql -U rezerwapp -d rezerwapp -c "ALTER ROLE rezerwapp_app LOGIN PASSWORD 'rezerwapp_app'"
docker run --rm --network rezerwapp_default -v "$PWD:/repo:ro" \
  -e PG_ADMIN_URL=postgres://rezerwapp:rezerwapp@postgres:5432/postgres postgres:16 bash /repo/scripts/verify-db.sh
```

Структура: `apps/api` (NestJS, миграции, сервис записей), `packages/shared` (статусы записи, i18n PL/UK/RU/EN,
нормализация телефона), `scripts/verify-db.sh` (проверка БД), `.github/workflows/ci.yml`.

## Как начинать новую рабочую сессию с Claude

Claude не хранит память между чатами. Каждую сессию начинать так:
1. Приложить или открыть `README.md`, `DECISIONS.md` и файл, относящийся к задаче.
2. Назвать задачу и этап из `ROADMAP.md`.
3. После сессии обновить `DECISIONS.md`, если что-то решили или изменили.

## Разделение ролей

- **Claude:** код, тесты, миграции, документация, черновики юридических текстов (на проверку юристу).
- **Владелец проекта:** репозиторий, хостинг (ЕС), домены, аккаунты (SMS, push, платежи, App Store), коммуникация с мастерами, юрист и бухгалтер.

## Глоссарий (PL)

| Термин | Значение |
|---|---|
| Zadatek / zaliczka | Задаток (со штрафными последствиями по ст. 394 KC) / аванс. В интерфейсе слово «zadatek» не используется. |
| Opłata rezerwacyjna | Резервационная оплата (термин интерфейса). |
| Odstępne | Плата за право отказаться от договора (ст. 396 KC). |
| RODO | Польское название GDPR. |
| ADO / Administrator | Администратор данных (по умолчанию мастер или салон). |
| Podmiot przetwarzający | Процессор данных (платформа). |
| DPA / Umowa powierzenia | Договор поручения обработки данных. |
| UODO / UOKiK | Орган по защите данных / орган по защите потребителей. |
| JDG / sp. z o.o. | Индивидуальная деятельность / ООО. |
