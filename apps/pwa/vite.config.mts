import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

/**
 * PWA мастера (D-059): статическое SPA. Браузер обращается к /api того же домена: cookie сессии (HttpOnly,
 * SameSite=Lax, D-041) работает без CORS. В разработке /api проксирует Vite, в проде обратный прокси.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_URL, changeOrigin: false, rewrite: (path) => path.replace(/^\/api/, '') },
    },
  },
  preview: {
    port: 5173,
    proxy: {
      '/api': { target: API_URL, changeOrigin: false, rewrite: (path) => path.replace(/^\/api/, '') },
    },
  },
  // shared собран как CommonJS: Vite должен преобразовать его и в разработке, и при сборке.
  optimizeDeps: { include: ['@rezerwapp/shared'] },
  build: { commonjsOptions: { include: [/shared/, /node_modules/] } },
});
