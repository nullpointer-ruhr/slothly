// Release 0.3: Uhren je Block (#4): AMRAP, EMOM, For Time, Intervall.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { createPool, migrate, type Db } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { buildApp } from '../src/server.ts';
import { importPlan, readPlanFile } from '../src/plans.ts';
import { parsePlanFile, clockLabel } from '../src/planfile.ts';
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


test('#4 Vorlage: Uhr am Block wird geladen, angezeigt und beim Download wieder ausgegeben', async () => {
  const ck = await login('nutzer@example.org');
  const plan = (await req('GET', '/api/plan', ck)).json();
  assert.deepEqual(plan.days[0].clocks, { C: { kind: 'amrap', min: 8 } });
  assert.equal(plan.days[0].groups.C, 'Zirkel C · AMRAP');
  assert.deepEqual(plan.days[1].clocks, {});
  const dl = (await req('GET', '/api/plan/download', ck)).json();
  assert.deepEqual(dl.tage[0].bloecke.C, { titel: 'Zirkel C · AMRAP', uhr: { art: 'amrap', minuten: 8 } });
  assert.equal(dl.tage[0].bloecke.A, 'Block A · Hauptübung');
  const chk = (await req('POST', '/api/plans/check', ck, { plan: dl })).json();
  assert.equal(chk.ok, true, JSON.stringify(chk.errors));
  assert.deepEqual(chk.summary.days[0].clocks, ['C: AMRAP 8 min']);
});

test('#4 Alle Uhrarten und Fehlermeldungen', () => {
  const mk = (bl: Record<string, unknown>) => { const v = structuredClone(vorlage); v.tage[0].bloecke = { ...v.tage[0].bloecke, ...bl }; return parsePlanFile(v); };
  const ok = mk({ A: { titel: 'A', uhr: { art: 'emom', runden: 10 } }, B: { uhr: { art: 'fortime', minuten: 15, runden: 5 } }, C: { titel: 'C', uhr: { art: 'intervall', arbeit_s: 40, pause_s: 20, runden: 8 } } });
  assert.deepEqual(ok.errors, []);
  const c = ok.plan!.days[0].clocks!;
  assert.deepEqual(c.A, { kind: 'emom', every: 60, rounds: 10 });
  assert.deepEqual(c.B, { kind: 'fortime', min: 15, rounds: 5 });
  assert.equal(ok.plan!.days[0].groups!.B, undefined);   // ohne titel: Anzeige "Block B"
  assert.deepEqual([clockLabel(c.A), clockLabel(c.B), clockLabel(c.C)], ['EMOM 10 min', 'For Time 5 Runden, max. 15 min', 'Intervall 40/20 s × 8']);
  assert.equal(clockLabel({ kind: 'emom', every: 120, rounds: 6 }), 'E2MOM 6 × 2 min');
  assert.match(mk({ C: { uhr: { art: 'tabata' } } }).errors.join(), /uhr.art muss amrap, emom, fortime, intervall sein/);
  assert.match(mk({ C: { uhr: { art: 'amrap', minuten: 0 } } }).errors.join(), /uhr.minuten muss 1 bis 90 sein/);
  assert.match(mk({ C: { uhr: { art: 'emom', alle_s: 60 } } }).errors.join(), /uhr.runden muss 1 bis 90 sein/);
  assert.match(mk({ F: { uhr: { art: 'amrap', minuten: 5 } } }).errors.join(), /keine Übung in Block F/);
});

test('#4 Ergebnis der Uhr steht im Log der Einheit', async () => {
  const ck = await login('nutzer@example.org');
  const plan = (await req('GET', '/api/plan', ck)).json();
  const t0 = Date.UTC(2026, 10, 9, 17, 0, 0);
  const data = { status: 'laeuft', startedAt: t0, clocks: { C: { kind: 'amrap', rounds: 5, reps: '7', done: true, at: t0 } }, ex: {}, updatedAt: t0 };
  assert.equal((await req('PUT', `/api/plans/${plan.id}/logs/w2d1?rev=${plan.revision}`, ck, data)).statusCode, 200);
  const logs = (await req('GET', `/api/plans/${plan.id}/logs`, ck)).json();
  const L = (logs.logs ?? logs).w2d1 ?? Object.values(logs.logs ?? logs).find((x: any) => x.data?.clocks) as any;
  assert.deepEqual((L.data ?? L).clocks.C, data.clocks.C);
});
