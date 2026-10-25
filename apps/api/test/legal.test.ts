import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createMaster } from '../src/auth/auth.service';
import { findLegalDir, publishLegal } from '../src/legal/legal.service';
import { Client, createTestApp, type TestApp, inviteUser } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';

const PASSWORD = 'very secret 123';

describe('документы платформы и клиента (D-055)', () => {
  let db: TestDb;
  let t: TestApp;
  let owner: Client;
  let staffUser: Client;
  let accountId: string;
  let draftDir: string;

  before(async () => {
    db = await createTestDb('legal');
    t = await createTestApp(db);
    ({ accountId } = await createMaster(db.app, { accountName: 'Salon Lilia', email: 'owner@lilia.pl', password: PASSWORD, locale: 'en' }));
    owner = new Client(t.url);
    await owner.post('/auth/login', { email: 'owner@lilia.pl', password: PASSWORD });
    // Пока документы не опубликованы, ничего не требуется (dev без юридических текстов).
    const staffId = (await owner.post('/staff', { displayName: 'Lilia', publicSlug: 'lilia' })).body.id;
    await inviteUser(t.url, owner, { email: 'ola@lilia.pl', role: 'staff', staffId }, PASSWORD);
    staffUser = new Client(t.url);
    await staffUser.post('/auth/login', { email: 'ola@lilia.pl', password: PASSWORD });
    draftDir = mkdtempSync(path.join(tmpdir(), 'legal-'));
    cpSync(findLegalDir(), draftDir, { recursive: true });
  });
  after(async () => {
    rmSync(draftDir, { recursive: true, force: true });
    await t.close();
    await db.close();
  });

  test('заглушки из legal/ публикуются; та же версия с тем же текстом не дублируется, с другим запрещена', async () => {
    const first = await publishLegal(db.admin, '2026-01');
    assert.equal(first.published.length, 7);
    assert.ok(first.published.every((p) => p.language === 'pl'));
    const again = await publishLegal(db.admin, '2026-01');
    assert.deepEqual([again.published.length, again.unchanged.length], [0, 7]);

    writeFileSync(path.join(draftDir, 'dpa', 'pl.md'), '# Inny tekst');
    await assert.rejects(publishLegal(db.admin, '2026-01', draftDir), /already published with a different text/);
    await assert.rejects(publishLegal(db.admin, 'bad version!'), /version/);
  });

  test('без принятия кабинет закрыт для всех ролей; вход, профиль и документы доступны', async () => {
    const blocked = await owner.get('/services');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, 'ACCEPTANCE_REQUIRED');
    assert.deepEqual(blocked.body.documents.map((d: { type: string }) => d.type), ['dpa', 'platform_privacy', 'platform_terms']);
    assert.equal((await staffUser.get('/bookings?from=2030-01-01T00:00:00Z&to=2030-01-02T00:00:00Z')).body.error, 'ACCEPTANCE_REQUIRED');

    const me = (await owner.get('/auth/me')).body;
    assert.equal(me.pendingDocuments.length, 3);
    const docs = (await owner.get('/legal/platform')).body;
    assert.equal(docs.length, 3);
    assert.ok(docs.every((d: { language: string; accepted: boolean; body: string }) => d.language === 'pl' && !d.accepted && d.body.startsWith('# [PROJEKT]')),
      'перевода на en нет: показывается польская версия');
  });

  test('принимает только owner и только текущие версии; принятие записывается с хешем IP', async () => {
    const all = [{ type: 'platform_terms', version: '2026-01' }, { type: 'dpa', version: '2026-01' }, { type: 'platform_privacy', version: '2026-01' }];
    assert.equal((await staffUser.post('/legal/accept', { documents: all })).status, 403);
    assert.equal((await owner.post('/legal/accept', { documents: [{ type: 'dpa', version: '2025-99' }] })).status, 400);

    const partial = await owner.post('/legal/accept', { documents: all.slice(0, 2) });
    assert.deepEqual(partial.body.pending, [{ type: 'platform_privacy', version: '2026-01' }]);
    assert.equal((await owner.get('/services')).status, 403, 'пока принято не всё, кабинет закрыт');

    assert.deepEqual((await owner.post('/legal/accept', { documents: all })).body.pending, []);
    assert.equal((await owner.get('/services')).status, 200);
    assert.equal((await staffUser.get('/bookings?from=2030-01-01T00:00:00Z&to=2030-01-02T00:00:00Z')).status, 200, 'принятие owner открывает Account всем');

    const rows = await db.admin.query('SELECT document_type, version, language, ip_hash FROM platform_acceptances WHERE account_id = $1 ORDER BY document_type', [accountId]);
    assert.equal(rows.rows.length, 3);
    assert.ok(rows.rows.every((r) => r.language === 'en' && r.ip_hash.length === 32 && !r.ip_hash.toString('latin1').includes('127.0.0.1')));
    await assert.rejects(db.app.withAccount(accountId, (c) => c.query('DELETE FROM platform_acceptances')), /permission denied/);
  });

  test('новая версия документа платформы снова закрывает кабинет до принятия', async () => {
    writeFileSync(path.join(draftDir, 'dpa', 'pl.md'), '# Umowa powierzenia, wersja 2');
    await publishLegal(db.admin, '2026-02', draftDir);
    const blocked = await owner.get('/services');
    assert.deepEqual(blocked.body.documents, [{ type: 'dpa', version: '2026-02' }]);
    await owner.post('/legal/accept', { documents: [{ type: 'dpa', version: '2026-02' }] });
    assert.equal((await owner.get('/services')).status, 200);
  });

  test('клиентский документ на странице специалиста: подстановка названия и имени, без входа', async () => {
    const doc = (await new Client(t.url).get('/public/staff/lilia/legal/terms?language=uk')).body;
    assert.equal(doc.language, 'pl');
    assert.ok(doc.body.includes('Usługodawca: Salon Lilia, specjalista: Lilia.'), doc.body);
    assert.ok(!doc.body.includes('{{'));
    assert.equal((await new Client(t.url).get('/public/staff/lilia/legal/dpa')).status, 404, 'документы платформы не отдаются как клиентские');
    assert.equal((await new Client(t.url).get('/public/staff/nobody/legal/terms')).status, 404);
  });

  test('после публикации клиентских текстов запись больше не упирается в LEGAL_TEXTS_MISSING', async () => {
    const versions = await db.admin.query("SELECT DISTINCT type FROM consent_documents WHERE type IN ('terms', 'privacy', 'health')");
    assert.equal(versions.rows.length, 3);
  });
});
