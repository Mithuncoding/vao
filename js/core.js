// Data loading, local progress, Anki-style scheduling and stats.
export const EXAM = new Date('2026-10-04T10:30:00+05:30');
export const MIN = 60e3;
export const DAY = 864e5;
export const SECTIONS = { gk: 'GK', kannada: 'ಕನ್ನಡ', english: 'English', computer: 'Computer' };
const KEY = 'vaoPrep.v1';
const STEPS = [1 * MIN, 10 * MIN];
const LEARN_AHEAD = 20 * MIN;

export const S = { cards: [], ordered: [], byId: new Map(), decks: [], lib: [], notes: [], meta: {}, p: null };

const defaults = () => ({
  cards: {}, log: [], days: {}, mistakes: {}, mocks: [], mockRun: null,
  settings: { newPerDay: 200, cap: 3, theme: 'auto', font: 100, haptics: true, invert: true, focus: 'all' },
});

export function loadProgress() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY)); } catch { saved = null; }
  const d = defaults();
  S.p = Object.assign(d, saved || {});
  S.p.settings = Object.assign(defaults().settings, (saved && saved.settings) || {});
}

let timer = 0;
export function saveProgress(now = false) {
  clearTimeout(timer);
  const write = () => {
    try { localStorage.setItem(KEY, JSON.stringify(S.p)); } catch (e) { console.warn('save failed', e); }
  };
  if (now) write(); else timer = setTimeout(write, 250);
}
addEventListener('pagehide', () => saveProgress(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(true); });

export function exportProgress() {
  return new Blob([JSON.stringify({ app: 'vao-prep', v: 1, at: new Date().toISOString(), p: S.p })], { type: 'application/json' });
}
export function importProgress(text) {
  const o = JSON.parse(text);
  if (!o || o.app !== 'vao-prep' || !o.p) throw new Error('Not a VAO Prep backup file');
  S.p = Object.assign(defaults(), o.p);
  S.p.settings = Object.assign(defaults().settings, o.p.settings || {});
  saveProgress(true);
}
export function resetProgress() {
  const keep = S.p.settings;
  S.p = defaults();
  S.p.settings = keep;
  saveProgress(true);
}

export async function loadData() {
  const get = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); });
  const [bank, lib, notes] = await Promise.all([get('data/bank.json'), get('data/library.json'), get('data/notes.json')]);
  S.meta = bank.meta; S.decks = bank.decks; S.cards = bank.cards; S.lib = lib; S.notes = notes;
  S.cards.forEach((c, ix) => { c.ix = ix; c.deck = S.decks[c.d]; S.byId.set(c.i, c); });
  S.ordered = studyOrder(S.cards);
}

// New cards interleave sections (GK twice as often) so a session mixes subjects.
function studyOrder(cards) {
  const lanes = { gk: [], kannada: [], english: [], computer: [] };
  const recent = (c) => ((c.deck.paper || '').match(/\d{4}-\d{2}(-\d{2})?/) || ['0000'])[0];
  const sorted = [...cards].sort((a, b) =>
    (a.deck.paper ? 0 : 1) - (b.deck.paper ? 0 : 1) || recent(b).localeCompare(recent(a)) || a.d - b.d || (a.n || 0) - (b.n || 0));
  for (const c of sorted) (lanes[c.sec] || lanes.gk).push(c);
  const pattern = ['gk', 'kannada', 'gk', 'english', 'computer'];
  const out = [];
  const pos = { gk: 0, kannada: 0, english: 0, computer: 0 };
  while (out.length < cards.length) {
    let moved = false;
    for (const sec of pattern) {
      if (pos[sec] < lanes[sec].length) { out.push(lanes[sec][pos[sec]++]); moved = true; }
    }
    if (!moved) break;
  }
  return out;
}

export const today = (t = Date.now()) => new Date(t).toLocaleDateString('en-CA');
export function dayStat(k = today()) {
  if (!S.p.days[k]) S.p.days[k] = { n: 0, ok: 0, bad: 0, skip: 0, ms: 0, nw: 0 };
  return S.p.days[k];
}

export function matches(c, f) {
  if (!f || f === 'all') return true;
  const [k, v] = f.split(':');
  if (k === 'sec') return c.sec === v;
  if (k === 'grp') return v === 'pp' ? !!c.deck.paper : !c.deck.paper;
  if (k === 'deck') return c.d === Number(v);
  if (k === 'paper') return c.deck.paper === v;
  if (k === 'mistakes') return !!S.p.mistakes[c.i];
  return true;
}
export const filterCards = (f) => S.ordered.filter((c) => matches(c, f));

export const correctSet = (c) => new Set(String(c.a || '').split('&').map(Number));
export const isCorrect = (c, k) => correctSet(c).has(k);

export function newLeft() {
  return Math.max(0, (S.p.settings.newPerDay || 0) - dayStat().nw);
}

export function counts(list, now = Date.now()) {
  let fresh = 0, learn = 0, due = 0;
  for (const c of list) {
    const s = S.p.cards[c.i];
    if (!s || s.s === 0) fresh++;
    else if (s.s === 1) { if (s.due <= now + LEARN_AHEAD) learn++; }
    else if (s.due <= now) due++;
  }
  return { fresh: Math.min(fresh, newLeft()), freshAll: fresh, learn, due };
}

export function pickNext(list, now = Date.now(), avoid = null) {
  let learn = null, review = null, fresh = null, ahead = null;
  const due = (c) => S.p.cards[c.i].due;
  for (const c of list) {
    if (c.i === avoid) continue;
    const s = S.p.cards[c.i];
    if (!s || s.s === 0) { if (!fresh) fresh = c; continue; }
    if (s.s === 1) {
      if (s.due <= now) { if (!learn || s.due < due(learn)) learn = c; }
      else if (s.due <= now + LEARN_AHEAD && (!ahead || s.due < due(ahead))) ahead = c;
    } else if (s.due <= now && (!review || s.due < due(review))) review = c;
  }
  if (learn) return learn;
  if (review) return review;
  if (fresh && newLeft() > 0) return fresh;
  return ahead;
}

function nextState(prev, r, now, mcq = false) {
  const s = prev ? { ...prev } : { s: 0, due: 0, ivl: 0, ease: 2.5, step: 0, reps: 0, lapses: 0 };
  const cap = S.p.settings.cap || 3;
  if (s.s === 0 && r === 3 && mcq) {
    // right on first sight: no need for the 10-minute learning step
    s.s = 2; s.ivl = 1; s.due = now + DAY;
  } else if (s.s !== 2) {
    if (r === 1) { s.s = 1; s.step = 0; s.due = now + STEPS[0]; }
    else if (r === 2) { s.s = 1; s.due = now + Math.max(5 * MIN, STEPS[Math.min(s.step, STEPS.length - 1)]); }
    else if (r === 3) {
      s.step += 1;
      if (s.step >= STEPS.length) { s.s = 2; s.ivl = Math.max(1, s.ivl || 0); s.due = now + s.ivl * DAY; }
      else { s.s = 1; s.due = now + STEPS[s.step]; }
    } else { s.s = 2; s.ivl = Math.max(3, s.ivl || 0); s.ease = Math.min(3.5, s.ease + 0.15); s.due = now + s.ivl * DAY; }
  } else if (r === 1) {
    s.lapses += 1; s.ease = Math.max(1.3, s.ease - 0.2); s.ivl = Math.max(1, Math.round(s.ivl * 0.5));
    s.s = 1; s.step = 0; s.due = now + STEPS[0];
  } else if (r === 2) {
    s.ease = Math.max(1.3, s.ease - 0.15); s.ivl = Math.min(cap, Math.max(1, Math.round(s.ivl * 1.2))); s.due = now + s.ivl * DAY;
  } else if (r === 3) {
    s.ivl = Math.min(cap, Math.max(s.ivl + 1, Math.round(s.ivl * s.ease))); s.due = now + s.ivl * DAY;
  } else {
    s.ease = Math.min(3.5, s.ease + 0.15); s.ivl = Math.max(s.ivl + 2, Math.round(s.ivl * s.ease * 1.3)); s.due = now + s.ivl * DAY;
  }
  s.reps += 1; s.last = now;
  return s;
}

export function intervalLabel(c, r, now = Date.now()) {
  const ms = nextState(S.p.cards[c.i], r, now, c.t === 'm').due - now;
  if (ms < 60 * MIN) return `${Math.max(1, Math.round(ms / MIN))}m`;
  if (ms < DAY) return `${Math.round(ms / (60 * MIN))}h`;
  return `${Math.round(ms / DAY)}d`;
}

export function grade(c, r, now = Date.now()) {
  const prev = S.p.cards[c.i];
  if (!prev || prev.s === 0) dayStat().nw += 1;
  S.p.cards[c.i] = nextState(prev, r, now, c.t === 'm');
  saveProgress();
}

// ok: 1 right, 0 wrong, -1 skipped (5th circle)
export function record(c, ok, mode, ms = 0) {
  const now = Date.now();
  const d = dayStat();
  d.n += 1;
  if (ok === 1) d.ok += 1; else if (ok === 0) d.bad += 1; else d.skip += 1;
  d.ms += Math.min(Math.max(ms, 0), 120e3);
  S.p.log.push([now, c.i, ok, mode]);
  if (S.p.log.length > 40000) S.p.log.splice(0, S.p.log.length - 40000);
  const m = S.p.mistakes[c.i];
  if (ok !== 1) S.p.mistakes[c.i] = { n: ((m && m.n) || 0) + 1, t: now, ok: 0 };
  else if (m) { m.ok = (m.ok || 0) + 1; if (m.ok >= 2) delete S.p.mistakes[c.i]; }
  saveProgress();
}

export function sectionStats(sinceDays = 0) {
  const since = sinceDays ? Date.now() - sinceDays * DAY : 0;
  const out = {};
  for (const k of Object.keys(SECTIONS)) out[k] = { n: 0, ok: 0, bad: 0, skip: 0 };
  for (const [t, id, ok] of S.p.log) {
    if (t < since) continue;
    const c = S.byId.get(id);
    if (!c) continue;
    const o = out[c.sec] || out.gk;
    o.n += 1;
    if (ok === 1) o.ok += 1; else if (ok === 0) o.bad += 1; else o.skip += 1;
  }
  return out;
}

export function learnedBySection() {
  const out = {};
  for (const k of Object.keys(SECTIONS)) out[k] = { total: 0, learned: 0, seen: 0 };
  for (const c of S.cards) {
    const o = out[c.sec] || out.gk;
    o.total += 1;
    const s = S.p.cards[c.i];
    if (s && s.s > 0) o.seen += 1;
    if (s && s.s === 2) o.learned += 1;
  }
  return out;
}

export function streak() {
  let n = 0;
  const d = new Date();
  if (!(S.p.days[today()] && S.p.days[today()].n)) d.setDate(d.getDate() - 1);
  for (;;) {
    const k = d.toLocaleDateString('en-CA');
    if (S.p.days[k] && S.p.days[k].n > 0) { n += 1; d.setDate(d.getDate() - 1); } else break;
  }
  return n;
}

// KEA marking: +1 right, -0.25 wrong, 0 for the 5th circle, -0.25 for a blank row.
export function markPaper(cards, answers) {
  const r = { right: 0, wrong: 0, skip: 0, blank: 0, score: 0, bySec: {} };
  for (const c of cards) {
    const a = answers[c.i];
    const sec = (r.bySec[c.sec] ||= { right: 0, wrong: 0, skip: 0, blank: 0, score: 0, total: 0 });
    sec.total += 1;
    let kind;
    if (a == null) kind = 'blank'; else if (a === 5) kind = 'skip'; else if (isCorrect(c, a)) kind = 'right'; else kind = 'wrong';
    const pts = kind === 'right' ? 1 : kind === 'skip' ? 0 : -0.25;
    r[kind] += 1; r.score += pts; sec[kind] += 1; sec.score += pts;
  }
  return r;
}
