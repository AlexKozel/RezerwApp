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

## Разработка

Нужны Node 22+, pnpm 10, PostgreSQL 16 и Redis 7 (или Docker) и `psql`.

```bash
pnpm install --frozen-lockfile
docker compose up -d         # PostgreSQL 16 и Redis (или свой PostgreSQL)
cp .env.example .env
set -a; . ./.env; set +a     # pnpm и node сами .env не читают: переменные нужны в окружении
pnpm build                   # shared, затем api
pnpm db:migrate              # применяет apps/api/migrations ролью-мигратором
psql "$MIGRATOR_DATABASE_URL" -c "ALTER ROLE rezerwapp_app LOGIN PASSWORD 'rezerwapp_app'"
pnpm typecheck
pnpm test                    # PostgreSQL (TEST_PG_ADMIN_URL) и Redis (TEST_REDIS_URL, по умолчанию localhost:6380)
pnpm verify:db               # гонки, EXCLUDE, RLS и права на живой БД, без Node
pnpm --filter @rezerwapp/api start   # затем: curl localhost:$PORT/health → {"status":"ok"}
```

Доступ мастеру в alpha выдаётся вручную (D-005), публичной регистрации нет. Пароль читается из stdin
или `MASTER_PASSWORD`, чтобы не попасть в историю shell:

```bash
pnpm create-master --email anna@example.pl --account "Anna Nails" --slug anna-nails --name "Anna"
```

Уведомления (D-052) уходят через очередь `notifications`. Пока провайдеры не подключены, email и SMS работают
в песочнице: доставка проходит целиком и видна в `notification_log` со статусом `sandbox`, но сообщения не отправляются.

Фоновые задачи (истечение hold, напоминания мастеру и клиенту, доставка уведомлений, D-049) по умолчанию работают в процессе API.
Для отдельного процесса: API с `WORKERS=false` и `pnpm --filter @rezerwapp/api worker`.

Юридические тексты лежат в `legal/` (сейчас заглушки, см. `legal/README.md`) и публикуются командой
`pnpm legal:publish <версия>`. Без опубликованных `terms` и `privacy` публичная запись отвечает `LEGAL_TEXTS_MISSING`.
После публикации документов платформы (`platform_terms`, `dpa`, `platform_privacy`) кабинет Account открывается
только после их принятия owner'ом (`GET /legal/platform`, `POST /legal/accept`, D-055).

Администрирование в alpha (D-057): `pnpm admin` (список Account, карточка, приостановка, план, SMS).

### Виджет записи клиента (`apps/widget`, D-058)

Next.js, серверный рендер, PL/UK/RU/EN. Страницы: `/{slug}` (специалист и запись), `/b/{token}` (управление
записью), `/l/{slug}` (страница салона), `/{slug}/legal/{type}` (документы).

```bash
# API на 3001 (PORT=3001 в .env) с TRUST_PROXY=loopback, затем:
pnpm --filter @rezerwapp/widget dev        # http://localhost:3002/<slug мастера>
```

### PWA мастера (`apps/pwa`, D-059)

React SPA (Vite): вход, календарь и заявки, ручная запись, клиенты, результаты, настройки. Устанавливается на
телефон как приложение.

```bash
pnpm --filter @rezerwapp/pwa dev           # http://localhost:5173 (API на 3001)
```

Адрес виджета для ссылки «link in bio» в настройках: переменная сборки `VITE_PUBLIC_URL`.

В браузере виджет и PWA обращаются к `/api` своего домена: в разработке это прокси Next на `API_URL`, в проде
`/api` должен вести на API через обратный прокси (nginx), а у API `TRUST_PROXY=1`.

API (все ответы JSON, ошибки вида `{"error": "CODE"}`):

| Кто (роли D-047) | Эндпоинты |
|---|---|
| Любой вошедший (cookie `rz_sid`) | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/password`; чтение `GET /staff`, `/policies`, `/services` |
| owner | `GET/POST /users`, `PATCH/DELETE /users/:id`; `GET/PATCH /account/payment` (BLIK, D-048); `POST /staff`, `POST /policies`, `POST /services`, `PATCH /services/:id`, `POST /services/:id/variants`, `PATCH /variants/:id`, `PUT/DELETE /staff/:id/services/:serviceId` |
| owner, assistant (все специалисты); staff (только свой) | `GET /staff/:id/settings` (`PATCH` без assistant); `GET/PUT /staff/:id/working-hours`; `POST /staff/:id/days-off`; `GET/POST /staff/:id/time-blocks`, `DELETE /staff/:id/time-blocks/:blockId`; `GET /staff/:id/slots`; `GET /bookings`, `POST /bookings/:id/transition` |
| CRM (D-050): owner, assistant (вся база); staff (свои клиенты) | `GET/POST /clients` (`?search=` телефон или имя), `GET/PATCH /clients/:id`; заметки `GET/POST /clients/:id/notes`, `DELETE /clients/:id/notes/:noteId` и blacklist `POST/DELETE /clients/:id/blacklist` без assistant; только owner: `GET /clients/export?format=json\|csv`, `POST /clients/import[?dryRun=true]` (тело `text/csv`, D-054), `DELETE /clients/:id` (анонимизация), `GET /audit` |
| Салоны (D-053) | owner: `GET/POST /locations`, `PATCH /locations/:id`, `PUT /staff/:id/location`, `POST /locations/:id/invites`, `GET /memberships`, `POST /memberships/accept`, `POST /memberships/:id/end`; owner и assistant: `GET /locations` и `GET /locations/:id/calendar?from&to` |
| Документы и аналитика | любой вошедший: `GET /legal/platform`; owner: `POST /legal/accept`; owner и staff (свои записи): `GET /analytics/summary?from&to[&commissionPercent]` (D-056) |
| Клиент (без входа) | `GET /public/staff/:slug/legal/:type`, `GET /public/locations/:slug` (Studio page), `GET /public/staff/:slug`, `GET /public/staff/:slug/slots?variantId&from&to`, `POST /public/otp`, `POST /public/staff/:slug/bookings` (ответ содержит `manageToken`); по ссылке (D-051): `GET /public/bookings/:token`, `GET /public/bookings/:token/slots?from&to`, `POST /public/bookings/:token/cancel`, `POST /public/bookings/:token/reschedule` |

Без локального `psql` (например, на Windows) psql и проверку БД можно запустить в контейнере:

```bash
docker compose exec postgres psql -U rezerwapp -d rezerwapp -c "ALTER ROLE rezerwapp_app LOGIN PASSWORD 'rezerwapp_app'"
docker run --rm --network rezerwapp_default -v "$PWD:/repo:ro" \
  -e PG_ADMIN_URL=postgres://rezerwapp:rezerwapp@postgres:5432/postgres postgres:16 bash /repo/scripts/verify-db.sh
```

Структура: `apps/api` (NestJS: миграции; модули `auth`, `catalog`, `availability`, `bookings`, `clients`,
`public`; `crypto` для паролей, HMAC телефона и шифрования полей), `packages/shared` (статусы записи, i18n
PL/UK/RU/EN, нормализация телефона), `scripts/verify-db.sh` (проверка БД), `.github/workflows/ci.yml`.

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
