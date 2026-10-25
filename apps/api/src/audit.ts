import type { PoolClient } from 'pg';

/** Действия, которые журналируются (ARCHITECTURE.md, раздел 9: доступ к клиентским данным). */
export type AuditAction =
  | 'client.read'
  | 'client.anonymize'
  | 'notes.read'
  | 'notes.write'
  | 'notes.delete'
  | 'blacklist.add'
  | 'blacklist.remove'
  | 'clients.export'
  | 'clients.import'
  | 'admin.active'
  | 'admin.suspended'
  | 'admin.closed'
  | 'admin.plan'
  | 'admin.sms';

/**
 * Запись в audit_log (только добавление, D-038) в той же транзакции, что и само действие:
 * если действие откатилось, записи о нём нет; если запись в журнал не удалась, действие не выполнится.
 */
export async function audit(
  client: PoolClient,
  accountId: string,
  /** Пользователь Account; null: действие администратора платформы (CLI admin, D-057). */
  actorId: string | null,
  action: AuditAction,
  objectType: string | null = null,
  objectId: string | null = null,
): Promise<void> {
  await client.query('INSERT INTO audit_log (account_id, actor_id, action, object_type, object_id) VALUES ($1, $2, $3, $4, $5)', [
    accountId,
    actorId,
    action,
    objectType,
    objectId,
  ]);
}
