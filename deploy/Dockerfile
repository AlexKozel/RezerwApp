# Сборка всего монорепозитория и три образа (D-073):
#   api    — API NestJS с фоновыми задачами; та же сборка для разовых команд (миграции, create-master, legal:publish);
#   widget — страница записи клиента (Next.js standalone);
#   web    — Caddy: HTTPS, статика PWA мастера, прокси /api.
# Сборка: из корня репозитория, docker compose -f deploy/compose.yml build.

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/widget/package.json apps/widget/
COPY apps/pwa/package.json apps/pwa/
RUN pnpm install --frozen-lockfile
COPY . .
# Адрес страницы записи нужен PWA при сборке: ссылка «link in bio» в настройках мастера.
ARG PUBLIC_URL=https://localhost
ENV VITE_PUBLIC_URL=$PUBLIC_URL NEXT_TELEMETRY_DISABLED=1 API_URL=http://api:3001
RUN pnpm --filter @rezerwapp/shared build \
 && pnpm --filter @rezerwapp/api build \
 && pnpm --filter @rezerwapp/pwa build \
 && pnpm --filter @rezerwapp/widget build

# API: dist, миграции и тексты legal/ ищутся вверх от dist, поэтому структура репозитория сохраняется.
FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]

# Виджет: самодостаточная сборка Next (output: 'standalone') плюс статика.
FROM node:22-bookworm-slim AS widget
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3002 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/widget/.next/standalone ./
COPY --from=build /app/apps/widget/.next/static ./apps/widget/.next/static
USER node
EXPOSE 3002
CMD ["node", "apps/widget/server.js"]

# Caddy: сертификаты Let's Encrypt, PWA как статика, /api на API.
FROM caddy:2.10 AS web
COPY --from=build /app/apps/pwa/dist /srv/pwa
COPY deploy/Caddyfile /etc/caddy/Caddyfile
