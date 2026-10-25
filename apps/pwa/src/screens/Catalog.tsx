import { formatMoney, pickText, type DepositMode } from '@rezerwapp/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, type Me, type Staff } from '../api';
import { useT } from '../i18n';
import { emptyForm, emptyVariant, staffDiff, toForm, toPayload, type ApiService, type ServiceForm } from '../lib/service-form';
import { go } from '../router';

interface Policy {
  id: string;
  version: number;
  freeCancelHours: number;
  maxReschedules: number;
  holdMinutes: number;
  depositOnLateCancel: 'keep' | 'transfer' | 'refund';
}

/**
 * Каталог (D-059): услуги с вариантами и ценами, кто их оказывает, политика отмен (D-012, D-015) и специалисты.
 * Менять может только owner (D-047), остальные видят список.
 */
export function Catalog({ me }: { me: Me }) {
  const { t, locale } = useT();
  const [services, setServices] = useState<ApiService[] | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const owner = me.role === 'owner';

  const load = useCallback(async () => {
    const [s, st, p] = await Promise.all([
      api<ApiService[]>('GET', '/services'),
      api<Staff[]>('GET', '/staff'),
      api<Policy[]>('GET', '/policies'),
    ]);
    setServices(s.data ?? []);
    setStaff(st.data ?? []);
    setPolicy(p.data?.[0] ?? null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const feeText = (s: ApiService) =>
    s.depositMode === 'none'
      ? null
      : `${t('booking.fee.label')}: ${s.depositMode === 'percent' ? `${s.depositValue}%` : `${formatMoney(s.depositValue, locale)} zł`} · ${t(s.depositScope === 'all' ? 'pwa.cat.fee_scope_all' : 'pwa.cat.fee_scope_new')}`;

  return (
    <main>
      <h1>{t('pwa.cat.title')}</h1>
      {!owner && <p className="notice warn">{t('pwa.cat.read_only')}</p>}
      {owner && (
        <button type="button" className="primary" onClick={() => go('services/new')}>
          + {t('pwa.cat.add_service')}
        </button>
      )}

      {services === null ? (
        <p className="muted">…</p>
      ) : (
        services.map((s) => (
          <section key={s.id} className="card" style={{ opacity: s.active ? 1 : 0.6 }}>
            <div className="row" style={{ alignItems: 'center' }}>
              <strong>
                {pickText(s.name, locale) || '—'}
                {!s.active && <span className="muted"> · {t('pwa.cat.inactive')}</span>}
              </strong>
              {owner && (
                <button type="button" className="secondary" onClick={() => go(`services/${s.id}`)}>
                  {t('pwa.cat.edit')}
                </button>
              )}
            </div>
            {s.variants
              .filter((v) => v.active)
              .map((v) => (
                <div key={v.id} className="muted">
                  {pickText(v.name, locale) || pickText(s.name, locale)} · {t('widget.duration', { minutes: v.durationMin })} ·{' '}
                  {t('widget.price', { price: formatMoney(v.price, locale) })}
                </div>
              ))}
            {feeText(s) && <div className="muted">{feeText(s)}</div>}
            <div className="muted">
              {t('pwa.cat.staff')}: {staff.filter((st) => s.staff.some((a) => a.staffId === st.id)).map((st) => st.displayName).join(', ') || '—'}
            </div>
          </section>
        ))
      )}

      <PolicySection policy={policy} services={services ?? []} canEdit={owner} onSaved={load} />
      <StaffSection staff={staff} canEdit={owner} onSaved={load} />
    </main>
  );
}

/** Политика отмен: новая версия применяется ко всем услугам; старые записи живут по своему снимку (D-015). */
function PolicySection({ policy, services, canEdit, onSaved }: { policy: Policy | null; services: ApiService[]; canEdit: boolean; onSaved: () => void }) {
  const { t } = useT();
  const [hours, setHours] = useState('');
  const [reschedules, setReschedules] = useState('');
  const [hold, setHold] = useState('');
  const [late, setLate] = useState<Policy['depositOnLateCancel']>('keep');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setHours(String(policy?.freeCancelHours ?? 24));
    setReschedules(String(policy?.maxReschedules ?? 1));
    setHold(String(policy?.holdMinutes ?? 120));
    setLate(policy?.depositOnLateCancel ?? 'keep');
  }, [policy]);

  async function save() {
    const r = await api<{ id: string }>('POST', '/policies', {
      freeCancelHours: Number(hours),
      maxReschedules: Number(reschedules),
      holdMinutes: Number(hold),
      depositOnLateCancel: late,
    });
    let ok = r.ok;
    if (r.ok && r.data) {
      for (const s of services) ok = (await api('PATCH', `/services/${s.id}`, { cancelPolicyId: r.data.id })).ok && ok;
    }
    setMessage({ ok, text: t(ok ? 'pwa.set.saved' : 'pwa.error') });
    onSaved();
  }

  return (
    <section>
      <h2>{t('pwa.cat.policy')}</h2>
      {policy && <p className="muted">{t('pwa.cat.policy_current', { hours: policy.freeCancelHours, reschedules: policy.maxReschedules, hold: policy.holdMinutes })}</p>}
      {canEdit && (
        <>
          <label htmlFor="ph">{t('pwa.cat.policy_free_hours')}</label>
          <input id="ph" type="text" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />
          <label htmlFor="pr">{t('pwa.cat.policy_reschedules')}</label>
          <input id="pr" type="text" inputMode="numeric" value={reschedules} onChange={(e) => setReschedules(e.target.value)} />
          <label htmlFor="phold">{t('pwa.cat.policy_hold')}</label>
          <input id="phold" type="text" inputMode="numeric" value={hold} onChange={(e) => setHold(e.target.value)} />
          <label htmlFor="plate">{t('pwa.cat.policy_late')}</label>
          <select id="plate" value={late} onChange={(e) => setLate(e.target.value as Policy['depositOnLateCancel'])}>
            <option value="keep">{t('pwa.cat.late_keep')}</option>
            <option value="transfer">{t('pwa.cat.late_transfer')}</option>
            <option value="refund">{t('pwa.cat.late_refund')}</option>
          </select>
          <p className="muted">{t('pwa.cat.policy_note')}</p>
          {message && <p className={`notice ${message.ok ? 'ok' : 'error'}`}>{message.text}</p>}
          <button type="button" className="secondary" onClick={() => void save()}>
            {t('pwa.cat.policy_save')}
          </button>
        </>
      )}
    </section>
  );
}

function StaffSection({ staff, canEdit, onSaved }: { staff: Staff[]; canEdit: boolean; onSaved: () => void }) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function add() {
    const r = await api('POST', '/staff', { displayName: name, publicSlug: slug });
    if (r.ok) {
      setName('');
      setSlug('');
      setError(null);
      onSaved();
    } else setError(t(r.error === 'SLUG_TAKEN' ? 'pwa.cat.slug_taken' : 'pwa.error'));
  }

  return (
    <section>
      <h2>{t('pwa.cat.staff_title')}</h2>
      {staff.map((s) => (
        <div key={s.id} className="muted">
          {s.displayName} · /{s.publicSlug}
        </div>
      ))}
      {canEdit && (
        <>
          <label htmlFor="sname">{t('widget.name')}</label>
          <input id="sname" type="text" value={name} onChange={(e) => setName(e.target.value)} />
          <label htmlFor="sslug">{t('pwa.cat.slug')}</label>
          <input id="sslug" type="text" autoCapitalize="none" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} />
          {error && <p className="notice error">{error}</p>}
          <button type="button" className="secondary" disabled={!name.trim() || !slug.trim()} onClick={() => void add()}>
            + {t('pwa.cat.add_staff')}
          </button>
        </>
      )}
    </section>
  );
}

/** Создание и правка услуги: варианты, оплата с проверкой D-014, ручное подтверждение (D-016), кто выполняет. */
export function ServiceEditor({ me, serviceId }: { me: Me; serviceId: string }) {
  const { t, locale } = useT();
  const isNew = serviceId === 'new';
  const [form, setForm] = useState<ServiceForm | null>(null);
  const [original, setOriginal] = useState<ApiService | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [policyId, setPolicyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const [st, p, s] = await Promise.all([
        api<Staff[]>('GET', '/staff'),
        api<Policy[]>('GET', '/policies'),
        isNew ? Promise.resolve(null) : api<ApiService[]>('GET', '/services'),
      ]);
      const active = (st.data ?? []).filter((x) => x.active);
      setStaff(active);
      setPolicyId(p.data?.[0]?.id ?? null);
      if (isNew) setForm(emptyForm(active.map((x) => x.id)));
      else {
        const found = s?.data?.find((x) => x.id === serviceId) ?? null;
        setOriginal(found);
        setForm(found ? toForm(found) : null);
      }
    })();
  }, [isNew, serviceId]);

  if (me.role !== 'owner') return <main><p className="notice warn">{t('pwa.cat.read_only')}</p></main>;
  if (!form) return <main><p className="muted">…</p></main>;

  const set = (patch: Partial<ServiceForm>) => setForm({ ...form, ...patch });
  const setVariant = (i: number, patch: Partial<ServiceForm['variants'][number]>) =>
    set({ variants: form.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  const check = toPayload(form);

  async function save() {
    const { payload, errors: found } = toPayload(form!);
    setErrors(found);
    if (!payload) return;
    setBusy(true);
    setMessage(null);
    let id = form!.id;
    let ok = true;
    let error: string | undefined;
    if (!id) {
      const r = await api<{ service: { id: string } }>('POST', '/services', {
        ...payload.service,
        ...(policyId ? { cancelPolicyId: policyId } : {}),
        variants: payload.variants.map(({ id: _id, ...v }) => v),
      });
      ok = r.ok;
      error = r.error;
      id = r.data?.service.id;
    } else {
      const r = await api('PATCH', `/services/${id}`, payload.service);
      ok = r.ok;
      error = r.error;
      for (const v of payload.variants) {
        if (!ok) break;
        const { id: variantId, ...body } = v;
        const res = variantId ? await api('PATCH', `/variants/${variantId}`, body) : await api('POST', `/services/${id}/variants`, body);
        ok = res.ok;
        error = res.error;
      }
    }
    if (ok && id) {
      const diff = staffDiff(isNew ? [] : (original?.staff.map((a) => a.staffId) ?? []), form!.staffIds);
      for (const s of diff.add) ok = (await api('PUT', `/staff/${s}/services/${id}`, {})).ok && ok;
      for (const s of diff.remove) ok = (await api('DELETE', `/staff/${s}/services/${id}`)).ok && ok;
    }
    setBusy(false);
    if (ok) go('services');
    // Оплата BLIK без номера BLIK в настройках отклоняется API (D-048).
    else setMessage(t(error === 'VALIDATION' && form!.feeMode !== 'none' ? 'pwa.cat.fee_needs_blik' : 'pwa.error'));
  }

  const err = (key: string) => (errors[key] ? <p className="notice error">{t(errors[key] as Parameters<typeof t>[0])}</p> : null);

  return (
    <main>
      <h1>{isNew ? t('pwa.cat.add_service') : pickText(original?.name, locale)}</h1>

      <label htmlFor="name-pl">{t('pwa.cat.name')}</label>
      <input id="name-pl" type="text" value={form.name.pl} onChange={(e) => set({ name: { ...form.name, pl: e.target.value } })} />
      {err('name')}
      <details>
        <summary className="muted">{t('pwa.cat.name_other')}</summary>
        {(['uk', 'ru', 'en'] as const).map((l) => (
          <input key={l} type="text" lang={l} aria-label={l} placeholder={l.toUpperCase()} style={{ marginTop: 8 }} value={form.name[l]} onChange={(e) => set({ name: { ...form.name, [l]: e.target.value } })} />
        ))}
      </details>

      <h2>{t('pwa.cat.variants')}</h2>
      {form.variants.map((v, i) => (
        <div key={v.id ?? `new-${i}`} className="card" style={{ opacity: v.active ? 1 : 0.6 }}>
          <label htmlFor={`vn${i}`}>{t('pwa.cat.variant_name')}</label>
          <input id={`vn${i}`} type="text" value={v.name} onChange={(e) => setVariant(i, { name: e.target.value })} />
          <div className="row">
            <div>
              <label htmlFor={`vd${i}`}>{t('pwa.cat.duration')}</label>
              <input id={`vd${i}`} type="text" inputMode="numeric" value={v.durationMin} onChange={(e) => setVariant(i, { durationMin: e.target.value })} />
            </div>
            <div>
              <label htmlFor={`vp${i}`}>{t('pwa.cat.price')}</label>
              <input id={`vp${i}`} type="text" inputMode="decimal" value={v.price} onChange={(e) => setVariant(i, { price: e.target.value })} />
            </div>
          </div>
          <label htmlFor={`vb${i}`}>{t('pwa.cat.buffer')}</label>
          <input id={`vb${i}`} type="text" inputMode="numeric" value={v.bufferMin} onChange={(e) => setVariant(i, { bufferMin: e.target.value })} />
          {err(`v${i}.duration`)}
          {err(`v${i}.price`)}
          {(v.id || form.variants.length > 1) && (
            <button type="button" className="chip" style={{ marginTop: 8 }} onClick={() => (v.id ? setVariant(i, { active: !v.active }) : set({ variants: form.variants.filter((_, j) => j !== i) }))}>
              {t(v.active ? 'pwa.cat.hide' : 'pwa.cat.show')}
            </button>
          )}
        </div>
      ))}
      {err('variants')}
      <button type="button" className="chip" onClick={() => set({ variants: [...form.variants, emptyVariant()] })}>
        + {t('pwa.cat.add_variant')}
      </button>

      <h2>{t('booking.fee.label')}</h2>
      <div className="days">
        {(['none', 'fixed', 'percent'] as DepositMode[]).map((m) => (
          <button key={m} type="button" className="chip" aria-pressed={form.feeMode === m} onClick={() => set({ feeMode: m })}>
            {t(m === 'none' ? 'pwa.cat.fee_none' : m === 'fixed' ? 'pwa.cat.fee_fixed' : 'pwa.cat.fee_percent')}
          </button>
        ))}
      </div>
      {form.feeMode !== 'none' && (
        <>
          <label htmlFor="fee">{t('pwa.cat.fee_value')}</label>
          <input id="fee" type="text" inputMode="decimal" value={form.feeValue} onChange={(e) => set({ feeValue: e.target.value })} />
          <div className="days">
            {(['new_clients', 'all'] as const).map((sc) => (
              <button key={sc} type="button" className="chip" aria-pressed={form.feeScope === sc} onClick={() => set({ feeScope: sc })}>
                {t(sc === 'all' ? 'pwa.cat.fee_scope_all' : 'pwa.cat.fee_scope_new')}
              </button>
            ))}
          </div>
          {check.errors.fee === 'pwa.cat.fee_cap' ? (
            <p className="notice error">{t('pwa.cat.fee_cap')}</p>
          ) : (
            check.feeWarning && <p className="notice warn">{t('pwa.cat.fee_warning')}</p>
          )}
        </>
      )}

      <label className="check" style={{ marginTop: 16 }}>
        <input type="checkbox" checked={form.requiresManualConfirm} onChange={(e) => set({ requiresManualConfirm: e.target.checked })} />
        <span>
          {t('pwa.cat.manual_confirm')}
          <span className="muted"> {t('pwa.cat.manual_confirm_hint')}</span>
        </span>
      </label>

      <label htmlFor="cost">{t('pwa.cat.cost')}</label>
      <input id="cost" type="text" inputMode="decimal" value={form.costPrice} onChange={(e) => set({ costPrice: e.target.value })} />

      {staff.length > 0 && (
        <>
          <h2>{t('pwa.cat.staff')}</h2>
          {staff.map((s) => (
            <label key={s.id} className="check">
              <input
                type="checkbox"
                checked={form.staffIds.includes(s.id)}
                onChange={(e) => set({ staffIds: e.target.checked ? [...form.staffIds, s.id] : form.staffIds.filter((x) => x !== s.id) })}
              />
              <span>{s.displayName}</span>
            </label>
          ))}
        </>
      )}

      {!isNew && (
        <label className="check" style={{ marginTop: 16 }}>
          <input type="checkbox" checked={!form.active} onChange={(e) => set({ active: !e.target.checked })} />
          <span>{t('pwa.cat.hide')}</span>
        </label>
      )}

      {message && <p className="notice error">{message}</p>}
      <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
        {t('pwa.set.save')}
      </button>
    </main>
  );
}
