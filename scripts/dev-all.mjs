#!/usr/bin/env node
// Локальный запуск всего проекта одной командой (D-062): PostgreSQL и Redis в Docker, сборка, миграции,
// демо-данные, затем API (с фоновыми задачами), виджет клиента и PWA мастера с перезапуском при изменениях.
//
//   pnpm dev:all              # поднять всё
//   pnpm dev:lan              # то же, плюс доступ с телефона в той же сети Wi-Fi
//   pnpm demo:reset           # пересоздать демо-данные (серверы не запускаются)
//
// Без зависимостей: только Node. Работает в Windows (Git Bash, PowerShell) и Linux/macOS.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const resetDemo = args.has('--reset');
const runServers = !args.has('--no-run');
const lan = args.has('--lan');
const isWindows = process.platform === 'win32';

/**
 * Адрес компьютера в домашней сети для телефона. Виртуальные адаптеры (WSL, Hyper-V, Docker, VirtualBox)
 * пропускаем: телефон до них не достанет. Частные диапазоны 192.168/10 впереди 172.16-31 (там часто WSL).
 */
function lanAddress() {
  const candidates = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (/vEthernet|WSL|Hyper-V|docker|br-|veth|VirtualBox|VMware|Loopback/i.test(name)) continue;
    for (const a of addresses ?? []) if (a.family === 'IPv4' && !a.internal) candidates.push(a.address);
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return candidates.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

const PORTS = { api: 3001, widget: 3002, pwa: 5173 };
const COLORS = { api: 36, worker: 35, widget: 33, pwa: 32, tsc: 90 };

/**
 * Аргументы для spawn. В Windows pnpm и docker доступны через .cmd-обёртки и запускаются через оболочку;
 * тогда передаём одну строку с кавычками (иначе путь вроде C:\Program Files\nodejs\node.exe рвётся на пробеле).
 * Node запускаем напрямую, без оболочки.
 */
function command(cmd, cmdArgs) {
  if (!isWindows || cmd === process.execPath) return [cmd, cmdArgs, {}];
  const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  return [[cmd, ...cmdArgs].map(quote).join(' '), [], { shell: true }];
}

function step(text) {
  console.log(`\n\x1b[1m▶ ${text}\x1b[0m`);
}

function fail(text) {
  console.error(`\n\x1b[31m✖ ${text}\x1b[0m`);
  process.exit(1);
}

/** Синхронная команда с выводом в консоль; при ошибке остановка с понятным сообщением. */
function run(cmd, cmdArgs, { env, hint } = {}) {
  const [file, fileArgs, options] = command(cmd, cmdArgs);
  const result = spawnSync(file, fileArgs, { cwd: root, stdio: 'inherit', env, ...options });
  if (result.status !== 0) fail(`${path.basename(cmd)} ${cmdArgs.join(' ')} завершилась с ошибкой${hint ? `\n  ${hint}` : ''}`);
}

/** .env (создаётся из .env.example при первом запуске) + обязательные значения для локальной схемы. */
function loadEnv(host) {
  const file = path.join(root, '.env');
  if (!existsSync(file)) {
    copyFileSync(path.join(root, '.env.example'), file);
    console.log('  .env создан из .env.example');
  }
  const env = { ...process.env };
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  // Локальная схема портов: 3000 часто занят (open-webui и т.п.), поэтому API на 3001.
  return {
    ...env,
    PORT: String(PORTS.api),
    TRUST_PROXY: 'loopback',
    // Ссылки в уведомлениях и «link in bio» должны открываться там, где тестируют: с телефона это адрес в сети.
    PUBLIC_URL: `http://${host}:${PORTS.widget}`,
    API_URL: `http://localhost:${PORTS.api}`,
    VITE_PUBLIC_URL: `http://${host}:${PORTS.widget}`,
    // Next в разработке отдаёт свои скрипты только разрешённым адресам, иначе страница с телефона не оживает.
    ...(host !== 'localhost' && { DEV_ORIGINS: host }),
    NEXT_TELEMETRY_DISABLED: '1',
    FORCE_COLOR: '1',
  };
}

function portBusy(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Долгоживущий процесс с подписанными строками вывода. */
const children = [];
function start(name, cmd, cmdArgs, env, onLine) {
  const [file, fileArgs, options] = command(cmd, cmdArgs);
  const child = spawn(file, fileArgs, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const prefix = `\x1b[${COLORS[name] ?? 37}m[${name}]\x1b[0m `;
  const pipe = (stream) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        process.stdout.write(prefix + line + '\n');
        onLine?.(line);
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => {
    if (!stopping && !child.restarting) console.log(`${prefix}завершился (код ${code})`);
  });
  children.push(child);
  return child;
}

function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  // В Windows shell-процесс держит дочерние: убиваем дерево целиком.
  if (isWindows) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  console.log('\nОстанавливаю процессы…');
  for (const child of children) kill(child);
  setTimeout(() => process.exit(0), 500);
}

/**
 * API перезапускается по сигналу tsc --watch об успешной пересборке, а не через node --watch: тот в Windows
 * ловит ложные события файловой системы при подгрузке модулей и перезапускает API посреди запросов.
 */
function startApi(env) {
  let api = null;
  const launch = () => {
    api = start('api', process.execPath, ['apps/api/dist/main.js'], env);
  };
  const restart = () => {
    if (!api || api.exitCode !== null || api.signalCode !== null) return launch();
    api.restarting = true;
    api.once('exit', () => !stopping && launch());
    kill(api);
  };
  start('tsc', 'pnpm', ['--filter', '@rezerwapp/api', 'exec', 'tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], env, (line) => {
    if (/Found 0 errors/.test(line)) restart();
  });
}

async function waitFor(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // ещё не поднялся
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  step('Проверка Docker');
  const [dockerFile, dockerArgs, dockerOptions] = command('docker', ['info', '--format', '{{.ServerVersion}}']);
  const docker = spawnSync(dockerFile, dockerArgs, { encoding: 'utf8', ...dockerOptions });
  if (docker.status !== 0) fail('Docker не отвечает. Запустите Docker Desktop и повторите.');
  console.log(`  Docker ${docker.stdout.trim()}`);

  if (runServers) {
    for (const [name, port] of Object.entries(PORTS)) {
      if (await portBusy(port)) fail(`Порт ${port} (${name}) занят. Остановите процесс на нём или предыдущий запуск dev:all.`);
    }
  }

  const host = lan ? lanAddress() : 'localhost';
  if (!host) fail('Не найден адрес в локальной сети: подключите компьютер к Wi-Fi или запустите pnpm dev:all.');
  const env = loadEnv(host);

  step('PostgreSQL и Redis');
  run('docker', ['compose', 'up', '-d', '--wait', 'postgres', 'redis'], { env, hint: 'docker compose logs postgres redis' });

  step('Сборка shared и API');
  run('pnpm', ['--filter', '@rezerwapp/shared', 'build'], { env });
  run('pnpm', ['--filter', '@rezerwapp/api', 'build'], { env });

  step('Миграции');
  run(process.execPath, ['apps/api/dist/db/migrate-cli.js'], { env });

  step(resetDemo ? 'Демо-данные: пересоздание' : 'Демо-данные');
  run(process.execPath, ['apps/api/dist/cli/demo.js', resetDemo ? 'reset' : 'seed'], { env });

  if (!runServers) return;

  step('Запуск API, виджета и PWA (Ctrl+C: остановить всё)');
  process.on('SIGINT', stopAll);
  process.on('SIGTERM', stopAll);
  startApi(env);
  // Без --lan серверы слушают только этот компьютер: демо-пароли известны всем, кто читал README.
  // --force: Vite заново собирает @rezerwapp/shared (CommonJS, D-059), иначе берёт из кэша старые переводы.
  start('widget', 'pnpm', ['--filter', '@rezerwapp/widget', 'dev', '--hostname', lan ? '0.0.0.0' : 'localhost'], env);
  start('pwa', 'pnpm', ['--filter', '@rezerwapp/pwa', 'dev', '--strictPort', '--force', '--host', lan ? '0.0.0.0' : 'localhost'], env);

  const ready = await Promise.all([
    waitFor(`http://localhost:${PORTS.api}/health`, 60_000),
    waitFor(`http://localhost:${PORTS.widget}/`, 120_000),
    waitFor(`http://localhost:${PORTS.pwa}/`, 60_000),
  ]);
  const mark = (ok) => (ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✖ не отвечает\x1b[0m');
  console.log(`
\x1b[1mRezerwApp запущен\x1b[0m
  ${mark(ready[2])} PWA мастера        http://${host}:${PORTS.pwa}
       владелец          demo@rezerwapp.local / demo-owner-pass
       сотрудник         kasia@rezerwapp.local / demo-staff-pass
  ${mark(ready[1])} Запись клиента     http://${host}:${PORTS.widget}/demo-studio
       код из SMS (alpha): ${env.ALPHA_OTP_CODE ?? '0000'}
  ${mark(ready[0])} API                http://localhost:${PORTS.api}/health
${
  lan
    ? `
  С телефона: та же сеть Wi-Fi, адреса выше. Не открывается: разрешите Node.js в брандмауэре Windows
  для частных сетей (запрос при первом запуске) и проверьте, что сеть Wi-Fi в Windows «Частная».
  Установка PWA на экран и офлайн по http недоступны (нужен https), остальное работает.
`
    : ''
}
  Демо-данные заново: pnpm demo:reset   Остановить: Ctrl+C
`);
}

main().catch((error) => {
  console.error(error);
  stopAll();
});
