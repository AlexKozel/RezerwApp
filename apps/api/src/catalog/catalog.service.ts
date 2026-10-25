import { checkDeposit, type DepositMode, type PrepaymentMethod } from '@rezerwapp/shared';
import type { PoolClient } from 'pg';
import { readPayment } from '../accounts/account-settings.service';
import type { Db } from '../db/db';
import { ConflictError, NotFoundError, ValidationError } from '../errors';

export type I18nText = Record<string, string>;
export type DepositScope = 'new_clients' | 'all';

export interface VariantInput {
  name: I18nText;
  durationMin: number;
  bufferMin: number;
  price: number;
}

export interface ServiceInput {
  name: I18nText;
  category: string | null;
  prepaymentMethod: PrepaymentMethod;
  depositMode: DepositMode;
  depositValue: number;
  depositScope: DepositScope;
  requiresManualConfirm: boolean;
  cancelPolicyId: string | null;
  costPrice: number | null;
}

export interface Variant extends VariantInput {
  id: string;
  active: boolean;
}

/** Кто оказывает услугу и с какими персональными длительностью и ценой (staff_services). */
export interface StaffAssignment {
  staffId: string;
  overrideDurationMin: number | null;
  overridePrice: number | null;
}

export interface Service extends ServiceInput {
  id: string;
  active: boolean;
  variants: Variant[];
  staff: StaffAssignment[];
}

export interface PolicyInput {
  freeCancelHours: number;
  maxReschedules: number;
  holdMinutes: number;
  depositOnLateCancel: 'keep' | 'transfer' | 'refund';
  texts: I18nText;
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

interface ServiceRow {
  id: string;
  name_i18n: I18nText;
  category: string | null;
  prepayment_method: PrepaymentMethod;
  deposit_mode: DepositMode;
  deposit_value: string;
  deposit_scope: DepositScope;
  requires_manual_confirm: boolean;
  cancel_policy_id: string | null;
  cost_price: string | null;
  active: boolean;
}

interface VariantRow {
  id: string;
  service_id: string;
  name_i18n: I18nText;
  duration_min: number;
  buffer_min: number;
  price: string;
  active: boolean;
}

function toVariant(r: VariantRow): Variant {
  return { id: r.id, name: r.name_i18n, durationMin: r.duration_min, bufferMin: r.buffer_min, price: Number(r.price), active: r.active };
}

function toService(r: ServiceRow, variants: Variant[], staff: StaffAssignment[] = []): Service {
  return {
    id: r.id,
    name: r.name_i18n,
    category: r.category,
    prepaymentMethod: r.prepayment_method,
    depositMode: r.deposit_mode,
    depositValue: Number(r.deposit_value),
    depositScope: r.deposit_scope,
    requiresManualConfirm: r.requires_manual_confirm,
    cancelPolicyId: r.cancel_policy_id,
    costPrice: r.cost_price === null ? null : Number(r.cost_price),
    active: r.active,
    variants,
    staff,
  };
}

/**
 * Проверка резервационной оплаты (D-014) против цен всех активных вариантов: фиксированная сумма
 * сравнивается с самым дешёвым вариантом. Потолок 50% дублируется ограничением БД; предупреждение
 * (выше 30%) возвращается мастеру, но не запрещает сохранение.
 */
function depositWarning(service: Pick<ServiceInput, 'depositMode' | 'depositValue' | 'prepaymentMethod'>, prices: number[]): boolean {
  if (service.depositMode !== 'none' && service.prepaymentMethod === 'none') {
    throw new ValidationError({ prepaymentMethod: 'required when a booking fee is set' });
  }
  let warning = false;
  for (const price of prices.length > 0 ? prices : [Infinity]) {
    const check = checkDeposit(service.depositMode, service.depositValue, price === Infinity ? Number.MAX_SAFE_INTEGER : price);
    if (!check.ok) throw new ValidationError({ depositValue: check.reason === 'above_cap' ? 'above 50% of the price' : 'invalid' });
    warning ||= check.warning;
  }
  return warning;
}

/** Оплата manual_blik требует номера BLIK у Account (D-048): иначе клиенту некуда платить. */
async function assertPaymentConfigured(client: PoolClient, service: Pick<ServiceInput, 'depositMode' | 'prepaymentMethod'>): Promise<void> {
  if (service.depositMode === 'none' || service.prepaymentMethod !== 'manual_blik') return;
  if ((await readPayment(client)).blikPhone === null) {
    throw new ValidationError({ prepaymentMethod: 'set the BLIK phone number in account payment settings first' });
  }
}

/** Каталог Account: специалисты, политики отмен, услуги с вариантами, кто какие услуги оказывает. */
export class CatalogService {
  constructor(private readonly db: Db) {}

  // --- Специалисты ---

  async createStaff(accountId: string, input: { displayName: string; publicSlug: string }): Promise<{ id: string }> {
    if (!SLUG_RE.test(input.publicSlug)) throw new ValidationError({ publicSlug: 'a-z, 0-9 and hyphens, 3-40 characters' });
    try {
      return await this.db.withAccount(accountId, async (client) => {
        const row = await client.query<{ id: string }>(
          'INSERT INTO staff (account_id, display_name, public_slug) VALUES ($1, $2, $3) RETURNING id',
          [accountId, input.displayName, input.publicSlug],
        );
        return { id: row.rows[0]!.id };
      });
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'staff_public_slug_key') throw new ConflictError('SLUG_TAKEN', 'Public link is taken');
      throw error;
    }
  }

  async listStaff(accountId: string): Promise<Array<{ id: string; displayName: string; publicSlug: string; active: boolean }>> {
    return this.db.withAccount(accountId, async (client) => {
      const rows = await client.query<{ id: string; display_name: string; public_slug: string; active: boolean }>(
        'SELECT id, display_name, public_slug, active FROM staff ORDER BY created_at',
      );
      return rows.rows.map((r) => ({ id: r.id, displayName: r.display_name, publicSlug: r.public_slug, active: r.active }));
    });
  }

  // --- Политики отмен (версионируются, D-015) ---

  /** Новая версия политики. Старые версии не меняются: записи ссылаются на версию на момент бронирования. */
  async createPolicy(accountId: string, input: PolicyInput): Promise<{ id: string; version: number }> {
    return this.db.withAccount(accountId, async (client) => {
      // Блокировка Account сериализует выдачу номеров версий.
      await client.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
      const row = await client.query<{ id: string; version: number }>(
        `INSERT INTO policies (account_id, version, free_cancel_hours, max_reschedules, hold_minutes, deposit_on_late_cancel, texts_i18n)
         SELECT $1, COALESCE(max(version), 0) + 1, $2, $3, $4, $5, $6 FROM policies
         RETURNING id, version`,
        [accountId, input.freeCancelHours, input.maxReschedules, input.holdMinutes, input.depositOnLateCancel, JSON.stringify(input.texts)],
      );
      return row.rows[0]!;
    });
  }

  async listPolicies(accountId: string): Promise<Array<PolicyInput & { id: string; version: number }>> {
    return this.db.withAccount(accountId, async (client) => {
      const rows = await client.query<{
        id: string;
        version: number;
        free_cancel_hours: number;
        max_reschedules: number;
        hold_minutes: number;
        deposit_on_late_cancel: PolicyInput['depositOnLateCancel'];
        texts_i18n: I18nText;
      }>('SELECT * FROM policies ORDER BY version DESC');
      return rows.rows.map((r) => ({
        id: r.id,
        version: r.version,
        freeCancelHours: r.free_cancel_hours,
        maxReschedules: r.max_reschedules,
        holdMinutes: r.hold_minutes,
        depositOnLateCancel: r.deposit_on_late_cancel,
        texts: r.texts_i18n,
      }));
    });
  }

  // --- Услуги и варианты ---

  async createService(accountId: string, input: ServiceInput, variants: VariantInput[]): Promise<{ service: Service; depositWarning: boolean }> {
    if (variants.length === 0) throw new ValidationError({ variants: 'at least one variant' });
    const warning = depositWarning(input, variants.map((v) => v.price));
    const id = await this.db.withAccount(accountId, async (client) => {
      await assertPaymentConfigured(client, input);
      const row = await client.query<{ id: string }>(
        `INSERT INTO services (account_id, name_i18n, category, prepayment_method, deposit_mode, deposit_value, deposit_scope,
                               requires_manual_confirm, cancel_policy_id, cost_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          accountId,
          JSON.stringify(input.name),
          input.category,
          input.prepaymentMethod,
          input.depositMode,
          input.depositValue,
          input.depositScope,
          input.requiresManualConfirm,
          input.cancelPolicyId,
          input.costPrice,
        ],
      );
      const serviceId = row.rows[0]!.id;
      for (const v of variants) await this.insertVariant(client, accountId, serviceId, v);
      return serviceId;
    });
    return { service: await this.getService(accountId, id), depositWarning: warning };
  }

  async updateService(accountId: string, serviceId: string, patch: Partial<ServiceInput> & { active?: boolean }): Promise<{ service: Service; depositWarning: boolean }> {
    const current = await this.getService(accountId, serviceId);
    const next = { ...current, ...patch };
    const warning = depositWarning(next, current.variants.filter((v) => v.active).map((v) => v.price));
    await this.db.withAccount(accountId, async (client) => {
      if (next.active) await assertPaymentConfigured(client, next);
      await client.query(
        `UPDATE services SET name_i18n = $2, category = $3, prepayment_method = $4, deposit_mode = $5, deposit_value = $6,
                             deposit_scope = $7, requires_manual_confirm = $8, cancel_policy_id = $9, cost_price = $10, active = $11
          WHERE id = $1`,
        [
          serviceId,
          JSON.stringify(next.name),
          next.category,
          next.prepaymentMethod,
          next.depositMode,
          next.depositValue,
          next.depositScope,
          next.requiresManualConfirm,
          next.cancelPolicyId,
          next.costPrice,
          next.active,
        ],
      );
    });
    return { service: await this.getService(accountId, serviceId), depositWarning: warning };
  }

  async addVariant(accountId: string, serviceId: string, input: VariantInput): Promise<Variant> {
    const service = await this.getService(accountId, serviceId);
    depositWarning(service, [...service.variants.filter((v) => v.active).map((v) => v.price), input.price]);
    return this.db.withAccount(accountId, (client) => this.insertVariant(client, accountId, serviceId, input));
  }

  async updateVariant(accountId: string, variantId: string, patch: Partial<VariantInput> & { active?: boolean }): Promise<Variant> {
    return this.db.withAccount(accountId, async (client) => {
      const row = (await client.query<VariantRow>('SELECT * FROM service_variants WHERE id = $1 FOR UPDATE', [variantId])).rows[0];
      if (!row) throw new NotFoundError('variant');
      const next = { ...toVariant(row), ...patch };
      if (patch.price !== undefined) {
        const service = (await client.query<ServiceRow>('SELECT * FROM services WHERE id = $1', [row.service_id])).rows[0]!;
        depositWarning(toService(service, []), [next.price]);
      }
      const updated = await client.query<VariantRow>(
        `UPDATE service_variants SET name_i18n = $2, duration_min = $3, buffer_min = $4, price = $5, active = $6
          WHERE id = $1 RETURNING *`,
        [variantId, JSON.stringify(next.name), next.durationMin, next.bufferMin, next.price, next.active],
      );
      return toVariant(updated.rows[0]!);
    });
  }

  async getService(accountId: string, serviceId: string): Promise<Service> {
    const [service] = await this.listServices(accountId, serviceId);
    if (!service) throw new NotFoundError('service');
    return service;
  }

  async listServices(accountId: string, onlyId?: string): Promise<Service[]> {
    return this.db.withAccount(accountId, async (client) => {
      const services = await client.query<ServiceRow>(
        'SELECT * FROM services WHERE ($1::uuid IS NULL OR id = $1) ORDER BY created_at',
        [onlyId ?? null],
      );
      const variants = await client.query<VariantRow>(
        'SELECT * FROM service_variants WHERE service_id = ANY($1) ORDER BY price, duration_min',
        [services.rows.map((s) => s.id)],
      );
      const assigned = await client.query<{ service_id: string; staff_id: string; override_duration_min: number | null; override_price: string | null }>(
        'SELECT service_id, staff_id, override_duration_min, override_price FROM staff_services WHERE service_id = ANY($1)',
        [services.rows.map((s) => s.id)],
      );
      return services.rows.map((s) =>
        toService(
          s,
          variants.rows.filter((v) => v.service_id === s.id).map(toVariant),
          assigned.rows
            .filter((a) => a.service_id === s.id)
            .map((a) => ({ staffId: a.staff_id, overrideDurationMin: a.override_duration_min, overridePrice: a.override_price === null ? null : Number(a.override_price) })),
        ),
      );
    });
  }

  // --- Кто оказывает услугу ---

  async assignStaff(
    accountId: string,
    staffId: string,
    serviceId: string,
    overrides: { durationMin: number | null; price: number | null },
  ): Promise<void> {
    await this.db.withAccount(accountId, async (client) => {
      await client.query(
        `INSERT INTO staff_services (account_id, staff_id, service_id, override_duration_min, override_price)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (staff_id, service_id) DO UPDATE
           SET override_duration_min = EXCLUDED.override_duration_min, override_price = EXCLUDED.override_price`,
        [accountId, staffId, serviceId, overrides.durationMin, overrides.price],
      );
    });
  }

  async unassignStaff(accountId: string, staffId: string, serviceId: string): Promise<void> {
    await this.db.withAccount(accountId, async (client) => {
      const deleted = await client.query('DELETE FROM staff_services WHERE staff_id = $1 AND service_id = $2', [staffId, serviceId]);
      if (deleted.rowCount === 0) throw new NotFoundError('staff service');
    });
  }

  /** Публичный каталог специалиста: только активные услуги и варианты, с его персональной ценой и длительностью. */
  async publicCatalog(client: PoolClient, staffId: string) {
    const rows = await client.query<{
      service_id: string;
      name_i18n: I18nText;
      category: string | null;
      deposit_mode: DepositMode;
      deposit_value: string;
      deposit_scope: DepositScope;
      prepayment_method: PrepaymentMethod;
      variant_id: string;
      variant_name: I18nText;
      duration_min: number;
      price: string;
    }>(
      `SELECT s.id AS service_id, s.name_i18n, s.category, s.deposit_mode, s.deposit_value, s.deposit_scope, s.prepayment_method,
              v.id AS variant_id, v.name_i18n AS variant_name,
              COALESCE(ss.override_duration_min, v.duration_min) AS duration_min,
              COALESCE(ss.override_price, v.price) AS price
         FROM staff_services ss
         JOIN services s ON s.id = ss.service_id AND s.active
         JOIN service_variants v ON v.service_id = s.id AND v.active
        WHERE ss.staff_id = $1
        ORDER BY s.created_at, v.price, v.duration_min`,
      [staffId],
    );
    const byService = new Map<string, {
      id: string;
      name: I18nText;
      category: string | null;
      bookingFee: { mode: DepositMode; value: number; appliesTo: DepositScope; method: PrepaymentMethod } | null;
      variants: Array<{ id: string; name: I18nText; durationMin: number; price: number }>;
    }>();
    for (const r of rows.rows) {
      let entry = byService.get(r.service_id);
      if (!entry) {
        entry = {
          id: r.service_id,
          name: r.name_i18n,
          category: r.category,
          bookingFee: r.deposit_mode === 'none' ? null : { mode: r.deposit_mode, value: Number(r.deposit_value), appliesTo: r.deposit_scope, method: r.prepayment_method },
          variants: [],
        };
        byService.set(r.service_id, entry);
      }
      entry.variants.push({ id: r.variant_id, name: r.variant_name, durationMin: r.duration_min, price: Number(r.price) });
    }
    return [...byService.values()];
  }

  private async insertVariant(client: PoolClient, accountId: string, serviceId: string, v: VariantInput): Promise<Variant> {
    const row = await client.query<VariantRow>(
      `INSERT INTO service_variants (account_id, service_id, name_i18n, duration_min, buffer_min, price)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [accountId, serviceId, JSON.stringify(v.name), v.durationMin, v.bufferMin, v.price],
    );
    return toVariant(row.rows[0]!);
  }
}
