// Anmeldung per Einmal-Link aus der Mail, danach langlebige Session im Cookie.
// Keine Passwörter: Wer das Postfach hat, kommt rein. Für zwei Nutzer der einfachste
// sichere Weg; eine Registrierung gibt es nicht, Konten legt nur die CLI an.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import { tx, type Db, type Tx } from './db.ts';
import { loginMail, type Mailer } from './mail.ts';

export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest();
export const normEmail = (e: unknown) => String(e ?? '').trim().toLowerCase();

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const fail = (status: number, message: string): never => { throw new HttpError(status, message); };

export interface SessionUser { userId: string; email: string; name: string }

export const cookieName = (cfg: Config) => (cfg.secureCookies ? '__Host-slothly' : 'slothly_session');

export const CODE_ATTEMPTS = 5;        // Fehlversuche pro Code
export const REQUESTS_PER_HOUR = 5;    // angeforderte Codes pro Konto und Stunde

/**
 * Erzeugt Link und 6-stelligen Code für ein bestehendes, aktives Konto (sonst null).
 * Gültig ist immer nur der zuletzt angeforderte Code. Ohne `force` höchstens
 * REQUESTS_PER_HOUR pro Stunde (dann 'limit'), damit sich Codes nicht durchprobieren lassen.
 */
export async function createLoginLink(c: Db | Tx, cfg: Pick<Config, 'publicOrigin' | 'loginLinkMinutes'>, email: string, force = false) {
  const u = await c.query<{ id: string; name: string }>('SELECT id, name FROM users WHERE email = $1 AND disabled_at IS NULL', [normEmail(email)]);
  if (!u.rows[0]) return null;
  const userId = u.rows[0].id;
  await c.query(`DELETE FROM login_tokens WHERE user_id = $1 AND created_at < now() - interval '1 day'`, [userId]);
  if (!force) {
    const n = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM login_tokens WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [userId]);
    if (n.rows[0].n >= REQUESTS_PER_HOUR) return 'limit' as const;
  }
  const t = token();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await c.query(`INSERT INTO login_tokens (token_hash, user_id, expires_at, code_hash) VALUES ($1, $2, now() + make_interval(mins => $3), $4)`,
    [sha256(t), userId, cfg.loginLinkMinutes, sha256(code)]);
  return { link: `${cfg.publicOrigin}/anmelden#${t}`, code, name: u.rows[0].name };
}

export async function readSession(db: Db, cfg: Config, req: FastifyRequest): Promise<SessionUser | null> {
  const t = req.cookies[cookieName(cfg)];
  if (!t) return null;
  const r = await db.query<{ user_id: string; email: string; name: string; stale: boolean }>(
    `SELECT s.user_id, u.email, u.name, s.last_seen_at < now() - interval '1 hour' AS stale
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`, [sha256(t)]);
  const row = r.rows[0];
  if (!row) return null;
  if (row.stale) {   // rollierend verlängern, höchstens einmal pro Stunde ein Schreibzugriff
    await db.query(`UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => $2) WHERE id_hash = $1`, [sha256(t), cfg.sessionDays]);
  }
  return { userId: row.user_id, email: row.email, name: row.name };
}

export async function requireUser(db: Db, cfg: Config, req: FastifyRequest): Promise<SessionUser> {
  return (await readSession(db, cfg, req)) ?? fail(401, 'Nicht angemeldet');
}

export function authRoutes(app: FastifyInstance, db: Db, cfg: Config, mailer: Mailer | null) {
  async function startSession(c: Tx, req: FastifyRequest, reply: FastifyReply, userId: string) {
    const s = token();
    await c.query(`INSERT INTO sessions (id_hash, user_id, expires_at, user_agent) VALUES ($1, $2, now() + make_interval(days => $3), $4)`,
      [sha256(s), userId, cfg.sessionDays, String(req.headers['user-agent'] ?? '').slice(0, 300)]);
    reply.setCookie(cookieName(cfg), s, { path: '/', httpOnly: true, secure: cfg.secureCookies, sameSite: 'lax', maxAge: cfg.sessionDays * 86400 });
  }

  const limited = { config: { rateLimit: { max: cfg.loginRateLimit, timeWindow: '10 minutes' } } };

  app.get('/api/config', async () => ({ mail: !!mailer }));

  // Antwort ist immer gleich, damit niemand ausprobieren kann, welche Adressen es gibt.
  app.post('/api/login/request', limited, async (req: FastifyRequest<{ Body: { email?: string } }>) => {
    const email = normEmail(req.body?.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Bitte eine gültige E-Mail-Adresse eingeben.');
    if (!mailer) fail(503, 'Mailversand ist nicht eingerichtet. Bitte den Link beim Betreiber anfordern.');
    const l = await createLoginLink(db, cfg, email);
    if (l && l !== 'limit') {
      try { await mailer!.send(loginMail(email, l.name, l.link, l.code, cfg.loginLinkMinutes)); }
      catch (e) { req.log.error({ err: e }, 'Mailversand fehlgeschlagen'); fail(502, 'Mail konnte nicht verschickt werden. Bitte später erneut versuchen.'); }
    }
    return { ok: true };
  });

  // Der Link öffnet /anmelden#token; die Seite schickt das Token per POST. So verbraucht
  // ein Mail-Scanner, der Links vorab aufruft, das Token nicht, und es landet in keinem Log.
  app.post('/api/login/confirm', limited, async (req: FastifyRequest<{ Body: { token?: string } }>, reply: FastifyReply) => {
    const t = String(req.body?.token ?? '');
    if (!t) fail(400, 'Link unvollständig.');
    await tx(db, async c => {
      const r = await c.query<{ user_id: string }>(
        `UPDATE login_tokens lt SET used_at = now() FROM users u
          WHERE lt.token_hash = $1 AND lt.used_at IS NULL AND lt.expires_at > now()
            AND u.id = lt.user_id AND u.disabled_at IS NULL
          RETURNING lt.user_id`, [sha256(t)]);
      const userId = r.rows[0]?.user_id ?? fail(400, 'Der Link ist abgelaufen oder wurde schon benutzt. Bitte einen neuen anfordern.');
      await startSession(c, req, reply, userId);
    });
    return { ok: true };
  });

  // Anmeldung mit dem Code aus der Mail, direkt in der App (wichtig für die iPhone-Home-Bildschirm-App).
  // Geprüft wird nur der zuletzt angeforderte Code; nach CODE_ATTEMPTS Fehlversuchen ist er verbraucht.
  app.post('/api/login/code', limited, async (req: FastifyRequest<{ Body: { email?: string; code?: string } }>, reply: FastifyReply) => {
    const email = normEmail(req.body?.email);
    const code = String(req.body?.code ?? '').replace(/\D/g, '');
    if (code.length !== 6) fail(400, 'Bitte den 6-stelligen Code aus der Mail eingeben.');
    const wrong = 'Der Code stimmt nicht oder ist abgelaufen.';
    // Antwort erst nach dem Commit: sonst kann der nächste Aufruf schneller sein als die neue Session.
    const msg = await tx(db, async c => {
      const r = await c.query<{ token_hash: Buffer; user_id: string; code_hash: Buffer | null; attempts: number }>(
        `SELECT lt.token_hash, lt.user_id, lt.code_hash, lt.attempts FROM login_tokens lt JOIN users u ON u.id = lt.user_id
          WHERE u.email = $1 AND u.disabled_at IS NULL AND lt.used_at IS NULL AND lt.expires_at > now()
          ORDER BY lt.created_at DESC LIMIT 1 FOR UPDATE OF lt`, [email]);
      const row = r.rows[0];
      if (!row?.code_hash || row.attempts >= CODE_ATTEMPTS) return wrong + ' Bitte einen neuen anfordern.';
      if (!timingSafeEqual(row.code_hash, sha256(code))) {
        // Fehlversuch zählen und committen (eine Exception würde ihn zurückrollen).
        await c.query('UPDATE login_tokens SET attempts = attempts + 1 WHERE token_hash = $1', [row.token_hash]);
        const left = CODE_ATTEMPTS - row.attempts - 1;
        return left > 0 ? `${wrong} Noch ${left} Versuch${left === 1 ? '' : 'e'}.` : wrong + ' Bitte einen neuen anfordern.';
      }
      await c.query('UPDATE login_tokens SET used_at = now() WHERE token_hash = $1', [row.token_hash]);
      await startSession(c, req, reply, row.user_id);
      return null;
    });
    if (msg) fail(400, msg);
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    const t = req.cookies[cookieName(cfg)];
    if (t) await db.query('DELETE FROM sessions WHERE id_hash = $1', [sha256(t)]);
    reply.clearCookie(cookieName(cfg), { path: '/', httpOnly: true, secure: cfg.secureCookies, sameSite: 'lax' });
    return { ok: true };
  });

  app.get('/api/me', async req => {
    const u = await requireUser(db, cfg, req);
    return { email: u.email, name: u.name };
  });
}
