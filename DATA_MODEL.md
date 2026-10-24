# Модель данных

Связано: `DECISIONS.md` (D-020…D-025, D-031, D-032, D-037), `ARCHITECTURE.md`.
Это логическая модель. Типы и имена уточняются при написании миграций.

## 1. Иерархия и владение

```
Account (подписка, администратор данных)
 ├─ Location (адрес)  ←─ может принимать подключения других Account (Independent)
 ├─ Staff (специалист: мастер / тренер / преподаватель)
 │    ├─ StaffService → Service → ServiceVariant
 │    ├─ WorkingHours / TimeBlock
 │    └─ Booking → Client
 └─ Client (клиентская база Account, не пересекается с другими Account)
```

### Режимы специалиста в салоне (D-021, D-022)

| Режим | Как устроено | Кто администратор данных | Что видит владелец салона |
|---|---|---|---|
| **Employee** | `staff` внутри Account салона | Салон | Всё в рамках Account |
| **Independent** (аренда кресла) | Свой Account, подключён к Location салона через `location_memberships` | Сам мастер | Занятость слотов в календаре Location и данные для расчёта аренды; клиентов, заметки и контакты не видит |

При уходе Independent-мастера `location_memberships.status` становится `ended`. Его Account, клиенты и история не затрагиваются. Страница салона (Studio page) перестаёт показывать этого мастера.

## 2. Основные сущности

| Таблица | Ключевые поля | Примечания |
|---|---|---|
| `accounts` | id, type (`individual`/`business`), plan, locale, timezone, sms_included, status | Единица подписки и ответственности по RODO. |
| `users` | id, account_id, email, role (`owner`,`staff`,`assistant`), auth data | Роли: см. ниже. |
| `locations` | id, account_id, name, address, public_slug | |
| `location_memberships` | location_id, member_account_id, status (`invited`,`active`,`ended`), shared_calendar_scope, started_at, ended_at | Для Independent. |
| `staff` | id, account_id, user_id?, display_name, public_slug, vertical_template | Публичная страница link-in-bio. |
| `services` | id, account_id, name_i18n, category, deposit_mode, cancel_policy_id, requires_manual_confirm, cost_price | `cost_price` для расчёта маржи (MVP). |
| `service_variants` | id, service_id, name_i18n, duration_min, buffer_min, price, custom_fields_schema | Варианты: длина волос, размер питомца, размер татуировки. |
| `staff_services` | staff_id, service_id, override_duration?, override_price? | |
| `working_hours` | staff_id, weekday, start, end | |
| `time_blocks` | staff_id, range, reason | Обед, отпуск, личное. |
| `clients` | id, account_id, name, phone (шифр.), email?, language, trust_level, anonymized_at? | Уникальность телефона только внутри Account. |
| `client_notes` | id, client_id, account_id, body_encrypted, sensitivity (`normal`,`health`), created_at | `health` только при наличии согласия. |
| `consents` | id, client_id, account_id, type (`privacy`,`terms`,`health`,`marketing`), text_version, given_at, ip_hash, revoked_at | |
| `policies` | id, account_id, version, free_cancel_hours, max_reschedules, deposit_on_late_cancel (`keep`,`transfer`,`refund`), texts_i18n | Версионируется, бронь хранит ссылку на конкретную версию. |
| `bookings` | см. ниже | |
| `booking_events` | booking_id, type, actor, payload, at | Append-only журнал статусов и офлайн-событий. |
| `payment_requests` | booking_id, mode (`manual_blik`,`provider_link`), amount, code, status (`requested`,`confirmed`,`kept`,`returned`) | MVP: ручное подтверждение мастером. |
| `blacklist_entries` | account_id, phone_hash, reason?, created_at, expires_at | Приватный для Account. Автоочистка. |
| `notification_log` | id, account_id, booking_id?, channel, template, language, status, cost | |
| `sms_ledger` | account_id, delta, reason, at | Включённые, использованные, докупленные SMS. |
| `audit_log` | account_id, actor_id, action, object, at | Доступ к клиентским данным. |
| `consent_documents` | type, language, version, body, valid_from | Тексты Regulamin и политик. |

## 3. Бронирование

Ключевые поля `bookings`:

| Поле | Назначение |
|---|---|
| `id`, `account_id`, `staff_id`, `client_id`, `service_id`, `variant_id` | Связи. |
| `starts_at`, `ends_at`, `buffer_min` | Время. |
| `slot` | `tstzrange(starts_at, ends_at + буфер, '[)')`, вычисляется приложением, участвует в ограничении. |
| `capacity` | По умолчанию 1. Для групповых занятий (v2) > 1. |
| `status` | `pending`, `confirmed`, `rejected`, `expired`, `cancelled_by_client`, `cancelled_by_master`, `completed`, `no_show`, `rescheduled`. |
| `hold_expires_at` | Только для `pending`. |
| `policy_id`, `policy_version` | Снимок политики на момент брони. |
| `reschedule_count` | Счётчик переносов. |
| `custom_fields` | JSON по схеме варианта услуги (поля вертикали). |
| `version` | Для конфликтов редактирования (оптимистичная блокировка). |

Ограничение от двойной записи:

```sql
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (staff_id WITH =, slot WITH &&)
  WHERE (status IN ('pending','confirmed') AND capacity = 1);
```

## 4. Роли внутри Account

| Роль | Права |
|---|---|
| `owner` | Всё, включая биллинг, экспорт, удаление. |
| `staff` | Свои записи, свои клиенты. У Employee в салоне клиентская база общая внутри Account только если owner включил общий доступ. |
| `assistant` | Расписание и заявки, без заметок и экспорта. |

Роль администратора платформы живёт вне Account и не видит содержимое `client_notes`.

## 5. Хранение и удаление данных

| Данные | Срок по умолчанию | Примечание |
|---|---|---|
| Записи и история визитов | Срок, настроенный Account, плюс требования учёта мастера | Согласовать с юристом. |
| Blacklist | 2 года | Автоочистка. |
| Заметки | Пока клиент активен, удаляются по запросу | |
| Согласия | Срок жизни данных клиента плюс период доказательства | Нужны для доказательства. |
| Логи уведомлений | 12 месяцев | Без содержимого сообщений. |
| Аудит | 24 месяца | |

Запрос клиента на удаление: анонимизация в `clients` (`anonymized_at`), очистка заметок, сохранение агрегатов для финансового учёта мастера.

## 6. Перенос и экспорт клиентской базы

- Экспорт: CSV и JSON по `clients`, `bookings`, `consents` (без чужих Account).
- Для Independent-мастера, уходящего из салона: ничего не переносится, так как база изначально его. Достаточно отключения от Location.
- Для Employee, уходящего из салона: клиентская база принадлежит салону, перенос возможен только по решению owner салона (экспорт и передача файлом, отдельная юридическая основа).
- Маркетинговая рассылка клиентам о смене места требует согласия `marketing` (см. `LEGAL_CHECKLIST.md`).

## 7. Расширяемость для вертикалей

- `service_variants.custom_fields_schema` и `bookings.custom_fields` описывают поля вертикалей (питомец, референс эскиза, тема занятия).
- `vertical_template` на `staff` подставляет шаблон услуг, тексты Regulamin и политику по умолчанию (см. `VERTICALS.md`).
- `client_notes.sensitivity` и режим шифрования определяются уровнем чувствительности вертикали.
