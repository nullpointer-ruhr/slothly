// Release 0.2: Status/Zeiten (#12), Plan ersetzen (#2), Verschieben (#6), Admin (#3), Planformat (#5, #10, #11).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { createPool, migrate, type Db } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { buildApp } from '../src/server.ts';
import { importPlan, readPlanFile } from '../src/plans.ts';
import type { Mail } from '../src/mail.ts';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL fehlt');
const ORIGIN = 'http://slothly.test';
const cfg = loadConfig({ DATABASE_URL: url, PUBLIC_ORIGIN: ORIGIN, LOGIN_RATE_LIMIT: '1000' });
const mails: Mail[] = [];
let db: Db, app: FastifyInstance, vorlage: Record<string, any>;

before(async () => {
  db = createPool(url);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  await db.query(`INSERT INTO users (email, name, role) VALUES ('admin@example.org', 'Admin', 'admin'), ('nutzer@example.org', 'Nutzer', 'user')`);
  vorlage = JSON.parse(await readFile(new URL('../seed/vorlage.json', import.meta.url), 'utf8'));
  await importPlan(db, 'admin@example.org', readPlanFile(vorlage));
  await importPlan(db, 'nutzer@example.org', readPlanFile(vorlage));
  app = await buildApp(cfg, db, { logger: false, mailer: { async send(m) { mails.push(m); } } });
});
after(async () => { await app.close(); await db.end(); });

const req = (method: string, url: string, cookie: string, payload?: object) =>
  app.inject({ method: method as 'GET', url, payload, headers: { cookie, origin: ORIGIN } });
async function login(email: string) {
  await db.query('DELETE FROM login_tokens');
  mails.length = 0;
  await app.inject({ method: 'POST', url: '/api/login/request', payload: { email }, headers: { origin: ORIGIN } });
  const code = mails[0].subject.slice(0, 6);
  const r = await app.inject({ method: 'POST', url: '/api/login/code', payload: { email, code }, headers: { origin: ORIGIN } });
  const c = r.cookies.find(c => c.name === 'slothly_session')!;
  return `${c.name}=${c.value}`;
}

test('#12 Status und Zeiten landen in eigenen Spalten', async () => {
  const ck = await login('nutzer@example.org');
  const plan = (await req('GET', '/api/plan', ck)).json();
  const t0 = Date.UTC(2026, 10, 2, 17, 0, 0);
  const put = (data: object) => req('PUT', `/api/plans/${plan.id}/logs/w1d1?rev=${plan.revision}`, ck, data);
  assert.equal((await put({ status: 'laeuft', startedAt: t0, doneOn: '2026-11-02', ex: { A: { sets: [{ kg: '20', r: '8', d: true, at: t0 + 60000 }] } }, updatedAt: t0 + 1 })).statusCode, 200);
  let row = (await db.query(`SELECT status, started_at, finished_at, duration_s, done_on::text FROM workout_logs WHERE plan_id = $1`, [plan.id])).rows[0];
  assert.equal(row.status, 'laeuft');
  assert.equal(row.started_at.getTime(), t0);
  assert.equal(row.finished_at, null);
  assert.equal((await put({ status: 'fertig', startedAt: t0, finishedAt: t0 + 55 * 60000, doneOn: '2026-11-02', ex: {}, updatedAt: t0 + 2 })).statusCode, 200);
  row = (await db.query(`SELECT status, duration_s FROM workout_logs WHERE plan_id = $1`, [plan.id])).rows[0];
  assert.deepEqual([row.status, row.duration_s], ['fertig', 3300]);
  // Altes Dokument ohne status, mit Datum: gilt als fertig
  await req('PUT', `/api/plans/${plan.id}/logs/w1d2`, ck, { doneOn: '2026-11-05', ex: {}, updatedAt: t0 + 3 });
  assert.equal((await db.query(`SELECT status FROM workout_logs WHERE plan_id = $1 AND day_idx = 1`, [plan.id])).rows[0].status, 'fertig');
});

test('#10/#7/#5 Plan liefert abgeleitete Erfassung, Pause in Sekunden und Skill-Block', async () => {
  const ck = await login('nutzer@example.org');
  const plan = (await req('GET', '/api/plan', ck)).json();
  const a = plan.days[0].ex[0];
  assert.deepEqual([a.fields, a.wref, a.ps], [['gewicht', 'wdh'], 'gesamt', 120]);
  const side = plan.days[0].ex.find((e: { b: string }) => e.b === 'C2');
  assert.deepEqual([side.fields, side.tmode], [['zeit'], 'halten']);
  assert.ok(plan.days[0].skillBlock === null || typeof plan.days[0].skillBlock === 'object');
});

test('#2 Plan ersetzen behält Einträge, warnt bei wegfallenden Blöcken', async () => {
  const ck = await login('nutzer@example.org');
  const plan = (await req('GET', '/api/plan', ck)).json();
  const neu = structuredClone(vorlage);
  neu.name = 'Korrigiert';
  neu.tage[0].uebungen[0].start = '30 kg';
  neu.tage[0].skill = { titel: 'Handstand', dauer: '6 min', uebungen: [{ name: 'Hollow Body Hold', vorgabe: '3×15 s' }] };
  const chk = (await req('POST', '/api/plans/check', ck, { plan: neu, replaceId: plan.id })).json();
  assert.equal(chk.replace.possible, true);
  assert.deepEqual(chk.replace.orphans, []);
  assert.equal((await req('PUT', `/api/plans/${plan.id}`, ck, { plan: neu })).statusCode, 200);
  const after = (await req('GET', '/api/plan', ck)).json();
  assert.equal(after.id, plan.id);
  assert.equal(after.name, 'Korrigiert');
  assert.equal(after.days[0].ex[0].st, '30 kg');
  assert.equal(after.days[0].skillBlock.title, 'Handstand');
  assert.equal(after.days[0].skillBlock.weeks.length, after.weeks);
  const logs = (await req('GET', `/api/plans/${plan.id}/logs`, ck)).json();
  assert.ok(logs.logs.w1d1, 'Einträge bleiben');

  // Block A fällt weg → Warnung, ohne force abgewiesen
  const ohneA = structuredClone(neu);
  ohneA.tage[0].uebungen[0].block = 'Z';
  assert.deepEqual((await req('POST', '/api/plans/check', ck, { plan: ohneA, replaceId: plan.id })).json().replace.orphans, []);   // w1d1 hat keine Sätze mehr (fertig gesetzt ohne ex)
  await req('PUT', `/api/plans/${plan.id}/logs/w2d1`, ck, { ex: { A: { sets: [{ kg: '25', r: '8' }] } }, updatedAt: Date.now() });
  const r409 = await req('PUT', `/api/plans/${plan.id}`, ck, { plan: ohneA });
  assert.equal(r409.statusCode, 409);
  assert.deepEqual(r409.json().orphans, ['W2 Tag 1: A']);
  assert.equal((await req('PUT', `/api/plans/${plan.id}`, ck, { plan: ohneA, force: true })).statusCode, 200);

  // Weniger Wochen als Einträge: nicht möglich
  const kurz = structuredClone(neu); kurz.wochen = 1; for (const k of Object.keys(kurz.schemata)) kurz.schemata[k] = kurz.schemata[k].slice(0, 1); kurz.wochenNamen = ['x'];
  const rk = await req('PUT', `/api/plans/${plan.id}`, ck, { plan: kurz });
  assert.equal(rk.statusCode, 400);
  assert.match(rk.json().message, /bis Woche 2/);
});

test('#6 Einheit auf einen Tag legen, Sync mit Zeitstempel', async () => {
  const ck = await login('nutzer@example.org');
  const plan = (await req('GET', '/api/plan', ck)).json();
  assert.equal((await req('PUT', `/api/plans/${plan.id}/moves`, ck, { map: { w1d2: '2026-11-07' }, updatedAt: 10 })).statusCode, 200);
  assert.deepEqual((await req('GET', `/api/plans/${plan.id}/logs`, ck)).json().moves, { map: { w1d2: '2026-11-07' }, updatedAt: 10 });
  const old = await req('PUT', `/api/plans/${plan.id}/moves`, ck, { map: {}, updatedAt: 5 });
  assert.equal(old.statusCode, 409);
  assert.deepEqual(old.json().map, { w1d2: '2026-11-07' });
  assert.equal((await req('PUT', `/api/plans/${plan.id}/moves`, ck, { map: { bad: 'x' }, updatedAt: 20 })).statusCode, 400);
});

test('#11 Tabata im Planformat', async () => {
  const p = structuredClone(vorlage);
  p.tage[1].uebungen.push({ block: 'F', name: 'Tabata', schema: 'RUMPF', darstellung: 'tabata', tabata: { arbeit_s: 20, pause_s: 10, runden: 8, uebungen: ['Kettlebell Swing', 'Air Squat'] } });
  const plan = readPlanFile(p);
  const t = plan.days[1].ex.at(-1)!;
  assert.deepEqual(t.tabata, { work: 20, rest: 10, rounds: 8, sets: 1, setRest: 60, ex: ['Kettlebell Swing', 'Air Squat'] });
  const bad = structuredClone(p); bad.tage[1].uebungen.at(-1).tabata.arbeit_s = 2;
  assert.throws(() => readPlanFile(bad), /tabata\.arbeit_s/);
});

test('#3 Admin verwaltet Konten, Nutzer nicht; letzter Admin bleibt', async () => {
  const admin = await login('admin@example.org');
  const user = await login('nutzer@example.org');
  assert.equal((await req('GET', '/api/me', admin)).json().role, 'admin');
  assert.equal((await req('GET', '/api/admin/users', user)).statusCode, 403);
  const list = (await req('GET', '/api/admin/users', admin)).json().users;
  assert.equal(list.length, 2);
  assert.ok(!('plans' in list[0]) && list[0].plan !== undefined, 'nur Planname, keine Trainingsdaten');

  mails.length = 0;
  const c = await req('POST', '/api/admin/users', admin, { email: 'Neu@Example.org', name: 'Neu', role: 'user', invite: true });
  assert.equal(c.statusCode, 200);
  assert.equal(c.json().mailed, true);
  assert.match(mails[0].subject, /Dein Konto bei Slothly/);
  assert.equal((await req('POST', '/api/admin/users', admin, { email: 'neu@example.org', name: 'X' })).statusCode, 409);

  const code = (await req('POST', `/api/admin/users/${c.json().id}/login-code`, admin, {})).json();
  assert.match(code.code, /^\d{6}$/);
  const r = await app.inject({ method: 'POST', url: '/api/login/code', payload: { email: 'neu@example.org', code: code.code }, headers: { origin: ORIGIN } });
  assert.equal(r.statusCode, 200);

  const adminId = list.find((u: { email: string }) => u.email === 'admin@example.org').id;
  const self = await req('PATCH', `/api/admin/users/${adminId}`, admin, { role: 'user' });
  assert.equal(self.statusCode, 400);
  assert.match(self.json().message, /letzte aktive Admin/);

  const uid = list.find((u: { email: string }) => u.email === 'nutzer@example.org').id;
  assert.equal((await req('PATCH', `/api/admin/users/${uid}`, admin, { disabled: true })).statusCode, 200);
  assert.equal((await req('GET', '/api/me', user)).statusCode, 401, 'Sperren meldet ab');
  assert.equal((await req('PATCH', `/api/admin/users/${uid}`, admin, { disabled: false, name: 'Umbenannt' })).statusCode, 200);
  const log = (await db.query('SELECT action FROM admin_log ORDER BY id')).rows.map(r => r.action);
  assert.deepEqual(log, ['user_created', 'login_code_created', 'user_changed', 'user_changed']);
});
