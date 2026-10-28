-- 6-stelliger Code zusätzlich zum Link: Auf dem iPhone hat die Home-Bildschirm-App einen
-- eigenen Cookie-Speicher, ein Link aus der Mail meldet nur Safari an. Den Code tippt man
-- direkt in der App ein. Gespeichert wird nur der Hash, Fehlversuche werden gezählt.
ALTER TABLE login_tokens ADD COLUMN code_hash bytea;
ALTER TABLE login_tokens ADD COLUMN attempts int NOT NULL DEFAULT 0;
CREATE INDEX login_tokens_user_created ON login_tokens (user_id, created_at DESC);
