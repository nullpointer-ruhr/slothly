// API-Tests gegen eine echte PostgreSQL (TEST_DATABASE_URL). Die Datenbank wird geleert!
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { createPool, migrate, type Db } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { buildApp } from '../src/server.ts';
import { importPlan, validatePlan, type PlanFile } from '../src/plans.ts';
import type { Mail } from '../src/mail.ts';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL fehlt');
const ORIGIN = 'http://slothly.test';
const cfg = loadConfig({ DATABASE_URL: url, PUBLIC_ORIGIN: ORIGIN, LOGIN_RATE_LIMIT: '1000' });
const mails: Mail[] = [];
let db: Db, app: FastifyInstance, demo: PlanFile;

before(async () => {
  db = createPool(url);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  await db.query(`INSERT INTO users (email, name) VALUES ('dirk@example.org', 'Dirk'), ('mella@example.org', 'Mella')`);
  demo = JSON.parse(await readFile(new URL('../seed/demo-plan.json', import.meta.url), 'utf8'));
  await importPlan(db, 'dirk@example.org', demo);
  await importPlan(db, 'mella@example.org', { ...demo, name: 'Mellas Plan' });
  app = await buildApp(cfg, db, { logger: false, mailer: { async send(m) { mails.push(m); } } });
});
after(async () => { await app.close(); await db.end(); });

const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload, headers: { origin: ORIGIN, ...headers } });

async function login(email: string): Promise<string> {
  mails.length = 0;
  assert.equal((await post('/api/login/request', { email })).statusCode, 200);
  const token = mails[0].text.match(/\/anmelden#([\w-]+)/)![1];
  const r = await post('/api/login/confirm', { token });
  assert.equal(r.statusCode, 200);
  const c = r.cookies.find(c => c.name === 'slothly_session')!;
  return `${c.name}=${c.value}`;
}

test('ohne Anmeldung: Startseite leitet um, API sagt 401', async () => {
  const r = await app.inject({ url: '/' });
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, '/login');
  assert.equal((await app.inject({ url: '/api/plan' })).statusCode, 401);
});

test('schreibende Aufrufe von fremder Origin werden abgelehnt', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/login/request', payload: { email: 'dirk@example.org' }, headers: { origin: 'https://evil.example' } });
  assert.equal(r.statusCode, 403);
});

test('unbekannte Adresse: gleiche Antwort, aber keine Mail', async () => {
  mails.length = 0;
  const r = await post('/api/login/request', { email: 'niemand@example.org' });
  assert.equal(r.statusCode, 200);
  assert.equal(mails.length, 0);
});

test('Anmelde-Link funktioniert genau einmal', async () => {
  mails.length = 0;
  await post('/api/login/request', { email: 'Dirk@Example.org ' });
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /Slothly/);
  const token = mails[0].text.match(/\/anmelden#([\w-]+)/)![1];
  assert.equal((await post('/api/login/confirm', { token })).statusCode, 200);
  assert.equal((await post('/api/login/confirm', { token })).statusCode, 400);
});

test('Plan, Logs mit Konfliktauflösung, Ausfalltage und Auswertung', async () => {
  const cookie = await login('dirk@example.org');
  const page = await app.inject({ url: '/', headers: { cookie } });
  assert.equal(page.statusCode, 200);
  assert.match(String(page.headers['content-security-policy']), /script-src 'sha256-/);

  const plan = (await app.inject({ url: '/api/plan', headers: { cookie } })).json();
  assert.equal(plan.name, 'Demo-Plan');
  assert.equal(plan.days.length, 2);
  assert.deepEqual(plan.days[0].ex.map((e: { b: string }) => e.b), ['A', 'B1', 'B2', 'C1', 'C2']);
  assert.deepEqual(plan.schemes.MAIN[1], [4, '7–8']);

  const log = { warm: [true], ex: { A: { sets: [{ kg: '20', r: '10', rpe: '7', d: true }, { kg: '22,5', r: '9', rpe: '8', d: true }], wu: [], note: '' } }, fb: { form: 4 }, updatedAt: 2000 };
  const put = (body: object) => app.inject({ method: 'PUT', url: `/api/plans/${plan.id}/logs/w1d1`, payload: body, headers: { cookie, origin: ORIGIN } });
  assert.equal((await put(log)).statusCode, 200);
  const stale = await put({ ...log, fb: {}, updatedAt: 1000 });   // älteres Gerät
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().data.fb.form, 4);

  const logs = (await app.inject({ url: `/api/plans/${plan.id}/logs`, headers: { cookie } })).json();
  assert.equal(logs.logs.w1d1.ex.A.sets.length, 2);

  const sk = await app.inject({ method: 'PUT', url: `/api/plans/${plan.id}/skips`, payload: { dates: ['2026-11-02'], updatedAt: 5 }, headers: { cookie, origin: ORIGIN } });
  assert.equal(sk.statusCode, 200);
  assert.deepEqual((await app.inject({ url: '/api/plan', headers: { cookie } })).json().skips, { dates: ['2026-11-02'], updatedAt: 5 });

  const sets = await db.query(`SELECT exercise, set_nr, kg::numeric AS kg FROM set_logs WHERE email = 'dirk@example.org' ORDER BY set_nr`);
  assert.deepEqual(sets.rows.map(r => [r.exercise, r.set_nr, Number(r.kg)]), [['Goblet Squat', 1, 20], ['Goblet Squat', 2, 22.5]]);

  const exp = (await app.inject({ url: '/api/export', headers: { cookie } })).json();
  assert.equal(exp.plans[0].logs.logs.w1d1.fb.form, 4);
  assert.equal(exp.plans[0].plan.format, 'slothly-plan/1');
  validatePlan(exp.plans[0].plan);   // Export lässt sich wieder importieren (Umzug)
});

test('fremde Pläne sind nicht erreichbar', async () => {
  const mella = await login('mella@example.org');
  const dirk = await login('dirk@example.org');
  const dirkPlan = (await app.inject({ url: '/api/plan', headers: { cookie: dirk } })).json();
  assert.equal((await app.inject({ url: '/api/plan', headers: { cookie: mella } })).json().name, 'Mellas Plan');
  assert.equal((await app.inject({ url: `/api/plans/${dirkPlan.id}/logs`, headers: { cookie: mella } })).statusCode, 404);
  const w = await app.inject({ method: 'PUT', url: `/api/plans/${dirkPlan.id}/logs/w1d2`, payload: { updatedAt: 9e12 }, headers: { cookie: mella, origin: ORIGIN } });
  assert.equal(w.statusCode, 404);
});

test('beide Pläne teilen sich die Übungsbibliothek', async () => {
  const r = await db.query(`SELECT count(*)::int AS n FROM exercises`);
  assert.equal(r.rows[0].n, 8);
});

test('ungültige Pläne werden vor dem Schreiben abgelehnt', () => {
  assert.throws(() => validatePlan({ ...demo, weeks: 5 }), /braucht genau 5 Wochen/);
  const bad = structuredClone(demo); bad.days[0].ex[0].scheme = 'XYZ';
  assert.throws(() => validatePlan(bad), /Schema XYZ fehlt/);
  const bad2 = structuredClone(demo); bad2.days[0].ex[0].b = '<b>';
  assert.throws(() => validatePlan(bad2), /Label/);
});

test('Abmelden beendet die Session', async () => {
  const cookie = await login('dirk@example.org');
  assert.equal((await app.inject({ method: 'POST', url: '/api/logout', payload: {}, headers: { cookie, origin: ORIGIN } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode, 401);
});
