import { useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const { t } = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await api('POST', '/auth/login', { email, password });
    setBusy(false);
    if (r.ok) onLoggedIn();
    else setError(t(r.status === 401 ? 'pwa.login.error' : r.error === 'RATE_LIMITED' ? 'widget.error.rate' : r.error === 'OFFLINE' ? 'pwa.offline' : 'pwa.error'));
  }

  return (
    <main>
      <h1>RezerwApp</h1>
      <form onSubmit={(e) => void submit(e)}>
        <h2>{t('pwa.login.title')}</h2>
        <label htmlFor="email">{t('pwa.login.email')}</label>
        <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="password">{t('pwa.login.password')}</label>
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {t('pwa.login.submit')}
        </button>
      </form>
    </main>
  );
}
