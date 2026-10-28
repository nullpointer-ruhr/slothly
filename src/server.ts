import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { authRoutes, HttpError } from './auth.ts';
import { planRoutes } from './plans.ts';
import { webRoutes } from './web.ts';
import { createMailer, type Mailer } from './mail.ts';

export async function buildApp(cfg: Config, db: Db, opts: { logger?: boolean; mailer?: Mailer | null } = {}): Promise<FastifyInstance> {
  const mailer = opts.mailer !== undefined ? opts.mailer : createMailer(cfg);
  const app = Fastify({ logger: opts.logger ?? true, trustProxy: cfg.trustProxy, bodyLimit: 256 * 1024 });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((e: Error & { statusCode?: number }, _req, reply) => {
    if (e instanceof HttpError) return reply.code(e.status).send({ message: e.message });
    if (e.statusCode === 429) return reply.code(429).send({ message: 'Zu viele Versuche. Bitte kurz warten.' });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ message: e.message });
    app.log.error(e);
    return reply.code(500).send({ message: 'Interner Fehler' });
  });

  // CSRF-Schutz: schreibende API-Aufrufe nur von der eigenen Origin.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.method === 'GET' || req.method === 'HEAD') return;
    if (req.headers.origin !== cfg.publicOrigin) return reply.code(403).send({ message: 'Ungültige Herkunft der Anfrage' });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try { await db.query('SELECT 1'); return { ok: true }; }
    catch { return reply.code(503).send({ ok: false }); }
  });

  authRoutes(app, db, cfg, mailer);
  planRoutes(app, db, cfg);
  webRoutes(app, db, cfg);
  return app;
}
