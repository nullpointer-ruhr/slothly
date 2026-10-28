# Datenmodell

Ziel für den Start: so wenig Tabellen wie möglich, aber die Plan-Vorlage relational, damit
Dirk und Mella je einen eigenen Plan haben, sich aber die Übungsbibliothek teilen.

```
users ─┬─ sessions, login_tokens
       └─ plans ─┬─ schemes            Wochenschema je Code (SH, LEG, REHA, ...)
                 ├─ plan_days ── plan_slots ──> exercises   (gemeinsame Bibliothek)
                 └─ workout_logs       eine Einheit = Woche × Tag, JSON
```

## Plan-Vorlage

| Tabelle | Inhalt |
|---|---|
| `exercises` | Übung mit Name, Hauptmuskel, Video-Suchbegriff. Eindeutig über den Namen, beide Pläne nutzen dieselben Zeilen. |
| `plans` | Ein Zyklus eines Nutzers: Name, Startdatum, Wochenzahl, Wochenbezeichnungen, Topsatz-Woche, Regeltext, ausgefallene Termine. Pro Nutzer ist genau ein Plan aktiv. |
| `schemes` | Sätze und Ziel-RPE je Woche, z. B. `SH = [[3,"7"],[4,"7"],[4,"7"],[4,"7–8"],[3,"8"],[2,"6"]]`. Mehrere Übungen teilen sich ein Schema. |
| `plan_days` | Tag 1–3 mit Wochentag (0 = Mo), Aufwärmen, Skill, Cool-down, Hinweisen, Blocknamen. |
| `plan_slots` | Position im Tag: Label (`A`, `A+`, `B1` …), Übung, Kadenz, Startgewicht, Pause, Schema, Darstellung (`standard`, `per_pause`, `circuit`, `rounds`), Wdh.-Bereich, Seite, Aufwärmsätze, Topsatz, Deckel-Hinweis. |

Ein neuer Zyklus ist ein neuer Plan (Import, dann aktiv). Alte Pläne und ihre Logs bleiben
unverändert, damit Verläufe über Zyklen hinweg stimmen.

## Trainingsdaten

`workout_logs` speichert je Einheit genau das JSON, das die Oberfläche schreibt
(`ex.<Label>.sets[] = {kg, r, rpe, d}`, Aufwärmhaken, Notizen, Feedback). Das hält Oberfläche
und Backend einfach und macht Offline-Betrieb trivial (ein Dokument, neuere Fassung gewinnt).

Ausgewertet wird trotzdem per SQL über die View `set_logs` (ein Satz pro Zeile):

```sql
SELECT week, set_nr, kg::numeric, reps, rpe
  FROM set_logs
 WHERE email = 'dirk@…' AND exercise = 'Hip Thrust, Langhantel'
 ORDER BY week, set_nr;
```

## Später (wenn Bedarf da ist)

- `set_logs` als echte Tabelle statt View, sobald Auswertungen langsam werden oder die
  Regel-Engine (Progression, RPE-Korrektur) Vorschläge rechnen soll.
- `regions`, `region_load`, `clearances` aus dem Planungsdokument, wenn Schulter-Deckel und
  Freigaben als Daten statt als Text geprüft werden sollen.
- Plan-Editor in der Oberfläche zusätzlich zum Datei-Upload.

## Austauschformat

`slothly-plan/2` (siehe `seed/vorlage.json`): lesbare deutsche Feldnamen, Wochentage als
`Mo` … `So`, Schemata als `{saetze, rpe}` je Woche, Anleitung im Feld `_anleitung`. Gedacht
zum Ausfüllen von Hand oder durch einen KI-Assistenten. `src/planfile.ts` wandelt es in die
interne Form um und prüft es vollständig (alle Fehler auf einmal, dazu Hinweise).

Hochladen legt immer einen neuen Plan an und aktiviert ihn; der alte bleibt mit seinen Logs.
Der Export (`/api/export` bzw. `cli.ts export`) liefert Pläne im selben Format plus Logs,
damit lässt sich ein Konto auf einen anderen Host umziehen, auch ohne Datenbank-Dump.
