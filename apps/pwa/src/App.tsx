import type { Locale } from '@rezerwapp/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, onAuthProblem, type Me } from './api';
import { LocaleProvider, initialLocale, saveLocale, useT } from './i18n';
import { go, useRoute } from './router';
import { Calendar } from './screens/Calendar';
import { Catalog, ServiceEditor } from './screens/Catalog';
import { ClientCardScreen, Clients } from './screens/Clients';
import { Documents } from './screens/Documents';
import { Login } from './screens/Login';
import { NewBooking } from './screens/NewBooking';
import { Settings } from './screens/Settings';
import { Stats } from './screens/Stats';

/**
 * PWA мастера (D-059). Состояния: проверка сессии → вход → принятие документов (D-055) → приложение.
 * Роль определяет вкладки: assistant не видит результатов (D-056), остальное ограничивает API.
 */
export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [locale, setLocale] = useState<Locale>(() => initialLocale());

  const refresh = useCallback(async () => {
    const r = await api<Me>('GET', '/auth/me');
    if (r.ok && r.data) {
      setMe(r.data);
      setLocale(initialLocale(r.data.locale));
    } else if (r.status === 401) {
      setMe(null);
    } else {
      setMe((prev) => prev ?? null);
    }
  }, []);

  useEffect(() => {
    onAuthProblem((status) => {
      if (status === 401) setMe(null);
      else void refresh();
    });
    void refresh();
  }, [refresh]);

  const changeLocale = (l: Locale) => {
    saveLocale(l);
    setLocale(l);
  };

  return (
    <LocaleProvider locale={locale}>
      {me === undefined ? (
        <main>…</main>
      ) : me === null ? (
        <Login onLoggedIn={refresh} />
      ) : me.pendingDocuments.length > 0 ? (
        <Documents me={me} onAccepted={refresh} onLogout={() => setMe(null)} />
      ) : (
        <Shell me={me} onLogout={() => setMe(null)} onLocale={changeLocale} />
      )}
    </LocaleProvider>
  );
}

function Shell({ me, onLogout, onLocale }: { me: Me; onLogout: () => void; onLocale: (l: Locale) => void }) {
  const { t } = useT();
  const [screen, param] = useRoute();
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const tabs: Array<[string, Parameters<typeof t>[0]]> = [
    ['calendar', 'pwa.nav.calendar'],
    ['clients', 'pwa.nav.clients'],
    ...(me.role !== 'assistant' ? ([['stats', 'pwa.nav.stats']] as Array<[string, Parameters<typeof t>[0]]>) : []),
    ['settings', 'pwa.nav.settings'],
  ];

  let content;
  if (screen === 'clients' && param) content = <ClientCardScreen me={me} clientId={param} />;
  else if (screen === 'clients') content = <Clients />;
  else if (screen === 'new') content = <NewBooking me={me} day={param} />;
  else if (screen === 'stats') content = <Stats me={me} />;
  else if (screen === 'services' && param) content = <ServiceEditor me={me} serviceId={param} />;
  else if (screen === 'services') content = <Catalog me={me} />;
  else if (screen === 'settings') content = <Settings me={me} onLogout={onLogout} onLocale={onLocale} />;
  else content = <Calendar me={me} />;

  return (
    <>
      <header className="bar">
        <span className="muted">{me.accountName}</span>
        {screen !== 'calendar' && screen !== 'clients' && screen !== 'stats' && screen !== 'settings' && (
          <button type="button" className="secondary" onClick={() => window.history.back()}>
            {t('widget.back')}
          </button>
        )}
      </header>
      {!online && <p className="notice warn" style={{ margin: '8px 16px' }}>{t('pwa.offline')}</p>}
      {content}
      <nav className="tabs" style={{ ['--tabs' as string]: tabs.length }}>
        {tabs.map(([path, label]) => (
          <a key={path} href={`#/${path}`} aria-current={screen === path || (path === 'calendar' && screen === 'new') || (path === 'settings' && screen === 'services') ? 'page' : undefined} onClick={() => go(path)}>
            {t(label)}
          </a>
        ))}
      </nav>
    </>
  );
}
