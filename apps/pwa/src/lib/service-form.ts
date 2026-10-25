import { checkDeposit, type DepositMode, type MessageKey } from '@rezerwapp/shared';

/** Услуга в формате API (GET /services). */
export interface ApiService {
  id: string;
  name: Record<string, string>;
  depositMode: DepositMode;
  depositValue: number;
  depositScope: 'new_clients' | 'all';
  prepaymentMethod: 'none' | 'manual_blik' | 'provider_link';
  requiresManualConfirm: boolean;
  cancelPolicyId: string | null;
  costPrice: number | null;
  active: boolean;
  variants: Array<{ id: string; name: Record<string, string>; durationMin: number; bufferMin: number; price: number; active: boolean }>;
  staff: Array<{ staffId: string }>;
}

export interface VariantForm {
  id?: string;
  name: string;
  durationMin: string;
  bufferMin: string;
  price: string;
  active: boolean;
}

/** Поля формы строками: так их хранит <input>, проверка при сохранении. */
export interface ServiceForm {
  id?: string;
  name: { pl: string; uk: string; ru: string; en: string };
  requiresManualConfirm: boolean;
  feeMode: DepositMode;
  feeValue: string;
  feeScope: 'new_clients' | 'all';
  costPrice: string;
  variants: VariantForm[];
  staffIds: string[];
  active: boolean;
}

export function emptyVariant(): VariantForm {
  return { name: '', durationMin: '60', bufferMin: '0', price: '', active: true };
}

export function emptyForm(staffIds: string[]): ServiceForm {
  return {
    name: { pl: '', uk: '', ru: '', en: '' },
    requiresManualConfirm: true,
    feeMode: 'none',
    feeValue: '',
    feeScope: 'new_clients',
    costPrice: '',
    variants: [emptyVariant()],
    staffIds,
    active: true,
  };
}

export function toForm(s: ApiService): ServiceForm {
  return {
    id: s.id,
    name: { pl: s.name.pl ?? '', uk: s.name.uk ?? '', ru: s.name.ru ?? '', en: s.name.en ?? '' },
    requiresManualConfirm: s.requiresManualConfirm,
    feeMode: s.depositMode,
    feeValue: s.depositMode === 'none' ? '' : String(s.depositValue),
    feeScope: s.depositScope,
    costPrice: s.costPrice === null ? '' : String(s.costPrice),
    variants: s.variants.map((v) => ({
      id: v.id,
      name: v.name.pl ?? '',
      durationMin: String(v.durationMin),
      bufferMin: String(v.bufferMin),
      price: String(v.price),
      active: v.active,
    })),
    staffIds: s.staff.map((a) => a.staffId),
    active: s.active,
  };
}

const MONEY = /^\d+([.,]\d{1,2})?$/;
const INT = /^\d+$/;
const money = (s: string) => Number(s.replace(',', '.'));

export interface Payload {
  service: Record<string, unknown>;
  variants: Array<{ id?: string; name: Record<string, string>; durationMin: number; bufferMin: number; price: number; active: boolean }>;
}

/**
 * Проверка формы и тело запроса. Ошибки: поле → ключ сообщения. Оплата проверяется против цен всех активных
 * вариантов той же функцией, что и в API (D-014): выше 50% нельзя, выше 30% предупреждение.
 */
export function toPayload(f: ServiceForm): { payload?: Payload; errors: Record<string, MessageKey>; feeWarning: boolean } {
  const errors: Record<string, MessageKey> = {};
  if (!f.name.pl.trim()) errors.name = 'pwa.cat.name';
  const variants: Payload['variants'] = [];
  f.variants.forEach((v, i) => {
    if (!INT.test(v.durationMin) || Number(v.durationMin) < 5) errors[`v${i}.duration`] = 'pwa.cat.duration';
    if (!INT.test(v.bufferMin || '0')) errors[`v${i}.buffer`] = 'pwa.cat.buffer';
    if (!MONEY.test(v.price)) errors[`v${i}.price`] = 'pwa.cat.price';
    variants.push({
      ...(v.id ? { id: v.id } : {}),
      name: v.name.trim() ? { pl: v.name.trim() } : {},
      durationMin: Number(v.durationMin),
      bufferMin: Number(v.bufferMin || '0'),
      price: money(v.price),
      active: v.active,
    });
  });
  if (!variants.some((v) => v.active)) errors.variants = 'pwa.cat.variants';
  if (f.costPrice && !MONEY.test(f.costPrice)) errors.cost = 'pwa.cat.cost';

  let feeWarning = false;
  const feeValue = f.feeMode === 'none' ? 0 : money(f.feeValue || 'x');
  if (f.feeMode !== 'none') {
    if (!MONEY.test(f.feeValue)) errors.fee = 'pwa.cat.fee_value';
    else {
      for (const v of variants.filter((x) => x.active && Number.isFinite(x.price))) {
        const check = checkDeposit(f.feeMode, feeValue, v.price);
        if (!check.ok) errors.fee = check.reason === 'above_cap' ? 'pwa.cat.fee_cap' : 'pwa.cat.fee_value';
        else feeWarning ||= check.warning;
      }
    }
  }
  if (Object.keys(errors).length > 0) return { errors, feeWarning };

  const name = Object.fromEntries(Object.entries(f.name).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
  return {
    errors,
    feeWarning,
    payload: {
      service: {
        name,
        requiresManualConfirm: f.requiresManualConfirm,
        // Способ предоплаты в MVP один: BLIK по номеру мастера (D-010).
        prepaymentMethod: f.feeMode === 'none' ? 'none' : 'manual_blik',
        depositMode: f.feeMode,
        depositValue: feeValue,
        depositScope: f.feeScope,
        costPrice: f.costPrice ? money(f.costPrice) : null,
        active: f.active,
      },
      variants,
    },
  };
}

/** Какие назначения специалистов добавить и снять при сохранении. */
export function staffDiff(before: string[], after: string[]): { add: string[]; remove: string[] } {
  return { add: after.filter((id) => !before.includes(id)), remove: before.filter((id) => !after.includes(id)) };
}
