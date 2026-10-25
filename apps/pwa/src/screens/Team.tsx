import { useCallback, useEffect, useState } from 'react';
import { api, type Me, type Role, type Staff } from '../api';
import { useT } from '../i18n';
import { temporaryPassword } from '../lib/password';

interface TeamUser {
  id: string;
  email: string;
  role: Role;
  staffId: string | null;
  mustChangePassword: boolean;
}

const ROLES: Role[] = ['staff', 'assistant', 'owner'];

/**
 * Команда Account (D-047, D-061): приглашение с временным паролем, роль, профиль специалиста, сброс пароля,
 * удаление доступа. Почты пока нет: owner передаёт e-mail и временный пароль сам, сотрудник сменит его при входе.
 */
export function Team({ me }: { me: Me }) {
  const { t } = useT();
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('staff');
  const [staffId, setStaffId] = useState('');
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [u, s] = await Promise.all([api<TeamUser[]>('GET', '/users'), api<Staff[]>('GET', '/staff')]);
    setUsers(u.data ?? []);
    setStaff((s.data ?? []).filter((x) => x.active));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const freeStaff = staff.filter((s) => !users.some((u) => u.staffId === s.id));
  const problem = (code: string | undefined) =>
    t(
      code === 'EMAIL_TAKEN'
        ? 'pwa.team.email_taken'
        : code === 'STAFF_LINKED'
          ? 'pwa.team.staff_linked'
          : code === 'LAST_OWNER'
            ? 'pwa.team.last_owner'
            : 'pwa.error',
    );

  async function invite() {
    setError(null);
    const password = temporaryPassword();
    const r = await api('POST', '/users', { email: email.trim(), role, password, ...(staffId ? { staffId } : {}) });
    if (!r.ok) return setError(problem(r.error));
    setIssued({ email: email.trim().toLowerCase(), password });
    setEmail('');
    setStaffId('');
    await load();
  }

  async function reset(u: TeamUser) {
    const password = temporaryPassword();
    const r = await api('POST', `/users/${u.id}/reset-password`, { password });
    if (!r.ok) return setError(problem(r.error));
    setIssued({ email: u.email, password });
    await load();
  }

  async function update(u: TeamUser, patch: { role?: Role; staffId?: string | null }) {
    const r = await api('PATCH', `/users/${u.id}`, patch);
    setError(r.ok ? null : problem(r.error));
    await load();
  }

  async function remove(u: TeamUser) {
    if (!window.confirm(t('pwa.team.remove_confirm', { email: u.email }))) return;
    const r = await api('DELETE', `/users/${u.id}`);
    setError(r.ok ? null : problem(r.error));
    await load();
  }

  return (
    <main>
      <h1>{t('pwa.team.title')}</h1>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {issued && (
        <div className="card" role="status">
          <strong>{issued.email}</strong>
          <div className="muted">{t('pwa.team.temp_password')}</div>
          <div className="link-row">
            <code style={{ fontSize: '1.2rem' }}>{issued.password}</code>
            <button type="button" className="secondary" onClick={() => void navigator.clipboard?.writeText(`${issued.email}\n${issued.password}`)}>
              {t('pwa.team.copy')}
            </button>
          </div>
          <p className="muted">{t('pwa.team.temp_hint')}</p>
        </div>
      )}

      {users.map((u) => (
        <section key={u.id} className="card">
          <strong>
            {u.email} {u.id === me.userId && <span className="muted">{t('pwa.team.you')}</span>}
          </strong>
          {u.mustChangePassword && <div className="status pending">{t('pwa.team.pending')}</div>}
          {u.id !== me.userId && (
            <>
              <label htmlFor={`role-${u.id}`}>{t('pwa.team.role')}</label>
              <select id={`role-${u.id}`} value={u.role} onChange={(e) => void update(u, { role: e.target.value as Role })}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`pwa.role.${r}`)}
                  </option>
                ))}
              </select>
              <label htmlFor={`staff-${u.id}`}>{t('pwa.team.staff_link')}</label>
              <select id={`staff-${u.id}`} value={u.staffId ?? ''} onChange={(e) => void update(u, { staffId: e.target.value || null })}>
                <option value="">{t('pwa.team.none')}</option>
                {staff
                  .filter((s) => s.id === u.staffId || freeStaff.includes(s))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayName}
                    </option>
                  ))}
              </select>
              <div className="actions" style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <button type="button" className="secondary" onClick={() => void reset(u)}>
                  {t('pwa.team.reset')}
                </button>
                <button type="button" className="secondary" onClick={() => void remove(u)}>
                  {t('pwa.team.remove')}
                </button>
              </div>
            </>
          )}
        </section>
      ))}

      <h2>{t('pwa.team.invite')}</h2>
      <label htmlFor="temail">{t('pwa.login.email')}</label>
      <input id="temail" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor="trole">{t('pwa.team.role')}</label>
      <select id="trole" value={role} onChange={(e) => setRole(e.target.value as Role)}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {t(`pwa.role.${r}`)}
          </option>
        ))}
      </select>
      <p className="muted">{t(`pwa.role.${role}_hint`)}</p>
      {freeStaff.length > 0 && (
        <>
          <label htmlFor="tstaff">{t('pwa.team.staff_link')}</label>
          <select id="tstaff" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">{t('pwa.team.none')}</option>
            {freeStaff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </select>
        </>
      )}
      <button type="button" className="primary" disabled={!email.includes('@')} onClick={() => void invite()}>
        {t('pwa.team.invite')}
      </button>
    </main>
  );
}
