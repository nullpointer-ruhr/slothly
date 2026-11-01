-- #4: Uhr je Block (AMRAP, EMOM, For Time, Intervall), z. B. {"C": {"kind": "amrap", "min": 12}}.
-- Das Ergebnis steht im Log der Einheit unter data.clocks.<Block>.
ALTER TABLE plan_days ADD COLUMN group_clocks jsonb;
