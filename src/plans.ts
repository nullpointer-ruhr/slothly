// Pläne: Import aus JSON (Format slothly-plan/1, siehe seed/demo-plan.json), Abfrage für die
// Oberfläche, Trainings-Logs und Export. Jede Abfrage ist an den angemeldeten Nutzer gebunden.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import { tx, type Db, type Tx } from './db.ts';
import { fail, normEmail, requireUser } from './auth.ts';

export interface PlanSlot {
  b: string; n: string; m?: string | null; q?: string | null; k?: string | null; i?: string | null;
  st?: string | null; pa?: string | null; scheme: string; format: 'standard' | 'per_pause' | 'circuit' | 'rounds';
  r?: string | null; side?: string | null; wu?: boolean; top?: boolean; cap?: string | null;
}
export interface PlanDay {
  title: string; offset: number; warm?: string[]; skill?: string | null; cool?: string | null;
  notes?: string[]; groups?: Record<string, string>; ex: PlanSlot[];
}
export interface PlanFile {
  format: 'slothly-plan/1'; name: string; subtitle?: string | null; startDate: string; weeks: number;
  weekLabels?: string[]; topsetWeek?: number | null; intro?: string | null; dayNote?: string | null;
  rules?: unknown[]; schemes: Record<string, [number, string | null][]>; days: PlanDay[];
}

const FORMATS = new Set(['standard', 'per_pause', 'circuit', 'rounds']);

/** Prüft die Datei, bevor etwas geschrieben wird. Wirft mit einer verständlichen Meldung. */
export function validatePlan(p: PlanFile): void {
  const err = (m: string): never => { throw new Error(`Plan ungültig: ${m}`); };
  if (p?.format !== 'slothly-plan/1') err('format muss "slothly-plan/1" sein');
  if (!p.name) err('name fehlt');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.startDate ?? '')) err('startDate muss JJJJ-MM-TT sein');
  if (!Number.isInteger(p.weeks) || p.weeks < 1 || p.weeks > 26) err('weeks muss 1 bis 26 sein');
  for (const [code, w] of Object.entries(p.schemes ?? {})) {
    if (!/^[A-Z0-9_]{1,16}$/.test(code)) err(`Schema-Code ${code}: nur A-Z, 0-9, _`);
    if (!Array.isArray(w) || w.length !== p.weeks) err(`Schema ${code}: braucht genau ${p.weeks} Wochen`);
    w.forEach((x, i) => { if (!Array.isArray(x) || !Number.isInteger(x[0]) || x[0] < 0) err(`Schema ${code}, Woche ${i + 1}: [Sätze, RPE]`); });
  }
  if (!Array.isArray(p.days) || !p.days.length) err('days fehlt');
  p.days.forEach((d, di) => {
    if (!d.title) err(`Tag ${di + 1}: title fehlt`);
    if (!Number.isInteger(d.offset) || d.offset < 0 || d.offset > 6) err(`Tag ${di + 1}: offset 0 bis 6 (0 = Montag)`);
    const seen = new Set<string>();
    d.ex.forEach(e => {
      const where = `Tag ${di + 1}, ${e.b}`;
      if (!/^[A-Z][A-Z0-9+]{0,3}$/.test(e.b ?? '')) err(`${where}: Label wie A, A+, B1 (Großbuchstabe, max. 4 Zeichen)`);
      if (!e.n) err(`${where}: Name (n) fehlt`);
      if (seen.has(e.b)) err(`${where}: Label doppelt`); seen.add(e.b);
      if (!p.schemes[e.scheme]) err(`${where}: Schema ${e.scheme} fehlt in schemes`);
      if (!FORMATS.has(e.format)) err(`${where}: format ${e.format} unbekannt`);
    });
  });
}

/** Legt den Plan für einen Nutzer an. Übungen werden über den Namen in der Bibliothek geteilt. */
export async function importPlan(db: Db, email: string, p: PlanFile, activate = true): Promise<string> {
  validatePlan(p);
  return tx(db, async c => {
    const u = await c.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [normEmail(email)]);
    const userId = u.rows[0]?.id ?? fail(404, `Kein Konto für ${email}`);
    if (activate) await c.query('UPDATE plans SET active = false WHERE user_id = $1', [userId]);
    const pr = await c.query<{ id: string }>(
      `INSERT INTO plans (user_id, name, subtitle, start_date, weeks, week_labels, topset_week, intro, day_note, rules, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [userId, p.name, p.subtitle ?? null, p.startDate, p.weeks, JSON.stringify(p.weekLabels ?? []), p.topsetWeek ?? null,
       p.intro ?? null, p.dayNote ?? null, JSON.stringify(p.rules ?? []), activate]);
    const planId = pr.rows[0].id;
    for (const [code, weeks] of Object.entries(p.schemes))
      await c.query('INSERT INTO schemes (plan_id, code, weeks) VALUES ($1, $2, $3)', [planId, code, JSON.stringify(weeks)]);
    for (const [di, d] of p.days.entries()) {
      const dr = await c.query<{ id: string }>(
        `INSERT INTO plan_days (plan_id, idx, title, weekday_offset, warmup, skill, cooldown, notes, group_labels)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [planId, di, d.title, d.offset, JSON.stringify(d.warm ?? []), d.skill ?? null, d.cool ?? null,
         JSON.stringify(d.notes ?? []), JSON.stringify(d.groups ?? {})]);
      for (const [pos, e] of d.ex.entries()) {
        const exId = await upsertExercise(c, e);
        await c.query(
          `INSERT INTO plan_slots (day_id, position, label, exercise_id, cadence, info, start_weight, pause, scheme_code, format, reps, side, warmup_sets, topset, cap_label)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [dr.rows[0].id, pos, e.b, exId, e.k ?? null, e.i ?? null, e.st ?? null, e.pa ?? null, e.scheme, e.format,
           e.r ?? null, e.side ?? null, !!e.wu, !!e.top, e.cap ?? null]);
      }
    }
    return planId;
  });
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
            skip_dates, skips_updated_at
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
    id: p.id, name: p.name, subtitle: p.subtitle, startDate: p.start_date, weeks: p.weeks, weekLabels: p.week_labels,
    topsetWeek: p.topset_week, intro: p.intro, dayNote: p.day_note, rules: p.rules, schemes,
    skips: { dates: p.skip_dates, updatedAt: Number(p.skips_updated_at) },
    days: days.map(d => ({
      title: d.title, offset: d.weekday_offset, warm: d.warmup, skill: d.skill, cool: d.cooldown, notes: d.notes, groups: d.group_labels,
      ex: slots.filter(s => s.day_id === d.id).map(s => ({
        b: s.label, n: s.name, m: s.muscle, q: s.video_query, k: s.cadence, i: s.info, st: s.start_weight, pa: s.pause,
        scheme: s.scheme_code, format: s.format, r: s.reps, side: s.side, wu: s.warmup_sets, top: s.topset, cap: s.cap_label,
      })),
    })),
  };
}

const LOG_ID = /^w(\d{1,2})d(\d)$/;   // w3d2 = Woche 3, Tag 2 (wie im Artifact)

/** Logs im Format der Oberfläche übernehmen (z. B. Export aus dem Artifact). Neuere gewinnen. */
export async function importLogs(db: Db, planId: string, file: { logs?: Record<string, { updatedAt?: number }>; skips?: { dates: string[]; updatedAt: number } }) {
  let n = 0;
  for (const [id, data] of Object.entries(file.logs ?? {})) {
    const m = LOG_ID.exec(id); if (!m) continue;
    n += await saveLog(db, planId, +m[1], +m[2] - 1, data, Number(data.updatedAt ?? 0)) ? 1 : 0;
  }
  if (file.skips) await saveSkips(db, planId, file.skips.dates, file.skips.updatedAt);
  return n;
}

async function saveLog(db: Db | Tx, planId: string, week: number, dayIdx: number, data: unknown, updatedAt: number): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO workout_logs (plan_id, week, day_idx, data, updated_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (plan_id, week, day_idx) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at, saved_at = now()
       WHERE workout_logs.updated_at <= EXCLUDED.updated_at`,
    [planId, week, dayIdx, JSON.stringify(data), updatedAt]);
  return (r.rowCount ?? 0) > 0;
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
    const { id: _id, skips, ...plan } = p;
    plans.push({ plan: { format: 'slothly-plan/1', ...plan }, logs: { format: 'slothly-logs/1', logs, skips } });
  }
  return { format: 'slothly-export/1', exportedAt: new Date().toISOString(), user: { email: u.email, name: u.name }, plans };
}

export function planRoutes(app: FastifyInstance, db: Db, cfg: Config) {
  async function ownPlan(userId: string, planId: string) {
    if (!/^[0-9a-f-]{36}$/.test(planId)) fail(404, 'Plan nicht gefunden');
    const r = await db.query('SELECT 1 FROM plans WHERE id = $1 AND user_id = $2', [planId, userId]);
    if (!r.rows[0]) fail(404, 'Plan nicht gefunden');
  }

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
    const s = (await db.query('SELECT skip_dates, skips_updated_at FROM plans WHERE id = $1', [req.params.id])).rows[0];
    return { logs, skips: { dates: s.skip_dates, updatedAt: Number(s.skips_updated_at) } };
  });

  // Speichern einer Einheit. Ist auf dem Server schon eine neuere Fassung (anderes Gerät),
  // kommt 409 mit dieser Fassung zurück, und die Oberfläche übernimmt sie.
  app.put('/api/plans/:id/logs/:log', async (req: FastifyRequest<{ Params: { id: string; log: string }; Body: { updatedAt?: number } }>, reply) => {
    const u = await requireUser(db, cfg, req);
    await ownPlan(u.userId, req.params.id);
    const m = LOG_ID.exec(req.params.log) ?? fail(400, 'Ungültige Einheit');
    const data = req.body;
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'Ungültige Daten');
    const updatedAt = Number(data.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) fail(400, 'updatedAt fehlt');
    if (await saveLog(db, req.params.id, +m[1], +m[2] - 1, data, updatedAt)) return { ok: true };
    const cur = await db.query('SELECT data FROM workout_logs WHERE plan_id = $1 AND week = $2 AND day_idx = $3', [req.params.id, +m[1], +m[2] - 1]);
    return reply.code(409).send({ data: cur.rows[0]?.data });
  });

  app.put('/api/plans/:id/skips', async (req: FastifyRequest<{ Params: { id: string }; Body: { dates?: unknown; updatedAt?: number } }>, reply) => {
    const u = await requireUser(db, cfg, req);
    await ownPlan(u.userId, req.params.id);
    const dates = req.body?.dates;
    if (!Array.isArray(dates) || dates.length > 200 || !dates.every(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))) fail(400, 'Ungültige Daten');
    if (await saveSkips(db, req.params.id, [...new Set(dates as string[])].sort(), Number(req.body?.updatedAt) || Date.now())) return { ok: true };
    const s = (await db.query('SELECT skip_dates, skips_updated_at FROM plans WHERE id = $1', [req.params.id])).rows[0];
    return reply.code(409).send({ dates: s.skip_dates, updatedAt: Number(s.skips_updated_at) });
  });

  // Alle eigenen Daten als JSON, z. B. vor einem Umzug oder als zusätzliche Sicherung.
  app.get('/api/export', async (req, reply) => {
    const u = await requireUser(db, cfg, req);
    const data = await exportFor(db, { id: u.userId, email: u.email, name: u.name });
    return reply.header('Content-Disposition', `attachment; filename="slothly-${new Date().toISOString().slice(0, 10)}.json"`).send(data);
  });
}
