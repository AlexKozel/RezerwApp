import { formatBirthday, formatWhen, type MessageKey } from '@rezerwapp/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, type ClientCard, type ClientSummary, type Me } from '../api';
import { useT } from '../i18n';
import { go } from '../router';
import { BirthdayInput } from './NewClient';

/** База клиентов (D-050, D-065): поиск по имени или телефону, добавление вручную. staff видит только своих клиентов. */
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
      <div className="title-row">
        <h1>{t('pwa.nav.clients')}</h1>
        <a className="chip" href="#/clients/new" onClick={() => go('clients/new')}>
          + {t('pwa.clients.add')}
        </a>
      </div>
      <input type="search" aria-label={t('pwa.new.search')} placeholder={t('pwa.new.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
      {list === null ? (
        <p className="muted">…</p>
      ) : list.length === 0 ? (
        <p className="muted">{t('pwa.clients.empty')}</p>
      ) : (
        list.map((c) => (
          <a key={c.id} className="option" href={`#/clients/${c.id}`}>
            <span>
              {c.anonymized ? '—' : c.name}
              {c.unreliable && <span className="badge warn"> {t('pwa.client.unreliable')}</span>}
            </span>
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
  author: string | null;
  canDelete: boolean;
}

/**
 * Карточка клиента: телефон (каждое открытие пишется в журнал аудита), день рождения, история, заметки и blacklist.
 * Заметки общие для салона, видят все роли, удаляет автор или owner (D-067); blacklist, отметка «ненадёжный» и
 * уважительная причина у owner и staff (D-066). notice: откуда пришли из «Новый клиент»
 * (exists: номер уже был в базе; linked: клиент другого мастера привязан к сотруднику, D-065).
 */
export function ClientCardScreen({ me, clientId, notice }: { me: Me; clientId: string; notice?: string }) {
  const { t, locale } = useT();
  const [card, setCard] = useState<ClientCard | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editBirthday, setEditBirthday] = useState(false);
  const [birthday, setBirthday] = useState<string | null>(null);
  const canManage = me.role !== 'assistant';
  const hasHealthConsent = card?.consents.some((c) => c.type === 'health' && !c.revokedAt) ?? false;

  const load = useCallback(async () => {
    const r = await api<ClientCard>('GET', `/clients/${clientId}`);
    setCard(r.data ?? null);
    if (!r.ok) setError(t('pwa.error'));
    setNotes((await api<Note[]>('GET', `/clients/${clientId}/notes`)).data ?? []);
  }, [clientId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addNote() {
    const r = await api('POST', `/clients/${clientId}/notes`, { body: note });
    if (r.ok) {
      setNote('');
      await load();
    } else setError(t('pwa.error'));
  }

  async function deleteNote(id: string) {
    if (!(await api('DELETE', `/clients/${clientId}/notes/${id}`)).ok) setError(t('pwa.error'));
    await load();
  }

  async function setMarked(marked: boolean) {
    if (!(await api('POST', `/clients/${clientId}/unreliable`, { marked })).ok) setError(t('pwa.error'));
    await load();
  }

  async function setExcused(bookingId: string, excused: boolean) {
    if (!(await api('POST', `/bookings/${bookingId}/excuse`, { excused })).ok) setError(t('pwa.error'));
    await load();
  }

  async function saveBirthday() {
    const r = await api('PATCH', `/clients/${clientId}`, { birthday });
    if (!r.ok) setError(t('pwa.error'));
    setEditBirthday(false);
    await load();
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
      {notice === 'exists' && <p className="notice">{t('pwa.client.exists')}</p>}
      {notice === 'linked' && <p className="notice">{t('pwa.client.linked', { business: me.accountName })}</p>}
      {card.phone && (
        <div className="link-row">
          <a className="secondary" href={`tel:${card.phone}`}>
            {t('pwa.client.call')}
          </a>
          <span>{card.phone}</span>
        </div>
      )}
      {card.email && <p className="muted">{card.email}</p>}
      {!card.anonymized &&
        (editBirthday ? (
          <div>
            <label>{t('pwa.client.birthday')}</label>
            <BirthdayInput value={birthday} onChange={setBirthday} />
            <button type="button" className="secondary" onClick={() => void saveBirthday()}>
              {t('pwa.set.save')}
            </button>
          </div>
        ) : (
          <p className="link-row">
            <span>
              {t('pwa.client.birthday')}: {card.birthday ? formatBirthday(card.birthday, locale) : <span className="muted">{t('pwa.client.birthday_none')}</span>}
            </span>
            <button
              type="button"
              className="chip"
              onClick={() => {
                setBirthday(card.birthday);
                setEditBirthday(true);
              }}
            >
              {t('pwa.client.edit')}
            </button>
          </p>
        ))}
      <p>{t('pwa.client.stats', { completed: card.stats.completed, noShow: card.stats.noShow })}</p>
      {card.reliability.unreliable && (
        <p className="notice warn">
          <strong>{t('pwa.client.unreliable')}</strong>
          {card.reliability.visitsLeft !== null && <> · {t('pwa.client.unreliable_left', { count: card.reliability.visitsLeft })}</>}
        </p>
      )}
      {canManage && !card.anonymized && (
        <button type="button" className="chip" onClick={() => void setMarked(!card.reliability.marked)}>
          {t(card.reliability.marked ? 'pwa.client.unmark_unreliable' : 'pwa.client.mark_unreliable')}
        </button>
      )}
      {card.blacklisted && <p className="notice warn">{t('pwa.client.blacklisted', { date: new Date(card.blacklisted.expiresAt).toLocaleDateString(locale) })}</p>}
      {error && <p className="notice error">{error}</p>}

      {!card.anonymized && (
        <section>
          <h2>{t('pwa.client.notes')}</h2>
          <p className="muted">{t(hasHealthConsent ? 'pwa.client.health_consent_yes' : 'pwa.client.health_consent_no')}</p>
          {notes.map((n) => (
            <div key={n.id} className="card">
              <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
              <div className="muted link-row">
                <span>
                  {n.author ? `${n.author}, ` : ''}
                  {new Date(n.createdAt).toLocaleDateString(locale)}
                </span>
                {n.canDelete && (
                  <button type="button" className="chip" aria-label={`${t('pwa.client.delete_note')}: ${n.body.slice(0, 20)}`} onClick={() => void deleteNote(n.id)}>
                    ×
                  </button>
                )}
              </div>
            </div>
          ))}
          <textarea aria-label={t('pwa.client.add_note')} value={note} maxLength={5000} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="secondary" disabled={!note.trim()} onClick={() => void addNote()}>
            {t('pwa.client.add_note')}
          </button>
        </section>
      )}

      <h2>{t('pwa.client.history')}</h2>
      {card.bookings.map((b) => {
        const incident = b.status === 'no_show' || (b.status === 'cancelled_by_client' && b.lateCancel);
        return (
          <div key={b.id} className="card">
            <div>{formatWhen(new Date(b.startsAt), me.timeZone, locale)}</div>
            <div className={`status ${b.status}`}>
              {t(`booking.status.${b.status}` as MessageKey)}
              {b.lateCancel && ` · ${t('pwa.client.late_cancel')}`}
              {b.excused && ` · ${t('pwa.client.excused')}`}
            </div>
            {incident && canManage && (
              <button type="button" className="chip" onClick={() => void setExcused(b.id, !b.excused)}>
                {t(b.excused ? 'pwa.client.unexcuse' : 'pwa.client.excuse')}
              </button>
            )}
          </div>
        );
      })}

      {canManage && !card.anonymized && (
        <button type="button" className="secondary" style={{ marginTop: 16 }} onClick={() => void toggleBlacklist()}>
          {t(card.blacklisted ? 'pwa.client.unblacklist' : 'pwa.client.blacklist')}
        </button>
      )}
    </main>
  );
}
