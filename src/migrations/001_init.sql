-- Slothly: Grundschema.
-- Drei Teile: Konten (users, sessions, login_tokens), Plan-Vorlage
-- (exercises, plans, plan_days, plan_slots, schemes) und Trainingsdaten (workout_logs).
-- Die Vorlage wird einmal importiert und danach nicht mehr verändert, die Logs
-- verweisen nur über Woche, Tag und Block-Label darauf. So bleibt die Historie stimmig,
-- auch wenn ein späterer Zyklus andere Übungen hat (neuer Plan statt Änderung).

-- ---------- Konten ----------

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE CHECK (email = lower(email)),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

-- Einmal-Links für die Anmeldung per Mail. Gespeichert wird nur der SHA-256 des Tokens.
CREATE TABLE login_tokens (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX login_tokens_user ON login_tokens (user_id);

-- Sessions: im Cookie steht ein Zufallstoken, hier nur dessen SHA-256.
CREATE TABLE sessions (
  id_hash      bytea PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text
);
CREATE INDEX sessions_user ON sessions (user_id);

-- ---------- Übungsbibliothek (gemeinsam für alle Nutzer) ----------

CREATE TABLE exercises (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,          -- so wie er im Plan steht, z. B. "Hip Thrust, Langhantel"
  muscle      text,                          -- Hauptmuskel
  video_query text,                          -- Suchbegriff für den Video-Link (englisch findet mehr)
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Plan-Vorlage (je Nutzer) ----------

CREATE TABLE plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,                -- "Zyklus 1"
  subtitle     text,                         -- "Hypertrophie 8–12"
  start_date   date NOT NULL,                -- Montag der ersten Woche
  weeks        int  NOT NULL CHECK (weeks BETWEEN 1 AND 26),
  week_labels  jsonb NOT NULL DEFAULT '[]',  -- ["Einstieg", "Volumen", ...]
  topset_week  int,                          -- Woche mit Topsatz-Test (null = keiner)
  intro        text,                         -- Einleitung im Regel-Reiter
  day_note     text,                         -- Hinweis unter jeder Tagesüberschrift
  rules        jsonb NOT NULL DEFAULT '[]',  -- Abschnitte {title, p[], ul[], table{head,rows}}
  -- Übersprungene Termine (Reha, Krankheit): die folgenden Einheiten rücken nach.
  skip_dates   jsonb NOT NULL DEFAULT '[]',
  skips_updated_at bigint NOT NULL DEFAULT 0,  -- Client-Zeitstempel (ms) für Konflikte
  active       boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX plans_one_active ON plans (user_id) WHERE active;

-- Wochenschema: je Woche Anzahl Sätze und Ziel-RPE, z. B. SH = [[3,"7"],[4,"7"],...].
-- Mehrere Übungen teilen sich ein Schema (Schulter, Beine, Reha, ...).
CREATE TABLE schemes (
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  code    text NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,16}$'),
  weeks   jsonb NOT NULL,                     -- [[saetze, rpe|null], ...] Länge = plans.weeks
  PRIMARY KEY (plan_id, code)
);

CREATE TABLE plan_days (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id  uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  idx      int  NOT NULL,                     -- 0, 1, 2 = Tag 1, 2, 3
  title    text NOT NULL,                     -- "Oberkörper"
  weekday_offset int NOT NULL CHECK (weekday_offset BETWEEN 0 AND 6),  -- 0 = Mo, 2 = Mi, 4 = Fr
  warmup   jsonb NOT NULL DEFAULT '[]',       -- Abhak-Liste
  skill    text,
  cooldown text,
  notes    jsonb NOT NULL DEFAULT '[]',
  group_labels jsonb NOT NULL DEFAULT '{}',   -- {"A": "Block A · Hauptübung", ...}
  UNIQUE (plan_id, idx)
);

-- Eine Position im Tag: Block-Label (A, B1, ...), Übung und Vorgaben.
CREATE TABLE plan_slots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id       uuid NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
  position     int  NOT NULL,
  label        text NOT NULL,                 -- "A", "A+", "B1", ... Schlüssel in den Logs
  exercise_id  uuid NOT NULL REFERENCES exercises(id),
  cadence      text,                          -- "3-1-X-0"
  info         text,                          -- Belastung, z. B. "indirekt: Schulter li"
  start_weight text,                          -- "2×20 kg", "Band mittel"
  pause        text,                          -- "2–3 min", "direkt zu B2"
  scheme_code  text NOT NULL,
  format       text NOT NULL CHECK (format IN ('standard', 'per_pause', 'circuit', 'rounds')),
  reps         text,                          -- "8–12", "15", "6 je Seite", "Y, T, W je 6"
  side         text,                          -- "je Seite"
  warmup_sets  boolean NOT NULL DEFAULT false,  -- Aufwärmsätze 10 / 50 % / 75 %
  topset       boolean NOT NULL DEFAULT false,  -- Topsatz in plans.topset_week
  cap_label    text,                          -- z. B. "Schulter-Deckel"
  UNIQUE (day_id, label),
  UNIQUE (day_id, position)
);
-- Dass scheme_code im Plan existiert, prüft der Import (ein FK bräuchte plan_id in plan_slots).

-- ---------- Trainingsdaten ----------

-- Eine durchgeführte Einheit (Woche × Tag) als JSON-Dokument, genau so, wie die
-- Oberfläche es schreibt: {warm[], skill, cool, ex: {"A": {sets: [{kg, r, rpe, d}], wu[], note}}, fb{...}}.
-- Einfach für den Anfang; die View set_logs macht die Sätze trotzdem per SQL auswertbar.
CREATE TABLE workout_logs (
  plan_id    uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  week       int  NOT NULL CHECK (week >= 1),
  day_idx    int  NOT NULL CHECK (day_idx >= 0),
  data       jsonb NOT NULL,
  updated_at bigint NOT NULL,                 -- Client-Zeitstempel (ms): neuere Version gewinnt
  saved_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, week, day_idx)
);

-- Alle Arbeitssätze flach, z. B. für Verläufe je Übung:
--   SELECT exercise, week, set_nr, kg, reps, rpe FROM set_logs WHERE email = '...' ORDER BY week, set_nr;
CREATE VIEW set_logs AS
SELECT u.email, p.name AS plan, w.week, d.idx + 1 AS day, d.title AS day_title,
       s.label, e.name AS exercise,
       sl.ord::int AS set_nr,
       nullif(replace(sl.v->>'kg', ',', '.'), '') AS kg,
       nullif(sl.v->>'r', '') AS reps,
       nullif(replace(sl.v->>'rpe', ',', '.'), '') AS rpe,
       coalesce((sl.v->>'d')::boolean, false) AS done
  FROM workout_logs w
  JOIN plans p      ON p.id = w.plan_id
  JOIN users u      ON u.id = p.user_id
  JOIN plan_days d  ON d.plan_id = p.id AND d.idx = w.day_idx
  JOIN plan_slots s ON s.day_id = d.id
  JOIN exercises e  ON e.id = s.exercise_id
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(w.data->'ex'->s.label->'sets', '[]')) WITH ORDINALITY AS sl(v, ord)
 WHERE jsonb_typeof(sl.v) = 'object';
