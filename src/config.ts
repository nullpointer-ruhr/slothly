// Konfiguration ausschließlich über Umgebungsvariablen (12-Factor), damit die App
// ohne Änderung auf jedem Host läuft (k3s, Docker Compose, nackter Server).
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  /** Öffentliche Origin, z. B. https://slothly.taktbuch.de (Origin-Prüfung und Links in Mails). */
  publicOrigin: string;
  secureCookies: boolean;
  trustProxy: boolean;
  sessionDays: number;
  loginLinkMinutes: number;
  /** Anmelde-Anfragen je IP in 10 Minuten. */
  loginRateLimit: number;
  webDir: string;
  fontDir: string;
  /** SMTP: SMTP_HOST/PORT/USER/PASS (wie bei Taktbuch) oder SMTP_URL. Leer = kein Mailversand. */
  smtp: { host: string; port: number; user: string; pass: string } | null;
  smtpUrl: string | null;
  mailFrom: string;
  mailReplyTo: string | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`Umgebungsvariable ${k} fehlt`); return v; };
  const origin = need('PUBLIC_ORIGIN').replace(/\/$/, '');
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: need('DATABASE_URL'),
    publicOrigin: origin,
    secureCookies: (env.SECURE_COOKIES ?? String(origin.startsWith('https://'))) === 'true',
    trustProxy: (env.TRUST_PROXY ?? 'true') === 'true',
    sessionDays: Number(env.SESSION_DAYS ?? 180),
    loginLinkMinutes: Number(env.LOGIN_LINK_MINUTES ?? 20),
    loginRateLimit: Number(env.LOGIN_RATE_LIMIT ?? 10),
    webDir: env.WEB_DIR ?? path.resolve(here, '../web'),
    fontDir: env.FONT_DIR ?? path.resolve(here, '../node_modules/@fontsource'),
    smtp: env.SMTP_HOST ? { host: env.SMTP_HOST, port: Number(env.SMTP_PORT ?? 465), user: env.SMTP_USER ?? '', pass: env.SMTP_PASS ?? '' } : null,
    smtpUrl: env.SMTP_URL || null,
    mailFrom: env.MAIL_FROM || 'Slothly <noreply@taktbuch.de>',
    mailReplyTo: env.MAIL_REPLY_TO || null,
  };
}
