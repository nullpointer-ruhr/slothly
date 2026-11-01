// Aus den Texten eines Plans abgeleitete Angaben, damit auch Pläne ohne die neuen Felder
// richtig dargestellt werden: Pausenlänge (#7), Erfassungsart und Gewichtsbezug (#10),
// Skill-Block pro Woche (#5). Explizite Angaben im Plan haben immer Vorrang.

export type Field = 'gewicht' | 'wdh' | 'zeit' | 'band';
export type TimeMode = 'halten' | 'in_zeit' | 'auf_zeit';
export type WeightRef = 'gesamt' | 'je_hand' | 'je_seite';
export const FIELDS: Field[] = ['gewicht', 'wdh', 'zeit', 'band'];
export const TIME_MODES: TimeMode[] = ['halten', 'in_zeit', 'auf_zeit'];
export const WEIGHT_REFS: WeightRef[] = ['gesamt', 'je_hand', 'je_seite'];

/** Pause in Sekunden aus Texten wie „90 s“, „2 min“, „1:30“, „2–3 min“ (oberer Wert). 0 = keine Pause. */
export function parsePause(text: string | null | undefined): number {
  if (!text) return 0;
  const t = text.toLowerCase().replace(/,/g, '.');
  if (/direkt|in (der |a-)?pause|^\s*[-–]\s*$/.test(t)) return 0;
  let m = t.match(/(\d+):(\d{2})/);
  if (m) return +m[1] * 60 + +m[2];
  m = t.match(/(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)\s*min/);
  if (m) return Math.round(+m[2] * 60);
  m = t.match(/(\d+(?:\.\d+)?)\s*min/);
  if (m) return Math.round(+m[1] * 60);
  m = t.match(/(\d+)\s*[–-]\s*(\d+)\s*s\b/);
  if (m) return +m[2];
  m = t.match(/(\d+)\s*s\b/);
  if (m) return +m[1];
  return 0;
}

/** Sekunden aus „20 s“, „30–45 s halten“ (oberer Wert), „0:35“, „1 min“; null wenn keine Zeit. */
export function parseSeconds(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.toLowerCase().replace(/,/g, '.');
  let m = t.match(/(\d+):(\d{2})/);
  if (m) return +m[1] * 60 + +m[2];
  m = t.match(/(\d+)\s*[–-]\s*(\d+)\s*s\b/);
  if (m) return +m[2];
  m = t.match(/(\d+)\s*s\b/);
  if (m) return +m[1];
  m = t.match(/(\d+(?:\.\d+)?)\s*min/);
  if (m) return Math.round(+m[1] * 60);
  return null;
}

interface SlotLike { fields?: unknown; tmode?: unknown; wref?: unknown; format?: string; r?: string | null; st?: string | null }

const hasKg = (s: string) => /\d\s*kg\b/i.test(s) && !/^\s*KG\s*$/.test(s);

/** Welche Werte pro Satz erfasst werden, plus Zeitmodus und Gewichtsbezug. */
export function deriveCapture(s: SlotLike): { fields: Field[]; tmode: TimeMode | null; wref: WeightRef | null } {
  const reps = String(s.r ?? ''), start = String(s.st ?? '');
  let fields: Field[] | null = Array.isArray(s.fields) && s.fields.length && s.fields.every(f => FIELDS.includes(f)) ? [...new Set(s.fields as Field[])] : null;
  let tmode: TimeMode | null = TIME_MODES.includes(s.tmode as TimeMode) ? (s.tmode as TimeMode) : null;
  if (!fields) {
    const inTime = /\bin\s*\d+\s*(s|sek|min)\b/i.test(reps);
    const forTime = /auf\s+zeit/i.test(reps);
    const isTime = !inTime && !forTime && (/\d\s*(s|sek)\b|\d\s*min\b|halten/i.test(reps));
    const band = /\bband\b/i.test(start);
    const bodyweight = /^\s*(KG|Körpergewicht)\s*$/i.test(start);
    if (s.format === 'tabata') fields = hasKg(start) ? ['wdh', 'gewicht'] : ['wdh'];
    else if (inTime) { fields = hasKg(start) ? ['gewicht', 'wdh'] : ['wdh']; tmode ??= 'in_zeit'; }
    else if (forTime) { fields = hasKg(start) ? ['gewicht', 'zeit'] : ['zeit']; tmode ??= 'auf_zeit'; }
    else if (isTime) { fields = hasKg(start) ? ['zeit', 'gewicht'] : ['zeit']; tmode ??= 'halten'; }
    else if (band) fields = ['band', 'wdh'];
    else if (bodyweight) fields = ['wdh'];
    else fields = ['gewicht', 'wdh'];
  }
  // Zeitmodus nur, wo eine Uhr gebraucht wird: Zeit wird erfasst, oder Wdh. in fester Zeit.
  if (fields.includes('zeit')) tmode ??= 'halten';
  else if (tmode !== 'in_zeit') tmode = null;
  let wref: WeightRef | null = WEIGHT_REFS.includes(s.wref as WeightRef) ? (s.wref as WeightRef) : null;
  if (fields.includes('gewicht')) wref ??= /^\s*2\s*[×x]/.test(start) ? 'je_hand' : 'gesamt';
  else wref = null;
  return { fields, tmode, wref };
}

// ---------- Skill-Block (#5) ----------

export interface SkillItem { n: string; v: string | null; q: string | null }
export interface SkillBlock { title: string; dur: string | null; hint: string | null; weeks: SkillItem[][] }

/** Ein Element wie „Wall Walk bis ca. 45°: 3×1, 5 s halten“ oder „Hollow Body Hold 3×15 s“ in Name und Vorgabe teilen. */
export function splitSkillItem(text: string): SkillItem {
  const t = text.trim().replace(/[.;]\s*$/, '');
  const c = t.indexOf(': ');
  if (c > 0) return { n: t.slice(0, c).trim(), v: t.slice(c + 2).trim() || null, q: null };
  const m = t.match(/\s(\d+\s*[×x]\s*\d|\d+\s*(?:s|sek|min|Wdh)\b)/);
  if (m && m.index! > 0) return { n: t.slice(0, m.index).trim().replace(/,$/, ''), v: t.slice(m.index! + 1).trim(), q: null };
  return { n: t, v: null, q: null };
}

/**
 * Altes Format: Skill als Fließtext. Abschnitte „W1: … W2: …“ werden zu Wochen,
 * „ · “ trennt die Elemente; ein Vorspann wie „Handstand (6 min, solange …).“ wird Titel, Dauer, Hinweis.
 */
export function parseSkillText(text: string | null | undefined, weeks: number): SkillBlock | null {
  if (!text || !text.trim()) return null;
  const parts = text.split(/\bW(\d{1,2})\s*:\s*/);
  let prefix = parts[0].trim(), title = 'Skill', dur: string | null = null, hint: string | null = null;
  const byWeek = new Map<number, string>();
  if (parts.length > 2) for (let i = 1; i < parts.length; i += 2) byWeek.set(+parts[i], parts[i + 1] ?? '');
  else { byWeek.set(0, prefix); prefix = ''; }
  if (prefix) {
    const m = prefix.match(/^([^(.:]+?)\s*(?:\(([^)]*)\))?[.:]?\s*$/);
    if (m) {
      title = m[1].trim() || title;
      for (const piece of (m[2] ?? '').split(',').map(x => x.trim()).filter(Boolean)) {
        if (!dur && /^\d+\s*(min|s)\b/.test(piece)) dur = piece; else hint = hint ? hint + ', ' + piece : piece;
      }
    } else hint = prefix;
  }
  const items = (s: string) => s.split(/\s+·\s+/).map(x => x.trim()).filter(Boolean).map(splitSkillItem);
  const out: SkillItem[][] = [];
  let last: SkillItem[] = byWeek.has(0) ? items(byWeek.get(0)!) : [];
  for (let w = 1; w <= weeks; w++) { if (byWeek.has(w)) last = items(byWeek.get(w)!); out.push(last); }
  return { title, dur, hint, weeks: out };
}

/** Neues Format aus der Plandatei normalisieren: eine Liste pro Woche (oder eine für alle Wochen). */
export function normalizeSkillBlock(raw: unknown, weeks: number): SkillBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { titel?: string; dauer?: string; hinweis?: string; wochen?: unknown[]; uebungen?: unknown[] };
  const item = (x: unknown): SkillItem => {
    if (typeof x === 'string') return splitSkillItem(x);
    const i = (x ?? {}) as { name?: string; vorgabe?: string; video?: string };
    return { n: String(i.name ?? ''), v: i.vorgabe ? String(i.vorgabe) : null, q: i.video ? String(i.video) : null };
  };
  let list: SkillItem[][];
  if (Array.isArray(o.wochen) && o.wochen.length) list = o.wochen.map(w => (Array.isArray(w) ? w.map(item) : []));
  else if (Array.isArray(o.uebungen)) list = [o.uebungen.map(item)];
  else return null;
  const out: SkillItem[][] = [];
  for (let w = 0; w < weeks; w++) out.push(list[Math.min(w, list.length - 1)]);
  return { title: String(o.titel ?? 'Skill'), dur: o.dauer ? String(o.dauer) : null, hint: o.hinweis ? String(o.hinweis) : null, weeks: out };
}
