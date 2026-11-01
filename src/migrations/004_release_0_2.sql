-- Release 0.2

-- #12 Training starten/beenden: Status und Zeiten je Einheit als eigene Spalten.
-- Die Oberfläche schreibt sie ins JSON (status, startedAt, finishedAt, durS, doneOn),
-- der Server übernimmt sie beim Speichern in die Spalten (offline-fähig, ein Dokument je Einheit).
ALTER TABLE workout_logs
  ADD COLUMN status      text NOT NULL DEFAULT 'offen' CHECK (status IN ('offen', 'laeuft', 'fertig', 'abgebrochen')),
  ADD COLUMN started_at  timestamptz,
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN duration_s  int CHECK (duration_s IS NULL OR duration_s >= 0),
  ADD COLUMN done_on     date;
-- Bestehende Einheiten mit Trainingsdatum gelten als fertig (ohne Uhrzeit).
UPDATE workout_logs SET status = 'fertig', done_on = (data->>'doneOn')::date
 WHERE data->>'doneOn' ~ '^\d{4}-\d{2}-\d{2}$';

-- #6 Einheit auf einen bestimmten Tag legen: {"w1d3": "2026-10-31"}, Zeitstempel für Konflikte.
ALTER TABLE plans
  ADD COLUMN moves            jsonb  NOT NULL DEFAULT '{}',
  ADD COLUMN moves_updated_at bigint NOT NULL DEFAULT 0;

-- #10 Erfassung je Übung, #7 Pause als Zahl, #11 Tabata.
ALTER TABLE plan_slots
  ADD COLUMN fields     jsonb,      -- ["gewicht","wdh"], ["zeit"], … (NULL = aus Texten ableiten)
  ADD COLUMN time_mode  text CHECK (time_mode IS NULL OR time_mode IN ('halten', 'in_zeit', 'auf_zeit')),
  ADD COLUMN weight_ref text CHECK (weight_ref IS NULL OR weight_ref IN ('gesamt', 'je_hand', 'je_seite')),
  ADD COLUMN pause_s    int  CHECK (pause_s IS NULL OR pause_s BETWEEN 0 AND 3600),
  ADD COLUMN tabata     jsonb;
ALTER TABLE plan_slots DROP CONSTRAINT plan_slots_format_check;
ALTER TABLE plan_slots ADD CONSTRAINT plan_slots_format_check CHECK (format IN ('standard', 'per_pause', 'circuit', 'rounds', 'tabata'));

-- #5 Skill-Block strukturiert ({title, dur, hint, weeks: [[{n, v, q}]]}); der alte Text bleibt als Rückfall.
ALTER TABLE plan_days ADD COLUMN skill_block jsonb;

-- #3 Rollen und Verwaltung.
ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'));
ALTER TABLE login_tokens ADD COLUMN mail_status text CHECK (mail_status IS NULL OR mail_status IN ('gesendet', 'fehler', 'admin'));
CREATE TABLE admin_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  admin_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  target_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action    text NOT NULL,
  detail    jsonb
);
CREATE INDEX admin_log_at ON admin_log (at DESC);

-- Auswertung: neue Spalten hinten anhängen (CREATE OR REPLACE VIEW erlaubt nur das).
CREATE OR REPLACE VIEW set_logs AS
SELECT u.email, p.name AS plan, w.week, d.idx + 1 AS day, d.title AS day_title,
       s.label, e.name AS exercise,
       sl.ord::int AS set_nr,
       nullif(replace(sl.v->>'kg', ',', '.'), '') AS kg,
       nullif(sl.v->>'r', '') AS reps,
       nullif(replace(sl.v->>'rpe', ',', '.'), '') AS rpe,
       coalesce((sl.v->>'d')::boolean, false) AS done,
       CASE WHEN sl.v->>'t' ~ '^\d+(\.\d+)?$' THEN (sl.v->>'t')::numeric
            WHEN sl.v->>'r' ~ '^\s*\d+\s*s\y' THEN substring(sl.v->>'r' FROM '^\s*(\d+)')::numeric END AS seconds,
       nullif(sl.v->>'band', '') AS band,
       w.status, w.started_at, w.finished_at, w.done_on,
       CASE WHEN sl.v->>'at' ~ '^\d+$' THEN to_timestamp((sl.v->>'at')::bigint / 1000.0) END AS done_at,
       CASE WHEN replace(sl.v->>'kg', ',', '.') !~ '^\d+(\.\d+)?$' THEN NULL
            WHEN s.weight_ref = 'je_hand' OR (s.weight_ref IS NULL AND s.start_weight ~ '^\s*2\s*[×x]')
            THEN 2 * replace(sl.v->>'kg', ',', '.')::numeric
            ELSE replace(sl.v->>'kg', ',', '.')::numeric END AS kg_total
  FROM workout_logs w
  JOIN plans p      ON p.id = w.plan_id
  JOIN users u      ON u.id = p.user_id
  JOIN plan_days d  ON d.plan_id = p.id AND d.idx = w.day_idx
  JOIN plan_slots s ON s.day_id = d.id
  JOIN exercises e  ON e.id = s.exercise_id
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(w.data->'ex'->s.label->'sets', '[]')) WITH ORDINALITY AS sl(v, ord)
 WHERE jsonb_typeof(sl.v) = 'object';
