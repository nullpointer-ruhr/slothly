// Plan-Dateien: lesbares Austauschformat (slothly-plan/2, deutsche Feldnamen, für Menschen und
// KI-Assistenten zum Ausfüllen) und die interne Form (kurze Schlüssel wie in der Oberfläche).
// Ältere Dateien im Format slothly-plan/1 werden weiter angenommen.

import { deriveCapture, normalizeSkillBlock, FIELDS, TIME_MODES, WEIGHT_REFS, type SkillBlock } from './derive.ts';

export type Format = 'standard' | 'per_pause' | 'circuit' | 'rounds' | 'tabata';
/** Tabata (#11): Arbeit/Pause in Sekunden, Runden je Satz, Sätze, Pause zwischen Sätzen, Übungen im Wechsel. */
export interface TabataCfg { work: number; rest: number; rounds: number; sets: number; setRest: number; ex: string[] }
/** #4: Uhr für einen Block. amrap: min = Gesamtzeit; fortime: min = Zeitlimit, rounds = Ziel; emom: every s × rounds; intervall: work/rest × rounds. */
export type ClockKind = 'amrap' | 'emom' | 'fortime' | 'intervall';
export interface ClockCfg { kind: ClockKind; min?: number; every?: number; rounds?: number; work?: number; rest?: number }
export const CLOCK_KINDS: ClockKind[] = ['amrap', 'emom', 'fortime', 'intervall'];
type ClockV2 = { art?: string; minuten?: number; alle_s?: number; runden?: number; arbeit_s?: number; pause_s?: number };

/** Interne Form: so liefert /api/plan den Plan an die Oberfläche. */
export interface PlanSlot {
  b: string; n: string; m?: string | null; q?: string | null; k?: string | null; i?: string | null;
  st?: string | null; pa?: string | null; scheme: string; format: Format;
  r?: string | null; side?: string | null; wu?: boolean; top?: boolean; cap?: string | null;
  /** #10: erfasste Werte, Zeitmodus, Gewichtsbezug (null = aus Texten ableiten). */
  fields?: string[] | null; tmode?: string | null; wref?: string | null;
  /** #7: Pause in Sekunden (null = aus dem Pausentext ableiten). */
  ps?: number | null;
  tabata?: TabataCfg | null;
}
export interface PlanDay {
  title: string; offset: number; warm?: string[]; skill?: string | null; cool?: string | null;
  /** #5: strukturierter Skill-Block; ohne ihn wird `skill` (Text) beim Laden zerlegt. */
  skillBlock?: SkillBlock | null;
  notes?: string[]; groups?: Record<string, string>;
  /** #4: Uhr je Block (Buchstabe → Uhr). */
  clocks?: Record<string, ClockCfg>;
  ex: PlanSlot[];
}
export interface RuleSection { title: string; p?: string[]; ul?: string[]; table?: { head: string[]; rows: string[][] } }
export interface PlanFile {
  format: 'slothly-plan/1'; name: string; subtitle?: string | null; startDate: string; weeks: number;
  weekLabels?: string[]; topsetWeek?: number | null; intro?: string | null; dayNote?: string | null;
  rules?: RuleSection[]; schemes: Record<string, [number, string | null][]>; days: PlanDay[];
}

/** Austauschformat v2. */
export interface PlanV2 {
  format: 'slothly-plan/2';
  _anleitung?: string[];
  name: string; untertitel?: string | null; start: string; wochen: number;
  wochenNamen?: string[]; topsatzWoche?: number | null; einleitung?: string | null; tagesHinweis?: string | null;
  schemata: Record<string, { saetze: number; rpe?: string | null }[]>;
  regeln?: { titel: string; absaetze?: string[]; liste?: string[]; tabelle?: { kopf: string[]; zeilen: string[][] } }[];
  tage: {
    titel: string; wochentag: string; aufwaermen?: string[]; cooldown?: string | null;
    skill?: string | { titel?: string; dauer?: string; hinweis?: string; wochen?: unknown[]; uebungen?: unknown[] } | null;
    hinweise?: string[]; bloecke?: Record<string, string | { titel?: string; uhr?: ClockV2 }>;
    uebungen: {
      block: string; name: string; muskel?: string | null; video?: string | null; kadenz?: string | null; info?: string | null;
      start?: string | null; pause?: string | null; schema: string; darstellung?: string; wdh?: string | null; seite?: string | null;
      aufwaermsaetze?: boolean; topsatz?: boolean; deckel?: string | null;
      erfassung?: string[]; zeitmodus?: string; gewicht?: string; pause_s?: number;
      tabata?: { arbeit_s?: number; pause_s?: number; runden?: number; saetze?: number; satzpause_s?: number; uebungen?: string[] };
    }[];
  }[];
}

const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const DARST: Record<string, Format> = { saetze: 'standard', pausenfueller: 'per_pause', zirkel: 'circuit', runden: 'rounds', tabata: 'tabata' };
const DARST_REV: Record<Format, string> = { standard: 'saetze', per_pause: 'pausenfueller', circuit: 'zirkel', rounds: 'runden', tabata: 'tabata' };

export const LIMITS = { weeks: 26, days: 7, exercises: 40, text: 500 };

const str = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));
const strs = (v: unknown) => (Array.isArray(v) ? v.map(x => String(x)) : []);
const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));

/** bloecke: Wert ist der Titel oder {titel, uhr}. */
function blocksFromV2(raw: unknown, T: string, errors: string[]) {
  const groups: Record<string, string> = {}, clocks: Record<string, ClockCfg> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { groups, clocks };
  for (const [L, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') { groups[L] = v; continue; }
    const o = (v ?? {}) as { titel?: unknown; uhr?: ClockV2 };
    if (o.titel != null) groups[L] = String(o.titel);
    if (o.uhr) {
      const u = o.uhr, kind = String(u.art ?? '') as ClockKind;
      if (!CLOCK_KINDS.includes(kind)) { errors.push(`${T}, Block ${L}: uhr.art muss ${CLOCK_KINDS.join(', ')} sein`); continue; }
      const c: ClockCfg = { kind };
      if (kind === 'amrap' || kind === 'fortime') c.min = num(u.minuten);
      if (kind === 'fortime' && u.runden != null) c.rounds = num(u.runden);
      if (kind === 'emom') { c.every = num(u.alle_s) ?? 60; c.rounds = num(u.runden); }
      if (kind === 'intervall') { c.work = num(u.arbeit_s); c.rest = num(u.pause_s) ?? 0; c.rounds = num(u.runden); }
      clocks[L] = c;
    }
  }
  return { groups, clocks };
}
function clockToV2(c: ClockCfg): ClockV2 {
  const u: ClockV2 = { art: c.kind };
  if (c.min != null) u.minuten = c.min;
  if (c.every != null) u.alle_s = c.every;
  if (c.work != null) u.arbeit_s = c.work;
  if (c.rest != null) u.pause_s = c.rest;
  if (c.rounds != null) u.runden = c.rounds;
  return u;
}
/** Kurzform für Anzeige und Vorschau, z. B. „AMRAP 12 min“, „EMOM 10 × 1 min“. */
export function clockLabel(c: ClockCfg): string {
  const t = (s: number) => (s % 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min` : `${s / 60} min`);
  if (c.kind === 'amrap') return `AMRAP ${c.min} min`;
  if (c.kind === 'fortime') return `For Time${c.rounds ? ` ${c.rounds} Runden` : ''}, max. ${c.min} min`;
  if (c.kind === 'emom') return c.every === 60 ? `EMOM ${c.rounds} min` : `E${c.every! % 60 ? c.every + 's' : c.every! / 60 + 'M'}OM ${c.rounds} × ${t(c.every!)}`;
  return `Intervall ${c.work}/${c.rest} s × ${c.rounds}`;
}

/** v2 → interne Form. Fehler bei der Umwandlung landen in errors (Prüfung folgt in checkPlan). */
function fromV2(f: PlanV2, errors: string[]): PlanFile {
  const schemes: PlanFile['schemes'] = {};
  for (const [code, weeks] of Object.entries(f.schemata ?? {})) {
    schemes[code] = Array.isArray(weeks) ? weeks.map(w => [Number(w?.saetze), str(w?.rpe)] as [number, string | null]) : (null as never);
  }
  return {
    format: 'slothly-plan/1', name: String(f.name ?? ''), subtitle: str(f.untertitel), startDate: String(f.start ?? ''),
    weeks: Number(f.wochen), weekLabels: strs(f.wochenNamen), topsetWeek: f.topsatzWoche ?? null,
    intro: str(f.einleitung), dayNote: str(f.tagesHinweis),
    rules: (f.regeln ?? []).map(r => ({ title: String(r?.titel ?? ''), p: strs(r?.absaetze), ul: strs(r?.liste),
      table: r?.tabelle ? { head: strs(r.tabelle.kopf), rows: (r.tabelle.zeilen ?? []).map(strs) } : undefined })),
    schemes,
    days: (Array.isArray(f.tage) ? f.tage : []).map((t, di) => {
      const off = WD.indexOf(String(t?.wochentag ?? '').slice(0, 2));
      const bl = blocksFromV2(t?.bloecke, `Tag ${di + 1}`, errors);
      if (off < 0) errors.push(`Tag ${di + 1}: wochentag muss Mo, Di, Mi, Do, Fr, Sa oder So sein`);
      return {
        title: String(t?.titel ?? ''), offset: off, warm: strs(t?.aufwaermen), cool: str(t?.cooldown),
        skill: typeof t?.skill === 'string' ? str(t.skill) : null,
        skillBlock: t?.skill && typeof t.skill === 'object' ? normalizeSkillBlock(t.skill, Number(f.wochen) || 1) : null,
        notes: strs(t?.hinweise), groups: bl.groups, clocks: bl.clocks,
        ex: (Array.isArray(t?.uebungen) ? t.uebungen : []).map(u => {
          const d = String(u?.darstellung ?? 'saetze');
          if (!DARST[d]) errors.push(`Tag ${di + 1}, ${u?.block}: darstellung muss saetze, pausenfueller, zirkel oder runden sein`);
          return {
            b: String(u?.block ?? ''), n: String(u?.name ?? ''), m: str(u?.muskel), q: str(u?.video), k: str(u?.kadenz), i: str(u?.info),
            st: str(u?.start), pa: str(u?.pause), scheme: String(u?.schema ?? ''), format: DARST[d] ?? 'standard',
            r: str(u?.wdh), side: str(u?.seite), wu: !!u?.aufwaermsaetze, top: !!u?.topsatz, cap: str(u?.deckel),
            fields: Array.isArray(u?.erfassung) ? u.erfassung.map(String) : null,
            tmode: str(u?.zeitmodus), wref: str(u?.gewicht),
            ps: u?.pause_s === undefined || u?.pause_s === null ? null : Number(u.pause_s),
            tabata: u?.tabata ? {
              work: Number(u.tabata.arbeit_s ?? 20), rest: Number(u.tabata.pause_s ?? 10), rounds: Number(u.tabata.runden ?? 8),
              sets: Number(u.tabata.saetze ?? 1), setRest: Number(u.tabata.satzpause_s ?? 60),
              ex: strs(u.tabata.uebungen).length ? strs(u.tabata.uebungen) : [String(u?.name ?? '')],
            } : null,
          };
        }),
      };
    }),
  };
}

/** Interne Form → v2 (Download des aktuellen Plans als Grundlage für den nächsten Zyklus). */
export function toV2(p: PlanFile): PlanV2 {
  const out: PlanV2 = {
    format: 'slothly-plan/2', name: p.name, untertitel: p.subtitle ?? null, start: p.startDate, wochen: p.weeks,
    wochenNamen: p.weekLabels ?? [], topsatzWoche: p.topsetWeek ?? null, einleitung: p.intro ?? null, tagesHinweis: p.dayNote ?? null,
    schemata: Object.fromEntries(Object.entries(p.schemes).map(([c, w]) => [c, w.map(([s, r]) => (r ? { saetze: s, rpe: r } : { saetze: s }))])),
    regeln: (p.rules ?? []).map(r => {
      const o: NonNullable<PlanV2['regeln']>[number] = { titel: r.title };
      if (r.table) o.tabelle = { kopf: r.table.head, zeilen: r.table.rows };
      if (r.p?.length) o.absaetze = r.p;
      if (r.ul?.length) o.liste = r.ul;
      return o;
    }),
    tage: p.days.map(d => ({
      titel: d.title, wochentag: WD[d.offset], aufwaermen: d.warm ?? [],
      skill: d.skillBlock ? { titel: d.skillBlock.title, ...(d.skillBlock.dur ? { dauer: d.skillBlock.dur } : {}), ...(d.skillBlock.hint ? { hinweis: d.skillBlock.hint } : {}),
        wochen: d.skillBlock.weeks.map(w => w.map(i => ({ name: i.n, ...(i.v ? { vorgabe: i.v } : {}), ...(i.q ? { video: i.q } : {}) }))) } : (d.skill ?? null),
      cooldown: d.cool ?? null,
      hinweise: d.notes ?? [],
      bloecke: Object.fromEntries([...new Set([...Object.keys(d.groups ?? {}), ...Object.keys(d.clocks ?? {})])].map(L =>
        [L, d.clocks?.[L] ? { titel: d.groups?.[L] ?? `Block ${L}`, uhr: clockToV2(d.clocks[L]) } : (d.groups?.[L] ?? `Block ${L}`)])),
      uebungen: d.ex.map(e => {
        const u: PlanV2['tage'][number]['uebungen'][number] = { block: e.b, name: e.n, muskel: e.m ?? null, video: e.q ?? null,
          kadenz: e.k ?? null, info: e.i ?? null, start: e.st ?? null, pause: e.pa ?? null, schema: e.scheme,
          darstellung: DARST_REV[e.format], wdh: e.r ?? null };
        if (e.side) u.seite = e.side;
        if (e.wu) u.aufwaermsaetze = true;
        if (e.top) u.topsatz = true;
        if (e.cap) u.deckel = e.cap;
        if (e.fields?.length) u.erfassung = e.fields;
        if (e.tmode) u.zeitmodus = e.tmode;
        if (e.wref) u.gewicht = e.wref;
        if (e.ps != null) u.pause_s = e.ps;
        if (e.tabata) u.tabata = { arbeit_s: e.tabata.work, pause_s: e.tabata.rest, runden: e.tabata.rounds, saetze: e.tabata.sets, satzpause_s: e.tabata.setRest, uebungen: e.tabata.ex };
        return u;
      }),
    })),
  };
  return out;
}

export interface ParseResult { plan: PlanFile | null; errors: string[]; warnings: string[] }

/** Nimmt eine hochgeladene Datei (v1 oder v2), wandelt sie um und prüft sie vollständig. */
export function parsePlanFile(raw: unknown): ParseResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { plan: null, errors: ['Die Datei ist kein Plan (JSON-Objekt erwartet).'], warnings: [] };
  const f = raw as { format?: string };
  let plan: PlanFile;
  if (f.format === 'slothly-plan/2') plan = fromV2(raw as PlanV2, errors);
  else if (f.format === 'slothly-plan/1') plan = raw as PlanFile;
  else return { plan: null, errors: ['Feld "format" muss "slothly-plan/2" sein. Bitte die Vorlage aus der App als Grundlage nehmen.'], warnings: [] };
  const r = checkPlan(plan);
  return { plan: errors.length || r.errors.length ? null : plan, errors: [...errors, ...r.errors], warnings: r.warnings };
}

/** Sammelt alle Fehler (statt beim ersten abzubrechen), damit man die Datei in einem Durchgang korrigieren kann. */
export function checkPlan(p: PlanFile): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  const e = (m: string) => { if (errors.length < 50) errors.push(m); };
  const long = (v: unknown, where: string) => { if (typeof v === 'string' && v.length > LIMITS.text) e(`${where}: Text länger als ${LIMITS.text} Zeichen`); };

  if (!p.name?.trim()) e('name fehlt');
  long(p.name, 'name'); long(p.subtitle, 'untertitel'); long(p.intro, 'einleitung');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.startDate ?? '') || isNaN(Date.parse(p.startDate))) e('start muss ein Datum wie 2026-12-07 sein');
  else if (new Date(p.startDate + 'T12:00:00Z').getUTCDay() !== 1) warnings.push('start ist kein Montag. Die Wochentage der Tage zählen ab diesem Datum.');
  if (!Number.isInteger(p.weeks) || p.weeks < 1 || p.weeks > LIMITS.weeks) e(`wochen muss eine ganze Zahl von 1 bis ${LIMITS.weeks} sein`);
  if (p.weekLabels?.length && p.weekLabels.length !== p.weeks) warnings.push(`wochenNamen hat ${p.weekLabels.length} Einträge, wochen ist ${p.weeks}`);
  if (p.topsetWeek != null && (!Number.isInteger(p.topsetWeek) || p.topsetWeek < 1 || p.topsetWeek > p.weeks)) e('topsatzWoche muss eine Woche des Plans sein oder null');

  const schemes = p.schemes ?? {};
  if (!Object.keys(schemes).length) e('schemata fehlt: mindestens ein Wochenschema angeben');
  for (const [code, w] of Object.entries(schemes)) {
    if (!/^[A-Z0-9_]{1,16}$/.test(code)) e(`Schema "${code}": Name nur aus Großbuchstaben, Ziffern und _ (z. B. HAUPT, REHA_1)`);
    if (!Array.isArray(w)) { e(`Schema ${code}: Liste mit einem Eintrag pro Woche erwartet`); continue; }
    if (w.length !== p.weeks) e(`Schema ${code}: hat ${w.length} Wochen, der Plan hat ${p.weeks}`);
    w.forEach((x, i) => { if (!Array.isArray(x) || !Number.isInteger(x[0]) || x[0] < 0 || x[0] > 20) e(`Schema ${code}, Woche ${i + 1}: saetze muss eine ganze Zahl von 0 bis 20 sein`); });
  }

  if (!Array.isArray(p.days) || !p.days.length) { e('tage fehlt: mindestens ein Trainingstag'); return { errors, warnings }; }
  if (p.days.length > LIMITS.days) e(`höchstens ${LIMITS.days} Tage pro Woche`);
  const offs = p.days.map(d => d.offset);
  if (new Set(offs).size !== offs.length) e('zwei Tage haben denselben wochentag');
  if (offs.some((o, i) => i > 0 && o < offs[i - 1])) e('tage bitte in Wochenreihenfolge angeben (z. B. Mo, Mi, Fr)');
  const used = new Set<string>();
  p.days.forEach((d, di) => {
    const T = `Tag ${di + 1}`;
    if (!d.title?.trim()) e(`${T}: titel fehlt`);
    if (!Number.isInteger(d.offset) || d.offset < 0 || d.offset > 6) e(`${T}: wochentag ungültig`);
    if (d.skillBlock) {
      if (d.skillBlock.weeks.some(w => !w.length || w.some(i => !i.n.trim()))) e(`${T}: skill braucht pro Woche mindestens ein Element mit name`);
    }
    if (!Array.isArray(d.ex) || !d.ex.length) { e(`${T}: uebungen fehlt`); return; }
    if (d.ex.length > LIMITS.exercises) e(`${T}: höchstens ${LIMITS.exercises} Übungen`);
    const seen = new Set<string>();
    d.ex.forEach((x, xi) => {
      const W = `${T}, Übung ${xi + 1}${x.b ? ` (${x.b})` : ''}`;
      if (!/^[A-Z][A-Z0-9+]{0,3}$/.test(x.b ?? '')) e(`${W}: block wie A, A+, B1, C2 (Großbuchstabe am Anfang, höchstens 4 Zeichen)`);
      else if (seen.has(x.b)) e(`${W}: block ${x.b} kommt an diesem Tag doppelt vor`);
      seen.add(x.b);
      if (!x.n?.trim()) e(`${W}: name fehlt`);
      for (const [k, v] of Object.entries({ name: x.n, info: x.i, start: x.st, pause: x.pa, wdh: x.r })) long(v, `${W}, ${k}`);
      if (!schemes[x.scheme]) e(`${W}: schema "${x.scheme}" ist unter schemata nicht definiert`);
      else used.add(x.scheme);
      if ((x.format === 'standard' || x.format === 'per_pause') && !x.r) warnings.push(`${W}: wdh fehlt`);
      if (x.fields != null && (!Array.isArray(x.fields) || !x.fields.length || !x.fields.every(f => (FIELDS as string[]).includes(f))))
        e(`${W}: erfassung ist eine Liste aus ${FIELDS.join(', ')}`);
      if (x.tmode != null && !(TIME_MODES as string[]).includes(x.tmode)) e(`${W}: zeitmodus muss ${TIME_MODES.join(', ')} sein`);
      if (x.wref != null && !(WEIGHT_REFS as string[]).includes(x.wref)) e(`${W}: gewicht muss ${WEIGHT_REFS.join(', ')} sein`);
      if (x.ps != null && (!Number.isInteger(x.ps) || x.ps < 0 || x.ps > 3600)) e(`${W}: pause_s muss eine ganze Zahl von 0 bis 3600 sein`);
      if (x.format === 'tabata') {
        const t = x.tabata;
        if (!t) e(`${W}: darstellung tabata braucht ein Feld tabata`);
        else {
          const rng = (v: number, a: number, b: number, n: string) => { if (!Number.isInteger(v) || v < a || v > b) e(`${W}: tabata.${n} muss ${a} bis ${b} sein`); };
          rng(t.work, 5, 600, 'arbeit_s'); rng(t.rest, 0, 600, 'pause_s'); rng(t.rounds, 1, 50, 'runden'); rng(t.sets, 1, 10, 'saetze'); rng(t.setRest, 0, 900, 'satzpause_s');
        }
      }
      if (x.top && p.topsetWeek == null) warnings.push(`${W}: topsatz gesetzt, aber keine topsatzWoche`);
      if (x.format === 'standard' && x.scheme in schemes && schemes[x.scheme].some(w => Array.isArray(w) && !w[1])) warnings.push(`${W}: Schema ${x.scheme} hat Wochen ohne rpe`);
    });
    const letters = new Set(d.ex.map(x => (x.b === 'A+' ? 'A' : x.b?.[0])));
    for (const [L, c] of Object.entries(d.clocks ?? {})) {
      const B = `${T}, Block ${L}`;
      if (!letters.has(L)) e(`${B}: uhr gesetzt, aber keine Übung in Block ${L}`);
      const rng = (v: number | undefined, a: number, b: number, n: string) => { if (!Number.isInteger(v) || v! < a || v! > b) e(`${B}: uhr.${n} muss ${a} bis ${b} sein`); };
      if (!CLOCK_KINDS.includes(c.kind)) e(`${B}: uhr.art muss ${CLOCK_KINDS.join(', ')} sein`);
      if (c.kind === 'amrap' || c.kind === 'fortime') rng(c.min, 1, 90, 'minuten');
      if (c.kind === 'fortime' && c.rounds != null) rng(c.rounds, 1, 100, 'runden');
      if (c.kind === 'emom') { rng(c.every, 10, 600, 'alle_s'); rng(c.rounds, 1, 90, 'runden'); }
      if (c.kind === 'intervall') { rng(c.work, 5, 600, 'arbeit_s'); rng(c.rest, 0, 600, 'pause_s'); rng(c.rounds, 1, 50, 'runden'); }
    }
    for (const L of letters) if (L && !d.groups?.[L]) warnings.push(`${T}: kein Name für Block ${L} unter bloecke (es wird "Block ${L}" angezeigt)`);
  });
  for (const code of Object.keys(schemes)) if (!used.has(code)) warnings.push(`Schema ${code} wird von keiner Übung benutzt`);
  return { errors, warnings: [...new Set(warnings)].slice(0, 30) };
}

/** Kurzübersicht für die Vorschau vor dem Übernehmen. */
export function summarize(p: PlanFile) {
  const s = new Date(p.startDate + 'T12:00:00Z');
  const end = new Date(s); end.setUTCDate(end.getUTCDate() + (p.weeks - 1) * 7 + Math.max(...p.days.map(d => d.offset)));
  const fmt = (d: Date) => d.toISOString().slice(0, 10).split('-').reverse().join('.');
  return {
    name: p.name, subtitle: p.subtitle ?? null, start: fmt(s), end: fmt(end), weeks: p.weeks,
    days: p.days.map(d => ({
      title: d.title, weekday: WD[d.offset],
      skill: d.skillBlock ? d.skillBlock.title : d.skill ? 'Skill (Text)' : null,
      clocks: Object.entries(d.clocks ?? {}).map(([L, c]) => `${L}: ${clockLabel(c)}`),
      exercises: d.ex.map(x => `${x.b} ${x.n} · ${captureLabel(x)}`),
    })),
  };
}

const FIELD_LABEL: Record<string, string> = { gewicht: 'kg', wdh: 'Wdh.', zeit: 'Zeit', band: 'Band' };
/** Kurzbeschreibung der Erfassung für die Upload-Vorschau, z. B. „kg je Hand × Wdh.“ oder „Zeit (halten)“. */
export function captureLabel(x: PlanSlot): string {
  if (x.format === 'tabata' && x.tabata) return `Tabata ${x.tabata.work}/${x.tabata.rest} s × ${x.tabata.rounds}${x.tabata.sets > 1 ? ` × ${x.tabata.sets} Sätze` : ''}`;
  const c = deriveCapture(x);
  const parts = c.fields.map(f => f === 'gewicht' && c.wref ? `kg ${c.wref === 'je_hand' ? 'je Hand' : c.wref === 'je_seite' ? 'je Seite' : 'gesamt'}` : FIELD_LABEL[f]);
  const mode = c.tmode === 'halten' ? ' (halten)' : c.tmode === 'in_zeit' ? ' (in fester Zeit)' : c.tmode === 'auf_zeit' ? ' (auf Zeit)' : '';
  return parts.join(' × ') + mode;
}
