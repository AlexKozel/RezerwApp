import type { NextConfig } from 'next';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

const config: NextConfig = {
  // Сборка для контейнера: server.js с минимумом зависимостей.
  output: 'standalone',
  poweredByHeader: false,
  // Доступ к dev-серверу с телефона в локальной сети (pnpm dev:lan, D-062).
  allowedDevOrigins: process.env.DEV_ORIGINS?.split(','),
  // В браузере виджет обращается к /api того же домена; в проде это делает обратный прокси.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        // Ссылка управления записью содержит токен: не индексировать и не передавать в Referer.
        source: '/b/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

export default config;
