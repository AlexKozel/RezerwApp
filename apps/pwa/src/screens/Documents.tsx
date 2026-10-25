import { useEffect, useState } from 'react';
import { api, type Me } from '../api';
import { useT } from '../i18n';

interface PlatformDoc {
  type: string;
  version: string;
  language: string;
  body: string;
  accepted: boolean;
}

/** Принятие документов платформы (D-055): пока owner не примет, кабинет закрыт для всех ролей. */
export function Documents({ me, onAccepted, onLogout }: { me: Me; onAccepted: () => void; onLogout: () => void }) {
  const { t } = useT();
  const [docs, setDocs] = useState<PlatformDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<PlatformDoc[]>('GET', '/legal/platform').then((r) => setDocs(r.data ?? []));
  }, []);

  async function accept() {
    const pending = (docs ?? []).filter((d) => !d.accepted).map((d) => ({ type: d.type, version: d.version }));
    const r = await api('POST', '/legal/accept', { documents: pending });
    if (r.ok) onAccepted();
    else setError(t('pwa.error'));
  }

  async function logout() {
    await api('POST', '/auth/logout');
    onLogout();
  }

  return (
    <main>
      <h1>{t('pwa.docs.title')}</h1>
      <p>{t('pwa.docs.intro')}</p>
      {(docs ?? [])
        .filter((d) => !d.accepted)
        .map((d) => (
          <details key={d.type} className="card" lang={d.language}>
            <summary>{d.body.split('\n')[0]!.replace(/^#\s*/, '')}</summary>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{d.body}</div>
            <p className="muted">v. {d.version}</p>
          </details>
        ))}
      {error && <p className="notice error">{error}</p>}
      {me.role === 'owner' ? (
        <button type="button" className="primary" disabled={!docs} onClick={() => void accept()}>
          {t('pwa.docs.accept')}
        </button>
      ) : (
        <p className="notice warn">{t('pwa.docs.owner_only')}</p>
      )}
      <button type="button" className="secondary" onClick={() => void logout()}>
        {t('pwa.logout')}
      </button>
    </main>
  );
}
