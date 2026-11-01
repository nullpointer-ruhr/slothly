// Ableitungen aus Plantexten: Pause (#7), Erfassung (#10), Skill-Block (#5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCapture, parsePause, parseSeconds, parseSkillText, normalizeSkillBlock, splitSkillItem } from '../src/derive.ts';

test('Pausen aus allen Texten der beiden Pläne', () => {
  const cases: [string, number][] = [
    ['150 s', 150], ['90 s', 90], ['75 s', 75], ['60 s', 60], ['20 s', 20], ['20 s/Runde', 20], ['60 s/Runde', 60],
    ['2 min', 120], ['2–3 min', 180], ['75–90 s', 90], ['45–60 s', 60], ['1:30', 90], ['1,5 min', 90],
    ['direkt zu B2', 0], ['direkt weiter', 0], ['in A-Pause', 0], ['', 0],
  ];
  for (const [t, s] of cases) assert.equal(parsePause(t), s, t);
});

test('Sekunden aus Vorgaben', () => {
  assert.equal(parseSeconds('20 s'), 20);
  assert.equal(parseSeconds('30–45 s halten'), 45);
  assert.equal(parseSeconds('0:35'), 35);
  assert.equal(parseSeconds('8–12'), null);
});

test('Erfassung und Gewichtsbezug werden aus den Texten abgeleitet', () => {
  const d = (r: string, st: string, extra = {}) => deriveCapture({ r, st, format: 'standard', ...extra });
  assert.deepEqual(d('8–10', '25 kg'), { fields: ['gewicht', 'wdh'], tmode: null, wref: 'gesamt' });
  assert.deepEqual(d('8–10', '2×8 kg'), { fields: ['gewicht', 'wdh'], tmode: null, wref: 'je_hand' });
  assert.deepEqual(d('20 s', 'KG'), { fields: ['zeit'], tmode: 'halten', wref: null });
  assert.deepEqual(d('30–45 s halten', 'KG'), { fields: ['zeit'], tmode: 'halten', wref: null });
  assert.deepEqual(d('40 s', '2×20 kg'), { fields: ['zeit', 'gewicht'], tmode: 'halten', wref: 'je_hand' });
  assert.deepEqual(d('max. in 30 s', 'KG'), { fields: ['wdh'], tmode: 'in_zeit', wref: null });
  assert.deepEqual(d('20 auf Zeit', 'KG'), { fields: ['zeit'], tmode: 'auf_zeit', wref: null });
  assert.deepEqual(d('8', 'Band schwarz + gelb'), { fields: ['band', 'wdh'], tmode: null, wref: null });
  assert.deepEqual(d('10', 'KG'), { fields: ['wdh'], tmode: null, wref: null });
  // Explizite Angaben gehen vor
  assert.deepEqual(d('8', '2×8 kg', { fields: ['gewicht', 'wdh'], wref: 'gesamt' }), { fields: ['gewicht', 'wdh'], tmode: null, wref: 'gesamt' });
  assert.deepEqual(d('8', 'KG', { fields: ['wdh', 'zeit'], tmode: 'in_zeit' }), { fields: ['wdh', 'zeit'], tmode: 'in_zeit', wref: null });
});

test('Skill-Text mit Wochenabschnitten wird zu einer Liste pro Woche', () => {
  const t = 'Handstand (6 min, solange die Schulter frisch ist). W1: Handgelenke 30 s kreisen · Hollow Body Hold 3×15 s · Pike Push-up 3×5 · Wall Walk bis ca. 45°: 3×1, 5 s halten. W2: Handgelenke 30 s · Hollow Body Hold 3×20 s. W6: Handgelenke 30 s · Test: maximaler Wandhandstand, 2 Versuche, Zeit notieren.';
  const b = parseSkillText(t, 6)!;
  assert.equal(b.title, 'Handstand');
  assert.equal(b.dur, '6 min');
  assert.equal(b.hint, 'solange die Schulter frisch ist');
  assert.equal(b.weeks.length, 6);
  assert.deepEqual(b.weeks[0].map(i => [i.n, i.v]), [['Handgelenke', '30 s kreisen'], ['Hollow Body Hold', '3×15 s'], ['Pike Push-up', '3×5'], ['Wall Walk bis ca. 45°', '3×1, 5 s halten']]);
  assert.equal(b.weeks[3].length, 2, 'W3–W5 übernehmen W2');
  assert.deepEqual([b.weeks[5][1].n, b.weeks[5][1].v], ['Test', 'maximaler Wandhandstand, 2 Versuche, Zeit notieren']);
});

test('Skill-Text ohne Wochen gilt für alle Wochen', () => {
  const b = parseSkillText('Hollow Body Hold, Arme am Körper, 3×20–30 s · Aktiver Dead Hang mit Klimmzugband 3×10–20 s, nur nach Freigabe', 6)!;
  assert.equal(b.title, 'Skill');
  assert.equal(b.weeks.length, 6);
  assert.deepEqual(b.weeks[5].map(i => i.n), ['Hollow Body Hold, Arme am Körper', 'Aktiver Dead Hang mit Klimmzugband']);
  assert.equal(splitSkillItem('Pike Push-up').v, null);
});

test('Skill-Block aus der Plandatei', () => {
  const b = normalizeSkillBlock({ titel: 'Handstand', dauer: '6 min', wochen: [[{ name: 'A', vorgabe: '3×5', video: 'a' }], ['B 3×10 s']] }, 4)!;
  assert.equal(b.weeks.length, 4);
  assert.deepEqual(b.weeks[0][0], { n: 'A', v: '3×5', q: 'a' });
  assert.deepEqual(b.weeks[3][0], { n: 'B', v: '3×10 s', q: null });
});
