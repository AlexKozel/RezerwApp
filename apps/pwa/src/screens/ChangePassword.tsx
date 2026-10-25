import { useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { newPasswordError } from '../lib/password';

/**
 * Смена пароля. forced: сотрудник вошёл по временному паролю от owner'а (D-061), без смены приложение закрыто
 * (API отвечает PASSWORD_CHANGE_REQUIRED).
 */
export function ChangePassword({ forced, onChanged, onLogout }: { forced: boolean; onChanged: () => void; onLogout?: () => void }) {
  const { t } = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const local = newPasswordError(current, next, repeat);
    if (local) return setMessage({ ok: false, text: t(local) });
    setBusy(true);
    const r = await api('POST', '/auth/password', { currentPassword: current, newPassword: next });
    setBusy(false);
    if (r.ok) {
      setCurrent('');
      setNext('');
      setRepeat('');
      setMessage({ ok: true, text: t('pwa.pwd.saved') });
      onChanged();
    } else {
      setMessage({ ok: false, text: t(r.status === 401 ? 'pwa.pwd.wrong' : r.status === 400 ? 'pwa.pwd.same' : 'pwa.error') });
    }
  }

  return (
    <main>
      <h1>{t('pwa.pwd.title')}</h1>
      {forced && <p className="notice warn">{t('pwa.pwd.required')}</p>}
      <form onSubmit={(e) => void submit(e)}>
        <label htmlFor="pcur">{t('pwa.pwd.current')}</label>
        <input id="pcur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        <label htmlFor="pnew">{t('pwa.pwd.new')}</label>
        <input id="pnew" type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
        <label htmlFor="prep">{t('pwa.pwd.repeat')}</label>
        <input id="prep" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
        {message && (
          <p className={`notice ${message.ok ? 'ok' : 'error'}`} role="status">
            {message.text}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {t('pwa.pwd.save')}
        </button>
      </form>
      {forced && onLogout && (
        <button type="button" className="secondary" onClick={() => void api('POST', '/auth/logout').then(onLogout)}>
          {t('pwa.logout')}
        </button>
      )}
    </main>
  );
}
