import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createMaster } from '../src/auth/auth.service';
import { parseCsv, unescapeFormula } from '../src/clients/csv';
import { Client, createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';

const PASSWORD = 'very secret 123';

describe('разбор CSV', () => {
  test('кавычки, удвоенные кавычки, перенос строки в поле, CRLF, BOM, пустые строки', () => {
    const { rows, delimiter } = parseCsv('﻿name,phone\r\n"Kowalska, Anna","500 100 200"\r\n\r\n"Ewa ""Ewka""\nNowak",600200300\n');
    assert.equal(delimiter, ',');
    assert.deepEqual(rows, [
      { line: 1, cells: ['name', 'phone'] },
      { line: 2, cells: ['Kowalska, Anna', '500 100 200'] },
      { line: 4, cells: ['Ewa "Ewka"\nNowak', '600200300'] },
    ]);
  });

  test('разделитель «;» как в польском Excel; последняя строка без перевода строки', () => {
    const { rows, delimiter } = parseCsv('Imię;Telefon;E-mail\nAnna;500100200;a@x.pl');
    assert.equal(delimiter, ';');
    assert.deepEqual(rows[1]!.cells, ['Anna', '500100200', 'a@x.pl']);
  });

  test('защитный апостроф нашего экспорта снимается только перед формулами', () => {
    assert.equal(unescapeFormula("'=SUM(A1)"), '=SUM(A1)');
    assert.equal(unescapeFormula("'Ola"), "'Ola");
    assert.equal(unescapeFormula("O'Neil"), "O'Neil");
  });
});

describe('HTTP: импорт клиентов из CSV (D-054)', () => {
  let db: TestDb;
  let t: TestApp;
  let owner: Client;
  let accountId: string;
  const csv = (c: Client, body: string, dryRun = false) => c.raw('POST', `/clients/import${dryRun ? '?dryRun=true' : ''}`, body, 'text/csv');
  const clientCount = async () => (await db.admin.query('SELECT count(*)::int AS n FROM clients WHERE account_id = $1', [accountId])).rows[0].n;

  before(async () => {
    db = await createTestDb('import');
    t = await createTestApp(db);
    ({ accountId } = await createMaster(db.app, { accountName: 'Studio', email: 'owner@import.pl', password: PASSWORD }));
    owner = new Client(t.url);
    await owner.post('/auth/login', { email: 'owner@import.pl', password: PASSWORD });
  });
  after(async () => {
    await t.close();
    await db.close();
  });

  const file = [
    'Imię i nazwisko;Telefon;E-mail;Język;Notatka',
    'Anna Kowalska;500 100 200;anna@example.pl;pl;stała klientka',
    'Олена;+380 50 123 4567;;uk;',
    'Duplikat Anny;+48 500-100-200;;;',
    ';700000001;;;',
    'Zły telefon;12345;;;',
    'Zły email;700000002;nie-email;;',
    "'=HYPERLINK(\"x\");700000003;;;",
  ].join('\r\n');

  test('пробный импорт: полный отчёт с номерами строк, в базе ничего', async () => {
    const r = await csv(owner, file, true);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, {
      dryRun: true,
      total: 7,
      created: 3,
      existing: 0,
      duplicates: 1,
      invalid: 3,
      errors: [
        { line: 5, reason: 'name' },
        { line: 6, reason: 'phone' },
        { line: 7, reason: 'email' },
      ],
    });
    assert.equal(await clientCount(), 0);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM account_keys WHERE account_id = $1', [accountId])).rows[0].n, 0, 'даже ключ шифрования откатан');
  });

  test('импорт: клиенты созданы с шифрованным телефоном, языком и email; аудит', async () => {
    const r = await csv(owner, file);
    assert.deepEqual([r.body.dryRun, r.body.created, r.body.duplicates, r.body.invalid], [false, 3, 1, 3]);
    assert.equal(await clientCount(), 3);
    const anna = (await owner.get(`/clients?search=${encodeURIComponent('500100200')}`)).body[0];
    const card = (await owner.get(`/clients/${anna.id}`)).body;
    assert.deepEqual([card.name, card.phone, card.email, card.language], ['Anna Kowalska', '+48500100200', 'anna@example.pl', 'pl']);
    const olena = (await owner.get(`/clients?search=${encodeURIComponent('+380501234567')}`)).body[0];
    assert.equal(olena.language, 'uk');
    assert.equal((await owner.get('/clients?search=HYPERLINK')).body[0].name, '=HYPERLINK("x")', 'апостроф экспорта снят');
    const raw = await db.admin.query('SELECT phone_encrypted FROM clients WHERE account_id = $1', [accountId]);
    for (const row of raw.rows) assert.ok(!row.phone_encrypted.toString('latin1').includes('500100200'));
    assert.ok((await owner.get('/audit')).body.some((e: { action: string }) => e.action === 'clients.import'));
  });

  test('повторный импорт того же файла ничего не меняет (existing)', async () => {
    const r = await csv(owner, file);
    assert.deepEqual([r.body.created, r.body.existing], [0, 3]);
    assert.equal(await clientCount(), 3);
  });

  test('свой экспорт загружается в другой Account без правок', async () => {
    const exported = await owner.get('/clients/export?format=csv');
    await createMaster(db.app, { accountName: 'Nowy salon', email: 'new@import.pl', password: PASSWORD });
    const other = new Client(t.url);
    await other.post('/auth/login', { email: 'new@import.pl', password: PASSWORD });
    const r = await csv(other, exported.body);
    assert.equal(r.body.created, 3);
    assert.equal(r.body.invalid, 0);
  });

  test('ошибки формата: нет нужных колонок, не CSV, слишком много строк, не owner', async () => {
    assert.deepEqual((await csv(owner, 'foo,bar\n1,2')).body.details, { csv: 'header must contain name and phone columns' });
    assert.equal((await owner.post('/clients/import', { csv: 'name,phone' })).status, 400, 'JSON вместо text/csv');
    const big = ['name,phone', ...Array.from({ length: 5001 }, (_, i) => `K${i},7${String(i).padStart(8, '0')}`)].join('\n');
    assert.deepEqual((await csv(owner, big, true)).body.details, { csv: 'at most 5000 rows' });

    await owner.post('/users', { email: 'desk@import.pl', role: 'assistant', password: PASSWORD });
    const desk = new Client(t.url);
    await desk.post('/auth/login', { email: 'desk@import.pl', password: PASSWORD });
    assert.equal((await csv(desk, file, true)).status, 403);
  });

  test('тело больше 2 МБ отклоняется до разбора', async () => {
    const huge = `name,phone\n${'x'.repeat(2 * 1024 * 1024 + 10)},500100200\n`;
    assert.equal((await csv(owner, huge, true)).status, 413);
  });
});
