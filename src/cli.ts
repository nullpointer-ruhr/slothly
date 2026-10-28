// Verwaltung über die Kommandozeile. Im Cluster z. B.:
//   kubectl -n slothly exec deploy/slothly-app -- node src/cli.ts add-user dirk@example.org Dirk
//   kubectl -n slothly exec -i deploy/slothly-app -- node src/cli.ts import-plan dirk@example.org - < plan.json
import { readFile } from 'node:fs/promises';
import { createPool, migrate } from './db.ts';
import { createLoginLink, normEmail } from './auth.ts';
import { exportUser, importLogs, importPlan } from './plans.ts';

const HELP = `Befehle:
  migrate                                  Schema aktualisieren
  add-user <email> <name>                  Konto anlegen (Anmeldung dann per Mail-Link)
  disable-user <email>                     Konto sperren, alle Sessions beenden
  users                                    Konten auflisten
  login-link <email>                       Anmelde-Link ausgeben (ohne Mailversand)
  import-plan <email> <datei|->            Plan importieren und aktiv setzen
  import-logs <email> <datei|->            Trainingsdaten in den aktiven Plan übernehmen
  export <email>                           Alle Daten des Kontos als JSON auf stdout`;

const [cmd, ...args] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL fehlt'); process.exit(2); }
const db = createPool(url);

async function readJson(file: string | undefined) {
  if (!file) throw new Error('Datei fehlt (Pfad oder - für stdin)');
  if (file !== '-') return JSON.parse(await readFile(file, 'utf8'));
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

try {
  if (cmd === 'migrate') {
    const done = await migrate(db, m => console.log(m));
    if (!done.length) console.log('Schema ist aktuell.');
  } else if (cmd === 'add-user') {
    const [email, ...name] = args;
    if (!email || !name.length) throw new Error('add-user <email> <name>');
    await db.query(`INSERT INTO users (email, name) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, disabled_at = NULL`,
      [normEmail(email), name.join(' ')]);
    console.log(`Konto ${normEmail(email)} ist angelegt. Anmeldung über die Startseite per Mail-Link.`);
  } else if (cmd === 'disable-user') {
    const r = await db.query('UPDATE users SET disabled_at = now() WHERE email = $1 RETURNING id', [normEmail(args[0])]);
    if (!r.rows[0]) throw new Error('Kein solches Konto');
    await db.query('DELETE FROM sessions WHERE user_id = $1', [r.rows[0].id]);
    console.log('Gesperrt, alle Geräte abgemeldet.');
  } else if (cmd === 'users') {
    const r = await db.query(`SELECT u.email, u.name, u.disabled_at IS NOT NULL AS gesperrt, p.name AS plan
                                FROM users u LEFT JOIN plans p ON p.user_id = u.id AND p.active ORDER BY u.created_at`);
    console.table(r.rows);
  } else if (cmd === 'login-link') {
    const origin = process.env.PUBLIC_ORIGIN;
    if (!origin) throw new Error('PUBLIC_ORIGIN fehlt');
    const l = await createLoginLink(db, { publicOrigin: origin.replace(/\/$/, ''), loginLinkMinutes: 60 }, args[0] ?? '');
    if (!l) throw new Error('Kein aktives Konto mit dieser Adresse');
    console.log(`Gültig 60 Minuten, einmal verwendbar:\n${l.link}`);
  } else if (cmd === 'import-plan') {
    const id = await importPlan(db, args[0] ?? '', await readJson(args[1]), true);
    console.log(`Plan importiert und aktiv (${id}).`);
  } else if (cmd === 'import-logs') {
    const r = await db.query<{ id: string }>('SELECT p.id FROM plans p JOIN users u ON u.id = p.user_id WHERE u.email = $1 AND p.active', [normEmail(args[0])]);
    if (!r.rows[0]) throw new Error('Kein aktiver Plan für dieses Konto');
    const n = await importLogs(db, r.rows[0].id, await readJson(args[1]));
    console.log(`${n} Einheiten übernommen.`);
  } else if (cmd === 'export') {
    process.stdout.write(JSON.stringify(await exportUser(db, args[0] ?? ''), null, 2) + '\n');
  } else {
    console.log(HELP);
    process.exitCode = cmd ? 2 : 0;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
