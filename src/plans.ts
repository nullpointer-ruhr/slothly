// Pläne: Import (Format siehe src/planfile.ts und seed/vorlage.json), Abfrage für die
// Oberfläche, Trainings-Logs und Export. Jede Abfrage ist an den angemeldeten Nutzer gebunden.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import type { Config } from './config.ts';
import { tx, type Db, type Tx } from './db.ts';
import { fail, normEmail, requireUser } from './auth.ts';
import { checkPlan, parsePlanFile, summarize, toV2, type PlanFile, type PlanSlot } from './planfile.ts';
import { deriveCapture, parsePause, parseSkillText } from './derive.ts';

export type { PlanFile } from './planfile.ts';

/** Wirft mit allen Fehlern, falls die Datei ungültig ist (für CLI und Tests). */
export function validatePlan(p: PlanFile): void {
  const r = p?.format === 'slothly-plan/1' ? checkPlan(p) : parsePlanFile(p);
  if (r.errors.length) throw new Error('Plan ungültig:\n- ' + r.errors.join('\n- '));
}

/** Datei (v1 oder v2) einlesen; wirft mit allen Fehlern. */
export function readPlanFile(raw: unknown): PlanFile {
  const r = parsePlanFile(raw);
  if (!r.plan) throw new Error('Plan ungültig:\n- ' + r.errors.join('\n- '));
  return r.plan;
}

/** Legt den Plan für einen Nutzer an. Übungen werden über den Namen in der Bibliothek geteilt. */
export async function importPlan(db: Db, email: string, p: PlanFile, activate = true): Promise<string> {
  validatePlan(p);
  const u = await db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [normEmail(email)]);
  return importPlanFor(db, u.rows[0]?.id ?? fail(404, `Kein Konto für ${email}`), p, activate);
}

/** Schreibt einen bereits geprüften Plan. Alte Pläne bleiben samt Logs erhalten. */
export async function importPlanFor(db: Db, userId: string, p: PlanFile, activate = true): Promise<string> {
  return tx(db, async c => {
    if (activate) await c.query('UPDATE plans SET active = false WHERE user_id = $1', [userId]);
    const pr = await c.query<{ id: string }>(
      `INSERT INTO plans (user_id, name, subtitle, start_date, weeks, week_labels, topset_week, intro, day_note, rules, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [userId, p.name, p.subtitle ?? null, p.startDate, p.weeks, JSON.stringify(p.weekLabels ?? []), p.topsetWeek ?? null,
       p.intro ?? null, p.dayNote ?? null, JSON.stringify(p.rules ?? []), activate]);
    await writePlanContent(c, pr.rows[0].id, p);
    return pr.rows[0].id;
  });
}

/** Schemata, Tage und Übungsplätze eines Plans schreiben (beim Anlegen und beim Ersetzen). */
async function writePlanContent(c: Tx, planId: string, p: PlanFile) {
  for (const [code, weeks] of Object.entries(p.schemes))
    await c.query('INSERT INTO schemes (plan_id, code, weeks) VALUES ($1, $2, $3)', [planId, code, JSON.stringify(weeks)]);
  for (const [di, d] of p.days.entries()) {
    const dr = await c.query<{ id: string }>(
      `INSERT INTO plan_days (plan_id, idx, title, weekday_offset, warmup, skill, skill_block, cooldown, notes, group_labels)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [planId, di, d.title, d.offset, JSON.stringify(d.warm ?? []), d.skill ?? null, d.skillBlock ? JSON.stringify(d.skillBlock) : null,
       d.cool ?? null, JSON.stringify(d.notes ?? []), JSON.stringify(d.groups ?? {})]);
    for (const [pos, e] of d.ex.entries()) {
      const exId = await upsertExercise(c, e);
      await c.query(
        `INSERT INTO plan_slots (day_id, position, label, exercise_id, cadence, info, start_weight, pause, scheme_code, format, reps, side,
                                 warmup_sets, topset, cap_label, fields, time_mode, weight_ref, pause_s, tabata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [dr.rows[0].id, pos, e.b, exId, e.k ?? null, e.i ?? null, e.st ?? null, e.pa ?? null, e.scheme, e.format,
         e.r ?? null, e.side ?? null, !!e.wu, !!e.top, e.cap ?? null,
         e.fields?.length ? JSON.stringify(e.fields) : null, e.tmode ?? null, e.wref ?? null, e.ps ?? null,
         e.tabata ? JSON.stringify(e.tabata) : null]);
    }
  }
}

async function upsertExercise(c: Tx, e: PlanSlot): Promise<string> {
  // Bestehende Angaben bleiben, fehlende werden ergänzt (Mellas und Dirks Plan teilen sich Übungen).
  const r = await c.query<{ id: string }>(
    `INSERT INTO exercises (name, muscle, video_query) VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET muscle = coalesce(exercises.muscle, EXCLUDED.muscle),
                                      video_query = coalesce(exercises.video_query, EXCLUDED.video_query)
     RETURNING id`, [e.n, e.m ?? null, e.q ?? null]);
  return r.rows[0].id;
}

/** Der aktive Plan eines Nutzers in der Form, die die Oberfläche erwartet (wie die Importdatei). */
export async function loadPlan(db: Db, userId: string, planId?: string) {
  const pr = await db.query(
    `SELECT id, name, subtitle, to_char(start_date, 'YYYY-MM-DD') AS start_date, weeks, week_labels, topset_week, intro, day_note, rules,
            skip_dates, skips_updated_at, revision, moves, moves_updated_at
       FROM plans WHERE user_id = $1 AND ${planId ? 'id = $2' : 'active'}`, planId ? [userId, planId] : [userId]);
  const p = pr.rows[0];
  if (!p) return null;
  const schemes: Record<string, unknown> = {};
  for (const s of (await db.query('SELECT code, weeks FROM schemes WHERE plan_id = $1', [p.id])).rows) schemes[s.code] = s.weeks;
  const days = (await db.query('SELECT * FROM plan_days WHERE plan_id = $1 ORDER BY idx', [p.id])).rows;
  const slots = (await db.query(
    `SELECT s.*, e.name, e.muscle, e.video_query FROM plan_slots s JOIN exercises e ON e.id = s.exercise_id
      WHERE s.day_id = ANY($1) ORDER BY s.position`, [days.map(d => d.id)])).rows;
  return {
    id: p.id, revision: p.revision, name: p.name, subtitle: p.subtitle, startDate: p.start_date, weeks: p.weeks, weekLabels: p.week_labels,
    topsetWeek: p.topset_week, intro: p.intro, dayNote: p.day_note, rules: p.rules, schemes,
    skips: { dates: p.skip_dates, updatedAt: Number(p.skips_updated_at) },
    moves: { map: p.moves, updatedAt: Number(p.moves_updated_at) },
    days: days.map(d => ({
      title: d.title, offset: d.weekday_offset, warm: d.warmup, skill: d.skill, cool: d.cooldown, notes: d.notes, groups: d.group_labels,
      // #5: strukturiert, sonst aus dem alten Text abgeleitet
      skillBlock: d.skill_block ?? parseSkillText(d.skill, p.weeks),
      ex: slots.filter(s => s.day_id === d.id).map(s => {
        const base = {
          b: s.label, n: s.name, m: s.muscle, q: s.video_query, k: s.cadence, i: s.info, st: s.start_weight, pa: s.pause,
          scheme: s.scheme_code, format: s.format, r: s.reps, side: s.side, wu: s.warmup_sets, top: s.topset, cap: s.cap_label,
          tabata: s.tabata,
        };
        // #10/#7: explizite Angaben oder aus den Texten abgeleitet, die Oberfläche braucht nichts mehr zu raten
        const c = deriveCapture({ ...base, fields: s.fields, tmode: s.time_mode, wref: s.weight_ref });
        return { ...base, fields: c.fields, tmode: c.tmode, wref: c.wref, ps: s.pause_s ?? parsePause(s.pause) };
      }),
    })),
  };
}

const LOG_ID = /^w(\d{1,2})d(\d)$/;   // w3d2 = Woche 3, Tag 2 (wie im Artifact)

/** Logs im Format der Oberfläche übernehmen (z. B. Export aus dem Artifact). Neuere gewinnen. */
export async function importLogs(db: Db, planId: string, file: { logs?: Record<string, Record<string, unknown>>; skips?: { dates: string[]; updatedAt: number } }) {
  let n = 0;
  for (const [id, data] of Object.entries(file.logs ?? {})) {
    const m = LOG_ID.exec(id); if (!m) continue;
    n += await saveLog(db, planId, +m[1], +m[2] - 1, data, Number(data.updatedAt ?? 0)) ? 1 : 0;
  }
  if (file.skips) await saveSkips(db, planId, file.skips.dates, file.skips.updatedAt);
  return n;
}

const STATUS = new Set(['offen', 'laeuft', 'fertig', 'abgebrochen']);
const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 1e12 && v < 4e12 ? v : null);

/**
 * #12: Status und Zeiten aus dem Dokument der Oberfläche in eigene Spalten übernehmen.
 * Alte Dokumente ohne status: mit Trainingsdatum = fertig, sonst offen.
 */
export function logColumns(data: Record<string, unknown>) {
  const doneOn = typeof data.doneOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.doneOn) ? data.doneOn : null;
  const status = STATUS.has(String(data.status)) ? String(data.status) : doneOn ? 'fertig' : 'offen';
  const started = ms(data.startedAt), finished = status === 'fertig' || status === 'abgebrochen' ? ms(data.finishedAt) : null;
  let dur = typeof data.durS === 'number' && Number.isFinite(data.durS) && data.durS >= 0 && data.durS < 86400 ? Math.round(data.durS) : null;
  if (dur === null && started && finished && finished >= started) dur = Math.round((finished - started) / 1000);
  return { status, started, finished, dur, doneOn };
}

async function saveLog(db: Db | Tx, planId: string, week: number, dayIdx: number, data: Record<string, unknown>, updatedAt: number): Promise<boolean> {
  const c = logColumns(data);
  const r = await db.query(
    `INSERT INTO workout_logs (plan_id, week, day_idx, data, updated_at, status, started_at, finished_at, duration_s, done_on)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::bigint / 1000.0), to_timestamp($8::bigint / 1000.0), $9, $10)
     ON CONFLICT (plan_id, week, day_idx) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at, saved_at = now(),
       status = EXCLUDED.status, started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at,
       duration_s = EXCLUDED.duration_s, done_on = EXCLUDED.done_on
       WHERE workout_logs.updated_at <= EXCLUDED.updated_at`,
    [planId, week, dayIdx, JSON.stringify(data), updatedAt, c.status, c.started, c.finished, c.dur, c.doneOn]);
  return (r.rowCount ?? 0) > 0;
}

async function saveMoves(db: Db | Tx, planId: string, map: Record<string, string>, updatedAt: number): Promise<boolean> {
  const r = await db.query(`UPDATE plans SET moves = $2, moves_updated_at = $3 WHERE id = $1 AND moves_updated_at <= $3`,
    [planId, JSON.stringify(map), updatedAt]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * #2: Prüft, ob ein neuer Plan einen bestehenden ersetzen kann, ohne Einträge zu verlieren.
 * Einträge hängen an Woche × Tag × Block-Label; fallen Wochen, Tage oder Labels mit Einträgen weg, wird gewarnt.
 */
export async function replaceCheck(db: Db | Tx, planId: string, p: PlanFile) {
  const logs = (await db.query<{ week: number; day_idx: number; data: { ex?: Record<string, { sets?: unknown[]; note?: string }> } }>(
    'SELECT week, day_idx, data FROM workout_logs WHERE plan_id = $1', [planId])).rows;
  const errors: string[] = [], orphans: string[] = [];
  const maxWeek = Math.max(0, ...logs.map(l => l.week)), maxDay = Math.max(-1, ...logs.map(l => l.day_idx));
  if (maxWeek > p.weeks) errors.push(`Es gibt Einträge bis Woche ${maxWeek}, der neue Plan hat nur ${p.weeks} Wochen.`);
  if (maxDay + 1 > p.days.length) errors.push(`Es gibt Einträge an Tag ${maxDay + 1}, der neue Plan hat nur ${p.days.length} Tage pro Woche.`);
  const filled = (e: { sets?: unknown[]; note?: string }) => !!e.note || (e.sets ?? []).some(x => x && typeof x === 'object' && Object.values(x as object).some(v => v !== '' && v !== false && v != null));
  for (const l of logs) {
    const day = p.days[l.day_idx];
    for (const [label, e] of Object.entries(l.data.ex ?? {})) {
      if (!filled(e)) continue;
      if (!day || !day.ex.some(x => x.b === label)) orphans.push(`W${l.week} Tag ${l.day_idx + 1}: ${label}`);
    }
  }
  return { possible: errors.length === 0, errors, orphans, sessions: logs.length };
}

async function saveSkips(db: Db | Tx, planId: string, dates: string[], updatedAt: number): Promise<boolean> {
  const r = await db.query(`UPDATE plans SET skip_dates = $2, skips_updated_at = $3 WHERE id = $1 AND skips_updated_at <= $3`,
    [planId, JSON.stringify(dates), updatedAt]);
  return (r.rowCount ?? 0) > 0;
}

export async function exportUser(db: Db, email: string) {
  const u = await db.query<{ id: string; email: string; name: string }>('SELECT id, email, name FROM users WHERE email = $1', [normEmail(email)]);
  if (!u.rows[0]) throw new Error(`Kein Konto für ${email}`);
  return exportFor(db, u.rows[0]);
}

async function exportFor(db: Db, u: { id: string; email: string; name: string }) {
  const plans = [];
  for (const { id } of (await db.query<{ id: string }>('SELECT id FROM plans WHERE user_id = $1 ORDER BY created_at', [u.id])).rows) {
    const p = (await loadPlan(db, u.id, id))!;
    const logs: Record<string, unknown> = {};
    for (const l of (await db.query('SELECT week, day_idx, data FROM workout_logs WHERE plan_id = $1 ORDER BY week, day_idx', [id])).rows)
      logs[`w${l.week}d${l.day_idx + 1}`] = l.data;
    const { id: _id, revision: _r, skips, ...plan } = p;
    plans.push({ plan: toV2({ format: 'slothly-plan/1', ...plan } as PlanFile), logs: { format: 'slothly-logs/1', logs, skips } });
  }
  return { format: 'slothly-export/1', exportedAt: new Date().toISOString(), user: { email: u.email, name: u.name }, plans };
}

export function planRoutes(app: FastifyInstance, db: Db, cfg: Config) {
  async function ownPlan(userId: string, planId: string): Promise<{ revision: number; active: boolean; name: string }> {
    if (!/^[0-9a-f-]{36}$/.test(planId)) fail(404, 'Plan nicht gefunden');
    const r = await db.query('SELECT revision, active, name FROM plans WHERE id = $1 AND user_id = $2', [planId, userId]);
    return r.rows[0] ?? fail(404, 'Plan nicht gefunden');
  }
  /** Gerät schreibt mit einem Stand von vor dem Neustart: ablehnen, die Oberfläche lädt neu. */
  const staleRev = (q: { rev?: string }, plan: { revision: number }) => q.rev !== undefined && Number(q.rev) !== plan.revision;

  app.get('/api/plan', async req => {
    const u = await requireUser(db, cfg, req);
    return (await loadPlan(db, u.userId)) ?? fail(404, 'Noch kein Plan hinterlegt.');
  });

  app.get('/api/plans/:id/logs', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const u = await requireUser(db, cfg, req);
    await ownPlan(u.userId, req.params.id);
    const logs: Record<string, unknown> = {};
    for (const l of (await db.query('SELECT week, day_idx, data FROM workout_logs WHERE plan_id = $1', [req.params.id])).rows)
      logs[`w${l.week}d${l.day_idx + 1}`] = l.data;
    const s = (await db.query('SELECT skip_dates, skips_updated_at, revision, moves, moves_updated_at FROM plans WHERE id = $1', [req.params.id])).rows[0];
    return { revision: s.revision, logs, skips: { dates: s.skip_dates, updatedAt: Number(s.skips_updated_at) },
             moves: { map: s.moves, updatedAt: Number(s.moves_updated_at) } };
  });

  // Speichern einer Einheit. Ist auf dem Server schon eine neuere Fassung (anderes Gerät),
  // kommt 409 mit dieser Fassung zurück, und die Oberfläche übernimmt sie.
  app.put('/api/plans/:id/logs/:log', async (req: FastifyRequest<{ Params: { id: string; log: string }; Querystring: { rev?: string }; Body: { updatedAt?: number } }>, reply) => {
    const u = await requireUser(db, cfg, req);
    if (staleRev(req.query, await ownPlan(u.userId, req.params.id))) return reply.code(409).send({ reload: true });
    const m = LOG_ID.exec(req.params.log) ?? fail(400, 'Ungültige Einheit');
    const data = req.body as Record<string, unknown>;
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'Ungültige Daten');
    const updatedAt = Number(data.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) fail(400, 'updatedAt fehlt');
    if (await saveLog(db, req.params.id, +m[1], +m[2] - 1, data, updatedAt)) return { ok: true };
    const cur = await db.query('SELECT data FROM workout_logs WHERE plan_id = $1 AND week = $2 AND day_idx = $3', [req.params.id, +m[1], +m[2] - 1]);
    return reply.code(409).send({ data: cur.rows[0]?.data });
  });

  app.put('/api/plans/:id/skips', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { rev?: string }; Body: { dates?: unknown; updatedAt?: number } }>, reply) => {
    const u = await requireUser(db, cfg, req);
    if (staleRev(req.query, await ownPlan(u.userId, req.params.id))) return reply.code(409).send({ reload: true });
    const dates = req.body?.dates;
    if (!Array.isArray(dates) || dates.length > 200 || !dates.every(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))) fail(400, 'Ungültige Daten');
    if (await saveSkips(db, req.params.id, [...new Set(dates as string[])].sort(), Number(req.body?.updatedAt) || Date.now())) return { ok: true };
    const s = (await db.query('SELECT skip_dates, skips_updated_at FROM plans WHERE id = $1', [req.params.id])).rows[0];
    return reply.code(409).send({ dates: s.skip_dates, updatedAt: Number(s.skips_updated_at) });
  });

  // #6: Einheit auf einen bestimmten Tag legen, nur diese Einheit ({"w1d3": "2026-10-31"}).
  app.put('/api/plans/:id/moves', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { rev?: string }; Body: { map?: unknown; updatedAt?: number } }>, reply) => {
    const u = await requireUser(db, cfg, req);
    if (staleRev(req.query, await ownPlan(u.userId, req.params.id))) return reply.code(409).send({ reload: true });
    const map = req.body?.map;
    if (!map || typeof map !== 'object' || Array.isArray(map)) fail(400, 'Ungültige Daten');
    const entries = Object.entries(map as Record<string, unknown>);
    if (entries.length > 200 || !entries.every(([k, v]) => LOG_ID.test(k) && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))) fail(400, 'Ungültige Daten');
    if (await saveMoves(db, req.params.id, map as Record<string, string>, Number(req.body?.updatedAt) || Date.now())) return { ok: true };
    const s = (await db.query('SELECT moves, moves_updated_at FROM plans WHERE id = $1', [req.params.id])).rows[0];
    return reply.code(409).send({ map: s.moves, updatedAt: Number(s.moves_updated_at) });
  });

  // ---------- Pläne selbst verwalten: Vorlage, Download, Prüfen, Hochladen, Wechseln ----------

  const attach = (reply: FastifyReply, name: string, body: unknown) =>
    reply.header('Content-Disposition', `attachment; filename="${name}"`).type('application/json; charset=utf-8').send(JSON.stringify(body, null, 2) + '\n');
  const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'plan';

  app.get('/api/plan-template', async (req, reply) => {
    await requireUser(db, cfg, req);
    return attach(reply, 'slothly-vorlage.json', template());
  });

  // Aktiver (oder gewählter) Plan im Austauschformat: Grundlage für den nächsten Zyklus.
  app.get('/api/plan/download', async (req: FastifyRequest<{ Querystring: { id?: string } }>, reply) => {
    const u = await requireUser(db, cfg, req);
    if (req.query.id) await ownPlan(u.userId, req.query.id);
    const p = (await loadPlan(db, u.userId, req.query.id)) ?? fail(404, 'Noch kein Plan hinterlegt.');
    const { id: _id, revision: _r, skips: _s, ...plan } = p;
    return attach(reply, `slothly-${slug(p.name)}.json`, { _anleitung: template()._anleitung, ...toV2({ format: 'slothly-plan/1', ...plan } as PlanFile) });
  });

  // Prüfen ohne zu speichern: Vorschau und alle Fehler auf einmal.
  app.post('/api/plans/check', async (req: FastifyRequest<{ Body: { plan?: unknown; replaceId?: string } }>) => {
    const u = await requireUser(db, cfg, req);
    const r = parsePlanFile(req.body?.plan);
    let replace = null;
    if (r.plan && req.body?.replaceId) { await ownPlan(u.userId, req.body.replaceId); replace = await replaceCheck(db, req.body.replaceId, r.plan); }
    return { ok: !!r.plan, errors: r.errors, warnings: r.warnings, summary: r.plan ? summarize(r.plan) : null, replace };
  });

  // #2: Plan ersetzen, Einträge behalten. Wochen und Tage mit Einträgen müssen bleiben;
  // fallen Blöcke mit Einträgen weg, ist eine ausdrückliche Bestätigung nötig (force).
  app.put('/api/plans/:id', async (req: FastifyRequest<{ Params: { id: string }; Body: { plan?: unknown; force?: boolean } }>, reply) => {
    const u = await requireUser(db, cfg, req);
    await ownPlan(u.userId, req.params.id);
    const r = parsePlanFile(req.body?.plan);
    if (!r.plan) fail(400, 'Plan ungültig: ' + r.errors.join('; '));
    const p = r.plan!;
    await tx(db, async c => {
      await c.query('SELECT 1 FROM plans WHERE id = $1 FOR UPDATE', [req.params.id]);
      const chk = await replaceCheck(c, req.params.id, p);
      if (!chk.possible) fail(400, chk.errors.join(' '));
      if (chk.orphans.length && req.body?.force !== true) {
        reply.code(409);
        throw Object.assign(new Error('orphans'), { orphans: chk.orphans });
      }
      await c.query('DELETE FROM schemes WHERE plan_id = $1', [req.params.id]);
      await c.query('DELETE FROM plan_days WHERE plan_id = $1', [req.params.id]);   // Übungsplätze per CASCADE
      await c.query(
        `UPDATE plans SET name = $2, subtitle = $3, start_date = $4, weeks = $5, week_labels = $6, topset_week = $7, intro = $8, day_note = $9, rules = $10
          WHERE id = $1`,
        [req.params.id, p.name, p.subtitle ?? null, p.startDate, p.weeks, JSON.stringify(p.weekLabels ?? []), p.topsetWeek ?? null,
         p.intro ?? null, p.dayNote ?? null, JSON.stringify(p.rules ?? [])]);
      await writePlanContent(c, req.params.id, p);
    }).catch((e: Error & { orphans?: string[] }) => {
      if (e.orphans) return reply.code(409).send({ message: 'Blöcke mit Einträgen fehlen im neuen Plan.', orphans: e.orphans });
      throw e;
    });
    if (reply.sent) return reply;
    req.log.info({ plan: req.params.id }, 'Plan ersetzt');
    return { ok: true };
  });

  // Übernehmen: neuer Plan wird aktiv, der bisherige bleibt mit allen Einträgen erhalten.
  app.post('/api/plans', async (req: FastifyRequest<{ Body: { plan?: unknown } }>) => {
    const u = await requireUser(db, cfg, req);
    const r = parsePlanFile(req.body?.plan);
    if (!r.plan) fail(400, 'Plan ungültig: ' + r.errors.join('; '));
    const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM plans WHERE user_id = $1', [u.userId]);
    if (count.rows[0].n >= 100) fail(400, 'Zu viele Pläne gespeichert.');
    return { id: await importPlanFor(db, u.userId, r.plan!, true) };
  });

  app.get('/api/plans', async req => {
    const u = await requireUser(db, cfg, req);
    const r = await db.query(
      `SELECT p.id, p.name, p.subtitle, to_char(p.start_date, 'YYYY-MM-DD') AS start, p.weeks, p.active,
              (SELECT count(*)::int FROM workout_logs w WHERE w.plan_id = p.id) AS sessions
         FROM plans p WHERE p.user_id = $1 ORDER BY p.start_date DESC, p.created_at DESC`, [u.userId]);
    return { plans: r.rows };
  });

  app.post('/api/plans/:id/activate', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const u = await requireUser(db, cfg, req);
    await ownPlan(u.userId, req.params.id);
    await tx(db, async c => {
      await c.query('UPDATE plans SET active = false WHERE user_id = $1 AND active', [u.userId]);
      await c.query('UPDATE plans SET active = true WHERE id = $1', [req.params.id]);
    });
    return { ok: true };
  });

  // Zyklus löschen: Plan samt allen Einträgen. War er aktiv, wird der zuletzt angelegte
  // verbleibende Plan aktiv. Die Oberfläche fragt zweimal nach; der Server verlangt die Bestätigung im Body.
  app.delete('/api/plans/:id', async (req: FastifyRequest<{ Params: { id: string }; Body: { confirm?: string } }>) => {
    const u = await requireUser(db, cfg, req);
    const plan = await ownPlan(u.userId, req.params.id);
    if (req.body?.confirm !== 'loeschen') fail(400, 'Bestätigung fehlt.');
    await tx(db, async c => {
      await c.query('DELETE FROM plans WHERE id = $1', [req.params.id]);   // Schemata, Tage, Übungsplätze, Einträge per CASCADE
      if (plan.active) await c.query(
        `UPDATE plans SET active = true WHERE id = (SELECT id FROM plans WHERE user_id = $1 ORDER BY start_date DESC, created_at DESC LIMIT 1)`, [u.userId]);
    });
    req.log.info({ plan: req.params.id }, 'Zyklus gelöscht');
    return { ok: true };
  });

  // Zyklus neu starten: alle Einträge und Ausfalltage weg, neues Startdatum, Plan bleibt.
  app.post('/api/plans/:id/restart', async (req: FastifyRequest<{ Params: { id: string }; Body: { confirm?: string; start?: string } }>) => {
    const u = await requireUser(db, cfg, req);
    await ownPlan(u.userId, req.params.id);
    if (req.body?.confirm !== 'neustart') fail(400, 'Bestätigung fehlt.');
    const start = String(req.body?.start ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || isNaN(Date.parse(start))) fail(400, 'Bitte ein gültiges Startdatum wählen.');
    await tx(db, async c => {
      await c.query('DELETE FROM workout_logs WHERE plan_id = $1', [req.params.id]);
      await c.query(`UPDATE plans SET start_date = $2, skip_dates = '[]', skips_updated_at = $3, moves = '{}', moves_updated_at = $3, revision = revision + 1 WHERE id = $1`,
        [req.params.id, start, Date.now()]);
    });
    req.log.info({ plan: req.params.id, start }, 'Zyklus neu gestartet');
    return { ok: true };
  });

  // Alle eigenen Daten als JSON, z. B. vor einem Umzug oder als zusätzliche Sicherung.
  app.get('/api/export', async (req, reply) => {
    const u = await requireUser(db, cfg, req);
    const data = await exportFor(db, { id: u.userId, email: u.email, name: u.name });
    return reply.header('Content-Disposition', `attachment; filename="slothly-${new Date().toISOString().slice(0, 10)}.json"`).send(data);
  });
}

let tpl: (PlanV2Template) | null = null;
type PlanV2Template = { _anleitung: string[] } & Record<string, unknown>;
/** Vorlage mit Anleitung (seed/vorlage.json), einmal gelesen. */
export function template(): PlanV2Template {
  return tpl ??= JSON.parse(readFileSync(new URL('../seed/vorlage.json', import.meta.url), 'utf8'));
}
