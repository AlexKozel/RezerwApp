import { formatWhen, type MessageKey } from '@rezerwapp/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, type ClientCard, type ClientSummary, type Me } from '../api';
import { useT } from '../i18n';

/** База клиентов (D-050): поиск по имени или телефону. staff видит только своих клиентов. */
export function Clients() {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [list, setList] = useState<ClientSummary[] | null>(null);

  useEffect(() => {
    const id = setTimeout(() => {
      const q = query.trim();
      void api<ClientSummary[]>('GET', `/clients${q ? `?search=${encodeURIComponent(q)}` : ''}`).then((r) => setList(r.data ?? []));
    }, 250);
    return () => clearTimeout(id);
  }, [query]);

  return (
    <main>
      <h1>{t('pwa.nav.clients')}</h1>
      <input type="search" aria-label={t('pwa.new.search')} placeholder={t('pwa.new.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
      {list === null ? (
        <p className="muted">…</p>
      ) : list.length === 0 ? (
        <p className="muted">{t('pwa.clients.empty')}</p>
      ) : (
        list.map((c) => (
          <a key={c.id} className="option" href={`#/clients/${c.id}`}>
            <span>{c.anonymized ? '—' : c.name}</span>
            <span aria-hidden="true">›</span>
          </a>
        ))
      )}
    </main>
  );
}

interface Note {
  id: string;
  body: string;
  sensitivity: 'normal' | 'health';
  createdAt: string;
}

/**
 * Карточка клиента: телефон (каждое открытие пишется в журнал аудита), история, заметки и blacklist.
 * Заметки и blacklist у owner и staff; assistant их не видит (D-050).
 */
export function ClientCardScreen({ me, clientId }: { me: Me; clientId: string }) {
  const { t, locale } = useT();
  const [card, setCard] = useState<ClientCard | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [note, setNote] = useState('');
  const [health, setHealth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canNotes = me.role !== 'assistant';
  const hasHealthConsent = card?.consents.some((c) => c.type === 'health' && !c.revokedAt) ?? false;

  const load = useCallback(async () => {
    const r = await api<ClientCard>('GET', `/clients/${clientId}`);
    setCard(r.data ?? null);
    if (!r.ok) setError(t('pwa.error'));
    if (canNotes) setNotes((await api<Note[]>('GET', `/clients/${clientId}/notes`)).data ?? []);
  }, [clientId, canNotes, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addNote() {
    const r = await api('POST', `/clients/${clientId}/notes`, { body: note, sensitivity: health ? 'health' : 'normal' });
    if (r.ok) {
      setNote('');
      setHealth(false);
      await load();
    } else setError(t('pwa.error'));
  }

  async function toggleBlacklist() {
    const r = card?.blacklisted ? await api('DELETE', `/clients/${clientId}/blacklist`) : await api('POST', `/clients/${clientId}/blacklist`, {});
    if (!r.ok) setError(t('pwa.error'));
    await load();
  }

  if (!card) return <main>{error ? <p className="notice error">{error}</p> : <p className="muted">…</p>}</main>;
  return (
    <main>
      <h1>{card.anonymized ? '—' : card.name}</h1>
      {card.phone && (
        <div className="link-row">
          <a className="secondary" href={`tel:${card.phone}`}>
            {t('pwa.client.call')}
          </a>
          <span>{card.phone}</span>
        </div>
      )}
      {card.email && <p className="muted">{card.email}</p>}
      <p>{t('pwa.client.stats', { completed: card.stats.completed, noShow: card.stats.noShow })}</p>
      {card.blacklisted && <p className="notice warn">{t('pwa.client.blacklisted', { date: new Date(card.blacklisted.expiresAt).toLocaleDateString(locale) })}</p>}
      {error && <p className="notice error">{error}</p>}

      {canNotes && !card.anonymized && (
        <section>
          <h2>{t('pwa.client.notes')}</h2>
          {notes.map((n) => (
            <div key={n.id} className="card">
              {n.sensitivity === 'health' && <div className="muted">{t('pwa.client.health_note')}</div>}
              <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
              <div className="muted">{new Date(n.createdAt).toLocaleDateString(locale)}</div>
            </div>
          ))}
          <textarea aria-label={t('pwa.client.add_note')} value={note} maxLength={5000} onChange={(e) => setNote(e.target.value)} />
          <p className="muted">{t('notes.health_warning')}</p>
          {hasHealthConsent && (
            <label className="check">
              <input type="checkbox" checked={health} onChange={(e) => setHealth(e.target.checked)} />
              <span>{t('pwa.client.health_note')}</span>
            </label>
          )}
          <button type="button" className="secondary" disabled={!note.trim()} onClick={() => void addNote()}>
            {t('pwa.client.add_note')}
          </button>
        </section>
      )}

      <h2>{t('pwa.client.history')}</h2>
      {card.bookings.map((b) => (
        <div key={b.id} className="card">
          <div>{formatWhen(new Date(b.startsAt), me.timeZone, locale)}</div>
          <div className={`status ${b.status}`}>{t(`booking.status.${b.status}` as MessageKey)}</div>
        </div>
      ))}

      {canNotes && !card.anonymized && (
        <button type="button" className="secondary" style={{ marginTop: 16 }} onClick={() => void toggleBlacklist()}>
          {t(card.blacklisted ? 'pwa.client.unblacklist' : 'pwa.client.blacklist')}
        </button>
      )}
    </main>
  );
}
