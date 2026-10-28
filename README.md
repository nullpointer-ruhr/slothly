# Slothly

Trainingsplan und Logger fürs Krafttraining, gebaut aus dem Zyklus-1-Plan. Läuft am Handy
als Web-App: Satz für Satz abhaken, Pausentimer, Feedback, Termine verschieben. Ein Konto
pro Person, jedes mit eigenem Plan; die Übungsbibliothek ist gemeinsam.

Betrieb: [nullpointer-ruhr/slothly-deploy](https://github.com/nullpointer-ruhr/slothly-deploy) (privat).

## Aufbau

```
src/          Backend (Node 24 führt TypeScript direkt aus, kein Build)
  main.ts       Start: Migrationen, Server
  auth.ts       Anmeldung per Mail-Link, Sessions
  plans.ts      Plan-Import, Plan- und Log-API, Export
  cli.ts        Konten, Plan-Import, Export
  migrations/   SQL, läuft beim Start automatisch
web/          Oberfläche (je eine HTML-Datei, strikte CSP)
seed/         Plan-Vorlage mit Anleitung (Download in der App)
docs/         Datenmodell
```

Stack wie Taktbuch: Fastify, `pg`, nodemailer, PostgreSQL 16. Konfiguration nur über
Umgebungsvariablen, damit das Image auf jedem Host gleich läuft.

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `DATABASE_URL` | ja | `postgres://user:pass@host:5432/slothly` |
| `PUBLIC_ORIGIN` | ja | z. B. `https://slothly.taktbuch.de` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | nein | Mailversand (oder `SMTP_URL`). Ohne: Anmelde-Links nur per CLI |
| `MAIL_FROM` | nein | Standard `Slothly <noreply@taktbuch.de>` |
| `SESSION_DAYS` | nein | Standard 180, verlängert sich bei Nutzung |

## Anmeldung

Keine Passwörter. Adresse eingeben, „Code schicken“, den 6-stelligen Code aus der Mail
(steht im Betreff) eintippen. So landet die Anmeldung genau in der App, in der man ihn
eintippt, auch in der iPhone-App auf dem Home-Bildschirm (die hat einen eigenen
Cookie-Speicher, getrennt von Safari). Der Link in derselben Mail meldet dagegen den
Browser an, in dem er sich öffnet.

Code und Link gelten 20 Minuten und einmal, nur der zuletzt angeforderte Code zählt,
höchstens 5 Fehlversuche pro Code und 5 Codes pro Konto und Stunde. Die Anmeldung gilt
danach 180 Tage pro Gerät und verlängert sich bei Nutzung. Konten legt nur die
Kommandozeile an, es gibt keine Registrierung.

## Pläne

Jede Person verwaltet ihre Pläne selbst unter **Regeln → Pläne**:

1. *Vorlage herunterladen* (oder *Aktuellen Plan herunterladen* als Grundlage für den nächsten Zyklus).
2. Ausfüllen: am einfachsten die Datei zusammen mit dem eigenen Plan (PDF, Foto, Text) an Claude geben.
   Die Anleitung samt Formulierung steht im Feld `_anleitung` der Datei.
3. *Plan hochladen*: Die App prüft die Datei und zeigt alle Fehler auf einmal oder eine Vorschau.
   Erst *Übernehmen* speichert. Der bisherige Plan bleibt samt Einträgen erhalten und lässt sich
   unter *Pläne* wieder aktivieren.

Format: `slothly-plan/2` mit deutschen Feldnamen, siehe `seed/vorlage.json`. Dateien im alten
Format `slothly-plan/1` nimmt die CLI weiter an.

## Kommandozeile

```bash
node src/cli.ts add-user dirk@example.org Dirk
node src/cli.ts import-plan dirk@example.org plan.json      # wie Hochladen in der App; - für stdin
node src/cli.ts import-logs dirk@example.org logs.json
node src/cli.ts login-link dirk@example.org                 # ohne Mailversand
node src/cli.ts users
node src/cli.ts export dirk@example.org > dirk.json
```

Eigene Pläne enthalten Gesundheitsangaben und gehören nicht in dieses öffentliche Repo
(`plans/` ist ignoriert). Sie liegen im privaten Deploy-Repo.

## Lokal entwickeln (WSL)

```bash
docker run -d --name slothly-pg -e POSTGRES_USER=slothly -e POSTGRES_PASSWORD=slothly -p 5432:5432 postgres:16
npm install
export DATABASE_URL=postgres://slothly:slothly@localhost:5432/slothly PUBLIC_ORIGIN=http://localhost:8080
node src/cli.ts migrate && node src/cli.ts add-user ich@example.org Ich
node src/cli.ts import-plan ich@example.org seed/vorlage.json
npm start            # dann: node src/cli.ts login-link ich@example.org
```

Tests (leeren die angegebene Datenbank):

```bash
TEST_DATABASE_URL=postgres://slothly:slothly@localhost:5432/slothly_test npm test
```

Nicht im OneDrive-Ordner arbeiten: `node_modules` und Datenbank-Volumes gehören nach WSL.
