// Auslieferung der Oberfläche mit strikter CSP: Inline-Skripte nur per SHA-256-Hash,
// keine fremden Quellen (Schriften kommen lokal aus @fontsource, keine Google-Anfragen).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { readSession } from './auth.ts';

interface Page { html: string; csp: string }

export function cspFor(html: string): string {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  return [
    "default-src 'none'",
    `script-src ${hashes.join(' ') || "'none'"}`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function load(dir: string, file: string): Page {
  const html = readFileSync(path.join(dir, file), 'utf8');
  return { html, csp: cspFor(html) };
}

// Feste Liste, kein Pfad aus der Anfrage.
const FONTS: Record<string, string> = {
  'barlow-400.woff2': 'barlow/files/barlow-latin-400-normal.woff2',
  'barlow-500.woff2': 'barlow/files/barlow-latin-500-normal.woff2',
  'barlow-600.woff2': 'barlow/files/barlow-latin-600-normal.woff2',
  'barlow-condensed-600.woff2': 'barlow-condensed/files/barlow-condensed-latin-600-normal.woff2',
  'barlow-condensed-700.woff2': 'barlow-condensed/files/barlow-condensed-latin-700-normal.woff2',
};
const STATIC: Record<string, string> = {
  '/manifest.webmanifest': 'application/manifest+json',
  '/logo.jpg': 'image/jpeg',
  '/icon-192.png': 'image/png', '/icon-512.png': 'image/png', '/apple-touch-icon.png': 'image/png', '/favicon.ico': 'image/x-icon',
};

export function webRoutes(app: FastifyInstance, db: Db, cfg: Config) {
  const pages = { app: load(cfg.webDir, 'app.html'), login: load(cfg.webDir, 'login.html') };

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (cfg.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000');
    return payload;
  });

  const send = (reply: FastifyReply, p: Page) =>
    reply.type('text/html; charset=utf-8').header('Content-Security-Policy', p.csp).header('Cache-Control', 'no-store').send(p.html);

  app.get('/', async (req, reply) => ((await readSession(db, cfg, req)) ? send(reply, pages.app) : reply.redirect('/login')));
  app.get('/login', async (req, reply) => ((await readSession(db, cfg, req)) ? reply.redirect('/') : send(reply, pages.login)));
  app.get('/anmelden', async (_req, reply) => send(reply, pages.login));

  app.get('/fonts/:file', async (req, reply) => {
    const rel = FONTS[(req.params as { file: string }).file];
    const p = rel && path.join(cfg.fontDir, rel);
    if (!p || !existsSync(p)) return reply.code(404).send();
    return reply.type('font/woff2').header('Cache-Control', 'public, max-age=31536000, immutable').send(readFileSync(p));
  });
  for (const [url, type] of Object.entries(STATIC)) {
    app.get(url, async (_req, reply) => {
      const p = path.join(cfg.webDir, url.slice(1));
      if (!existsSync(p)) return reply.code(404).send();
      return reply.type(type).header('Cache-Control', 'public, max-age=86400').send(readFileSync(p));
    });
  }
}
