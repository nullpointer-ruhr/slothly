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

export function loginMail(to: string, name: string, link: string, minutes: number): Mail {
  const p = [
    `Hallo ${name},`,
    `über den Knopf meldest du dich bei Slothly an. Der Link ist ${minutes} Minuten gültig und funktioniert genau einmal.`,
  ];
  const footer = 'Falls du keine Anmeldung angefordert hast, ignoriere diese Mail einfach.';
  return {
    to, subject: 'Anmelden bei Slothly',
    text: `${p.join('\n\n')}\n\n${link}\n\n${footer}\n`,
    html: `<!doctype html><html lang="de"><body style="margin:0;background:#eef0f4;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#15181e">
<div style="max-width:480px;margin:32px auto;background:#fff;border:1px solid #dce0e8;border-radius:12px;padding:28px">
${p.map(x => `<p style="font-size:15px;line-height:1.5;margin:0 0 14px">${esc(x)}</p>`).join('\n')}
<p style="margin:22px 0"><a href="${esc(link)}" style="display:inline-block;background:#1f4fd1;color:#fff;text-decoration:none;padding:12px 20px;border-radius:9px;font-weight:600">Anmelden</a></p>
<p style="font-size:13px;line-height:1.5;color:#5b6372;margin:0">${esc(footer)}</p>
</div></body></html>`,
  };
}
