// #3 Benutzerverwaltung für Admins. Admins verwalten Konten, sehen aber keine Trainingsdaten
// anderer (Pläne, Einträge und Feedback enthalten Gesundheitsangaben).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import { tx, type Db, type Tx } from './db.ts';
import { createLoginLink, fail, normEmail, requireUser, type SessionUser } from './auth.ts';
import { inviteMail, type Mailer } from './mail.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['user', 'admin'];

async function log(c: Db | Tx, admin: SessionUser, targetId: string | null, action: string, detail: unknown = null) {
  await c.query('INSERT INTO admin_log (admin_id, target_id, action, detail) VALUES ($1, $2, $3, $4)',
    [admin.userId, targetId, action, detail === null ? null : JSON.stringify(detail)]);
}

/** Der letzte aktive Admin darf nicht verschwinden (Rolle entziehen oder sperren). */
async function assertNotLastAdmin(c: Tx, userId: string) {
  const r = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id <> $1`, [userId]);
  if (r.rows[0].n === 0) fail(400, 'Das ist der letzte aktive Admin. Erst ein anderes Konto zum Admin machen.');
}

export function adminRoutes(app: FastifyInstance, db: Db, cfg: Config, mailer: Mailer | null) {
  async function requireAdmin(req: FastifyRequest) {
    const u = await requireUser(db, cfg, req);
    if (u.role !== 'admin') fail(403, 'Nur für Admins.');
    return u;
  }
  const uuid = (id: string) => (/^[0-9a-f-]{36}$/.test(id) ? id : fail(404, 'Konto nicht gefunden'));

  app.get('/api/admin/users', async req => {
    await requireAdmin(req);
    const r = await db.query(
      `SELECT u.id, u.email, u.name, u.role, u.disabled_at IS NOT NULL AS disabled, u.created_at,
              (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
              (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now()) AS devices,
              lt.created_at AS last_code_at, lt.mail_status AS last_code_mail, lt.used_at IS NOT NULL AS last_code_used,
              (SELECT p.name FROM plans p WHERE p.user_id = u.id AND p.active) AS plan
         FROM users u
         LEFT JOIN LATERAL (SELECT created_at, mail_status, used_at FROM login_tokens WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) lt ON true
        ORDER BY u.created_at`);
    return { users: r.rows };
  });

  app.post('/api/admin/users', async (req: FastifyRequest<{ Body: { email?: string; name?: string; role?: string; invite?: boolean } }>) => {
    const admin = await requireAdmin(req);
    const email = normEmail(req.body?.email), name = String(req.body?.name ?? '').trim(), role = req.body?.role ?? 'user';
    if (!EMAIL.test(email)) fail(400, 'Bitte eine gültige E-Mail-Adresse eingeben.');
    if (!name || name.length > 80) fail(400, 'Bitte einen Namen eingeben.');
    if (!ROLES.includes(role)) fail(400, 'Unbekannte Rolle.');
    const r = await db.query<{ id: string }>(
      `INSERT INTO users (email, name, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id`, [email, name, role]);
    const id = r.rows[0]?.id ?? fail(409, 'Diese Adresse hat schon ein Konto.');
    await log(db, admin, id, 'user_created', { role });
    let mailed = false;
    if (req.body?.invite && mailer) {
      try { await mailer.send(inviteMail(email, name, cfg.publicOrigin)); mailed = true; }
      catch (e) { req.log.error({ err: e }, 'Einladung nicht verschickt'); }
    }
    return { id, mailed };
  });

  app.patch('/api/admin/users/:id', async (req: FastifyRequest<{ Params: { id: string }; Body: { name?: string; email?: string; role?: string; disabled?: boolean } }>) => {
    const admin = await requireAdmin(req);
    const id = uuid(req.params.id), b = req.body ?? {};
    await tx(db, async c => {
      const cur = (await c.query<{ id: string; role: string; disabled: boolean }>(
        'SELECT id, role, disabled_at IS NOT NULL AS disabled FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0] ?? fail(404, 'Konto nicht gefunden');
      // Rolle entziehen oder sperren: nie den letzten Admin (auch nicht sich selbst)
      if (cur.role === 'admin' && !cur.disabled && ((b.role && b.role !== 'admin') || b.disabled === true)) await assertNotLastAdmin(c, id);
      if (b.name !== undefined) {
        const name = String(b.name).trim();
        if (!name || name.length > 80) fail(400, 'Bitte einen Namen eingeben.');
        await c.query('UPDATE users SET name = $2 WHERE id = $1', [id, name]);
      }
      if (b.email !== undefined) {
        const email = normEmail(b.email);
        if (!EMAIL.test(email)) fail(400, 'Bitte eine gültige E-Mail-Adresse eingeben.');
        const dup = await c.query('SELECT 1 FROM users WHERE email = $1 AND id <> $2', [email, id]);
        if (dup.rows[0]) fail(409, 'Diese Adresse hat schon ein Konto.');
        await c.query('UPDATE users SET email = $2 WHERE id = $1', [id, email]);
        await c.query('DELETE FROM login_tokens WHERE user_id = $1 AND used_at IS NULL', [id]);   // offene Codes gingen an die alte Adresse
      }
      if (b.role !== undefined) {
        if (!ROLES.includes(b.role)) fail(400, 'Unbekannte Rolle.');
        await c.query('UPDATE users SET role = $2 WHERE id = $1', [id, b.role]);
      }
      if (b.disabled !== undefined) {
        await c.query(`UPDATE users SET disabled_at = ${b.disabled ? 'now()' : 'NULL'} WHERE id = $1`, [id]);
        if (b.disabled) await c.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      }
      await log(c, admin, id, 'user_changed', Object.fromEntries(Object.entries(b).filter(([k]) => ['name', 'email', 'role', 'disabled'].includes(k))));
    });
    return { ok: true };
  });

  // Code für jemanden erzeugen und anzeigen (wenn die Mail nicht ankommt). Gilt wie ein angeforderter Code.
  app.post('/api/admin/users/:id/login-code', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const admin = await requireAdmin(req);
    const id = uuid(req.params.id);
    const u = (await db.query<{ email: string }>('SELECT email FROM users WHERE id = $1 AND disabled_at IS NULL', [id])).rows[0] ?? fail(404, 'Kein aktives Konto.');
    const l = await createLoginLink(db, cfg, u.email, true);
    if (!l || l.limit) fail(500, 'Code konnte nicht erzeugt werden.');
    await log(db, admin, id, 'login_code_created');
    return { code: (l as { code: string }).code, minutes: cfg.loginLinkMinutes, email: u.email };
  });

  app.post('/api/admin/users/:id/logout-all', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const admin = await requireAdmin(req);
    const id = uuid(req.params.id);
    const r = await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await log(db, admin, id, 'sessions_revoked', { n: r.rowCount });
    return { ok: true, n: r.rowCount };
  });
}
