-- Zähler, der beim Neustart eines Zyklus hochgeht. Geräte mit Einträgen aus der Zeit davor
-- (im Browser-Speicher) erkennen daran, dass ihr Stand verworfen ist, und laden neu,
-- statt alte Sätze wieder hochzuladen.
ALTER TABLE plans ADD COLUMN revision int NOT NULL DEFAULT 0;
