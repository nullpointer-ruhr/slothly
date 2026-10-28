// Mailversand über SMTP (derselbe Zugang wie bei Taktbuch). Ohne Zugang: kein Versand,
// der Anmelde-Link kommt dann über die Kommandozeile (cli.ts login-link).
import nodemailer from 'nodemailer';
import type { Config } from './config.ts';

export interface Mail { to: string; subject: string; text: string; html: string }
export interface Mailer { send(m: Mail): Promise<void> }

export function createMailer(cfg: Pick<Config, 'smtp' | 'smtpUrl' | 'mailFrom' | 'mailReplyTo'>): Mailer | null {
  let transport;
  if (cfg.smtp) {
    const { host, port, user, pass } = cfg.smtp;
    // 465: TLS von Anfang an; sonst (587) Pflicht-Upgrade per STARTTLS, nie unverschlüsselt.
    transport = nodemailer.createTransport({ host, port, secure: port === 465, requireTLS: port !== 465, auth: user ? { user, pass } : undefined });
  } else if (cfg.smtpUrl) {
    transport = nodemailer.createTransport(cfg.smtpUrl);
  } else return null;
  return {
    async send(m) {
      await transport.sendMail({ from: cfg.mailFrom, replyTo: cfg.mailReplyTo ?? undefined, to: m.to, subject: m.subject, text: m.text, html: m.html });
    },
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function loginMail(to: string, name: string, link: string, code: string, minutes: number): Mail {
  const p = [
    `Hallo ${name},`,
    `dein Anmelde-Code für Slothly ist ${code}. Tipp ihn in der App ein, in der du den Code angefordert hast (auch in der App auf dem Home-Bildschirm).`,
    `Oder melde dich über den Knopf an; das meldet den Browser an, in dem sich der Link öffnet. Code und Link sind ${minutes} Minuten gültig und funktionieren genau einmal.`,
  ];
  const footer = 'Falls du keine Anmeldung angefordert hast, ignoriere diese Mail einfach.';
  return {
    to, subject: `${code} ist dein Slothly-Code`,
    text: `${p.join('\n\n')}\n\n${link}\n\n${footer}\n`,
    html: `<!doctype html><html lang="de"><body style="margin:0;background:#eef0f4;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#15181e">
<div style="max-width:480px;margin:32px auto;background:#fff;border:1px solid #dce0e8;border-radius:12px;padding:28px">
<p style="font-size:15px;line-height:1.5;margin:0 0 14px">${esc(p[0])}</p>
<p style="font-size:15px;line-height:1.5;margin:0 0 6px">Dein Anmelde-Code:</p>
<p style="font-size:34px;font-weight:700;letter-spacing:.18em;margin:0 0 14px;font-family:ui-monospace,Menlo,monospace">${esc(code)}</p>
<p style="font-size:15px;line-height:1.5;margin:0 0 14px">Tipp ihn in der App ein, in der du ihn angefordert hast. Oder melde dich über den Knopf an. Beides ist ${minutes} Minuten gültig und funktioniert genau einmal.</p>
<p style="margin:22px 0"><a href="${esc(link)}" style="display:inline-block;background:#1f4fd1;color:#fff;text-decoration:none;padding:12px 20px;border-radius:9px;font-weight:600">Im Browser anmelden</a></p>
<p style="font-size:13px;line-height:1.5;color:#5b6372;margin:0">${esc(footer)}</p>
</div></body></html>`,
  };
}
