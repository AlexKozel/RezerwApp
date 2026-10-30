# Развёртывание на сервере (D-073)

Один VPS в Польше, Docker Compose, Caddy с бесплатными сертификатами Let's Encrypt. Подходит для альфы
на знакомых мастерах. Снаружи открыты только порты 80 и 443.

| Адрес | Что |
|---|---|
| `https://ваш-домен/<slug>` | Страница записи клиента (ссылка в био мастера) |
| `https://app.ваш-домен` | Кабинет мастера (PWA, ставится на телефон) |
| `https://ваш-домен/api/health` | Проверка, что API жив (для мониторинга) |

## Что понадобится

- **Сервер:** OVHcloud VPS-1, локация Warszawa, Ubuntu 24.04 (около €4,5 в месяц). Подойдёт любой VPS
  с Ubuntu и от 2 ГБ памяти.
- **Домен**, например `.pl`.
- **Доступ к репозиторию на GitHub** (ключ только для чтения, шаг 3).

## 1. Домен

В панели регистратора домена создайте две записи типа **A** на IP-адрес сервера:

| Имя | Тип | Значение |
|---|---|---|
| `@` (сам домен) | A | IP сервера |
| `app` | A | IP сервера |

Записи начинают работать за минуты, иногда за несколько часов. Сертификат Caddy получит, когда домен уже
указывает на сервер.

## 2. Сервер

Войдите по SSH (`ssh root@IP`) и выполните:

```bash
apt update && apt -y upgrade
apt -y install git unattended-upgrades ufw
# Автоматические обновления безопасности системы.
dpkg-reconfigure -f noninteractive unattended-upgrades
# Брандмауэр: только SSH, HTTP и HTTPS.
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
# Docker из официального скрипта.
curl -fsSL https://get.docker.com | sh
```

## 3. Код

Репозиторий закрытый, поэтому серверу нужен свой ключ только для чтения:

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/github_deploy
cat ~/.ssh/github_deploy.pub
```

Скопируйте выведенный ключ в GitHub: репозиторий → Settings → Deploy keys → Add deploy key (без права записи).
Затем:

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/github_deploy\n' >> ~/.ssh/config
git clone git@github.com:AlexKozel/RezerwApp.git /opt/rezerwapp
cd /opt/rezerwapp
git checkout main
```

## 4. Первый запуск

```bash
bash deploy/first-run.sh ваш-домен.pl ваш@email.pl
```

Скрипт:
1. создаёт `deploy/.env` со случайными паролями и ключами;
2. собирает образы (несколько минут);
3. применяет миграции и запускает всё.

В конце он печатает адреса и код из SMS для тестировщиков.

**Сразу сохраните копию `deploy/.env` в менеджер паролей.** В нём ключ шифрования телефонов и заметок клиентов
и секрет поиска по номеру. Без этого файла данные из резервной копии не расшифровать, а секрет поиска
нельзя менять после появления данных.

## 5. Документы и мастера

Без опубликованных документов страница записи не принимает записи (`LEGAL_TEXTS_MISSING`). Для теста на
знакомых, которые записываются сами к себе и друг к другу, достаточно черновиков из `legal/`. Для настоящих
клиенток нужны тексты от юриста (`LEGAL_CHECKLIST.md`).

```bash
bash deploy/tool.sh legal:publish 2026-11-01
bash deploy/tool.sh create-master --email anna@example.pl --account "Anna Nails" --slug anna-nails --name "Anna"
```

`create-master` спросит пароль; передайте его мастеру лично. При первом входе мастер принимает документы
платформы.

Код из SMS в альфе один для всех (`ALPHA_OTP_CODE` в `deploy/.env`): сообщите его только тестировщикам.
Настоящих SMS и писем пока нет: уведомления пишутся в журнал, но не отправляются.

## 6. Резервные копии

Ночная копия базы в `deploy/backups` (хранится 14 дней):

```bash
crontab -e
# добавить строку:
15 3 * * * cd /opt/rezerwapp && bash deploy/backup.sh >> /var/log/rezerwapp-backup.log 2>&1
```

Копии на том же сервере не спасут, если пропадёт сам сервер. Вторая копия вне сервера:
1. установите `rclone`;
2. настройте хранилище (`rclone config`, например Backblaze B2 или Hetzner Storage Box);
3. добавьте перед командой в crontab `BACKUP_REMOTE=имя:папка`.

Восстановление (сначала остановить API, чтобы никто не писал в базу):

```bash
DC="docker compose -f deploy/compose.yml --env-file deploy/.env"
$DC stop api widget
$DC exec -T postgres psql -U rezerwapp -d postgres -c "DROP DATABASE rezerwapp WITH (FORCE)" -c "CREATE DATABASE rezerwapp"
$DC exec -T postgres pg_restore -U rezerwapp -d rezerwapp < deploy/backups/<файл>.dump
$DC up -d
```

## 7. Обновление

```bash
cd /opt/rezerwapp && bash deploy/update.sh
```

Скрипт:
1. берёт свежий код;
2. собирает образы;
3. делает резервную копию;
4. применяет миграции;
5. перезапускает.

Сервер стоит на ветке `main`: обновляйте после слияния и зелёного CI.

## 8. Наблюдение

- Бесплатный мониторинг (например, UptimeRobot) на `https://ваш-домен/api/health`: письмо, если сайт лёг.
- Логи: `docker compose -f deploy/compose.yml --env-file deploy/.env logs -f api` (и `widget`, `web`).
- Состояние: `... ps`.

## Проверка без сервера

Ту же сборку можно поднять на своей машине, с адресом `localhost`. Создайте `deploy/.env` вручную:
- `DOMAIN=localhost`, `HTTP_PORT=8080`, `HTTPS_PORT=8443`, `PUBLIC_PORT_SUFFIX=:8443`;
- остальные значения как в `first-run.sh`.

Затем запустите `bash deploy/first-run.sh`. Caddy выдаст локальный сертификат, браузер предупредит о нём.
Кабинет будет на `https://app.localhost:8443`.
