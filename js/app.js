import {
  S, EXAM, DAY, SECTIONS, loadProgress, saveProgress, loadData, today, dayStat, filterCards, counts, pickNext,
  grade, intervalLabel, record, isCorrect, correctSet, sectionStats, learnedBySection, streak, markPaper,
  exportProgress, importProgress, resetProgress,
} from './core.js';

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
// card text may carry <b>/<i>/<u>/<br>; everything else is escaped
const rich = (s) => esc(s).replace(/&lt;(\/?)(b|i|u|br)\s*\/?&gt;/g, '<$1$2>');
const btn = (label, onclick, cls = '') => h('button', { class: `btn ${cls}`, onclick, type: 'button' }, label);
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const fmtScore = (x) => (Math.round(x * 100) / 100).toString();
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function toast(msg, action) {
  const t = $('#toast');
  t.replaceChildren(...[h('span', null, msg), action ? btn(action.label, () => { t.classList.remove('show'); action.run(); }, 'link') : null].filter(Boolean));
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), action ? 8000 : 2600);
}
const buzz = () => { if (S.p.settings.haptics && navigator.vibrate) navigator.vibrate(35); };

// In-app confirm sheet (native confirm() looks broken on phones).
function ask(msg, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const close = (v) => { m.remove(); resolve(v); };
    const okBtn = btn(ok, () => close(true), danger ? 'danger' : 'primary');
    const m = h('div', { class: 'modal', onclick: (e) => { if (e.target === m) close(false); } },
      h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, h('p', null, msg),
        h('div', { class: 'row end' }, cancel ? btn(cancel, () => close(false), 'ghost') : null, okBtn)));
    document.body.append(m);
    okBtn.focus();
  });
}

// ---------- routing ----------
let cleanups = [];
const onLeave = (fn) => cleanups.push(fn);
let keyHandler = null;
const onKey = (fn) => { keyHandler = fn; };
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  if (e.key === 'Escape' && !$('#zoom').hidden) { closeZoom(); return; }
  if (keyHandler) keyHandler(e);
});

const routes = {
  home: Home, study: Study, practice: Practice, mock: Mock, more: More, mistakes: Mistakes,
  library: Library, notes: Notes, stats: Stats, settings: Settings, search: Search,
};
const MORE_TABS = ['mistakes', 'library', 'notes', 'stats', 'settings', 'search'];
function route() {
  const [name = 'home', ...args] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const fn = routes[name] || Home;
  const tab = MORE_TABS.includes(name) ? 'more' : routes[name] ? name : 'home';
  document.querySelectorAll('#tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  cleanups.forEach((f) => f());
  cleanups = [];
  keyHandler = null;
  view.replaceChildren();
  fn(view, ...args.map(decodeURIComponent));
  window.scrollTo(0, 0);
}
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

// ---------- shared pieces ----------
function openZoom(src) {
  const z = $('#zoom');
  const img = h('img', { src, alt: 'Question image (zoomed)', onclick: (e) => e.currentTarget.classList.toggle('big') });
  z.replaceChildren(h('button', { class: 'zclose', onclick: closeZoom, 'aria-label': 'Close' }, '✕'), img,
    h('p', { class: 'zhint' }, 'Tap the picture to enlarge · scroll to move'));
  z.hidden = false;
}
function closeZoom() { const z = $('#zoom'); z.hidden = true; z.replaceChildren(); }
$('#zoom').addEventListener('click', (e) => { if (e.target.id === 'zoom') closeZoom(); });

function Img(src, cls = 'qimg') {
  const img = h('img', { src, loading: 'lazy', alt: 'Question from the official paper', class: cls, onclick: () => openZoom(src) });
  img.addEventListener('error', () => img.replaceWith(h('div', { class: 'imgerr' },
    'Picture not available offline yet. Connect once, or use Settings → Download all images.')));
  return img;
}

function secTag(c) { return h('span', { class: `sec sec-${c.sec}` }, SECTIONS[c.sec] || c.sec); }

function answerText(c) {
  const ks = [...correctSet(c)].filter(Boolean);
  const label = ks.map((k) => (c.o ? `(${k}) ${c.o[k - 1]}` : `${k}`)).join('  or  ');
  return ks.length > 1 ? `Answers: ${label} (KEA accepted both)` : `Answer: ${label}`;
}

// A question card. picked: 1-4, 5 = 5th circle; revealed: show right/wrong + explanation.
function qView(c, { picked = null, revealed = false, onPick = null, showSkip = true } = {}) {
  const card = h('article', { class: 'qcard' });
  card.append(h('div', { class: 'qmeta' }, secTag(c), h('span', { class: 'deckname' }, c.deck.short + (c.n ? ` · Q${c.n}` : ''))));
  (c.img || []).forEach((src) => card.append(Img(src)));
  if (c.q) card.append(h('div', { class: 'qtext', html: rich(c.q) }));
  if (c.t === 'm') {
    const right = correctSet(c);
    const opts = h('div', { class: c.o ? 'opts' : 'opts grid' });
    for (let k = 1; k <= 4; k++) {
      let cls = 'opt';
      if (picked === k) cls += ' picked';
      if (revealed && right.has(k)) cls += ' right';
      if (revealed && picked === k && !right.has(k)) cls += ' wrong';
      opts.append(h('button', { class: cls, type: 'button', disabled: revealed || !onPick, onclick: () => onPick && onPick(k) },
        h('b', null, k), c.o ? h('span', { html: rich(c.o[k - 1]) }) : null));
    }
    card.append(opts);
    if (showSkip) {
      card.append(h('button', {
        class: `skip ${picked === 5 ? 'picked' : ''}`, type: 'button', disabled: revealed || !onPick, onclick: () => onPick && onPick(5),
      }, '5 · Don\'t know (5th circle)'));
    }
  }
  if (revealed) {
    const ex = h('div', { class: 'explain' });
    if (c.t === 'm') {
      const ok = picked !== 5 && picked != null && isCorrect(c, picked);
      if (picked != null) {
        ex.append(h('div', { class: `verdict ${picked === 5 ? 'skipv' : ok ? 'ok' : 'bad'}` },
          picked === 5 ? 'Skipped (0 marks)' : ok ? 'Correct  +1' : 'Wrong  −0.25'));
      }
      ex.append(h('div', { class: 'ans' }, answerText(c)));
    } else {
      ex.append(h('div', { class: 'back', html: rich(c.bk) }));
    }
    if (c.x) ex.append(h('div', { class: 'xpl', html: rich(c.x) }));
    if (c.ib && c.ib.length) {
      ex.append(h('div', { class: 'kn-label' }, 'ಕನ್ನಡ ಆವೃತ್ತಿ (Kannada version)'));
      c.ib.forEach((src) => ex.append(Img(src)));
    }
    if (c.s) ex.append(h('div', { class: 'src' }, c.s));
    card.append(ex);
  }
  return card;
}

const FOCI = [['all', 'All'], ['sec:gk', 'GK'], ['sec:kannada', 'ಕನ್ನಡ'], ['sec:english', 'English'], ['sec:computer', 'Computer'],
  ['grp:pp', 'Past papers'], ['grp:drills', 'Drills'], ['mistakes', 'Mistakes']];
function focusChips(current, onChange) {
  const bar = h('div', { class: 'chips', role: 'tablist' });
  for (const [k, label] of FOCI) {
    bar.append(h('button', { class: `chipbtn ${k === current ? 'on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(k === current),
      onclick: () => onChange(k) }, label));
  }
  return bar;
}

function sourceSelect(id, value) {
  const sel = h('select', { id });
  const add = (group, items) => {
    const og = h('optgroup', { label: group });
    items.forEach(([v, t]) => og.append(h('option', { value: v, selected: v === value }, t)));
    sel.append(og);
  };
  add('Mixed', [['all', 'All questions'], ['grp:pp', 'Official past papers only'], ['grp:drills', 'Drills only'],
    ['mistakes', `My mistakes (${Object.keys(S.p.mistakes).length})`]]);
  add('Section', [['sec:gk', 'GK (Paper 1)'], ['sec:kannada', 'ಕನ್ನಡ'], ['sec:english', 'English'], ['sec:computer', 'Computer']]);
  add('Official paper', S.decks.map((d, i) => [d, i]).filter(([d]) => d.paper).map(([d, i]) => [`deck:${i}`, d.short]));
  add('Drill deck', S.decks.map((d, i) => [d, i]).filter(([d]) => !d.paper).map(([d, i]) => [`deck:${i}`, `${d.group.replace(/^\d+\s*/, '')} · ${d.short}`]));
  return sel;
}

function ring(value, label, sub) {
  const r = 34, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, value));
  const arc = v > 0 ? `<circle cx="40" cy="40" r="${r}" class="arc" stroke-dasharray="${(c * v) / 100} ${c}"/>` : '';
  const svg = `<svg viewBox="0 0 80 80" class="ring"><circle cx="40" cy="40" r="${r}" class="track"/>${arc}</svg>`;
  return h('div', { class: 'ringbox' }, h('div', { class: 'ringwrap', html: svg }, h('b', null, label)), h('span', null, sub));
}

function timeLeft(ms) {
  if (ms <= 0) return 'Exam time!';
  const d = Math.floor(ms / DAY), hr = Math.floor((ms % DAY) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
  return d > 0 ? `${d}d ${hr}h` : `${hr}h ${m}m`;
}
function tickCountdown() { $('#countdown').textContent = `⏳ ${timeLeft(EXAM - Date.now())}`; }

const PLAN = {
  '2026-09-29': 'Block 1 Panchayat Raj & land revenue · Kannada ಸಂಧಿ/ಸಮಾಸ · 20 min of cards',
  '2026-09-30': 'Karnataka history & culture · Constitution core · Kannada ವಿಭಕ್ತಿ/ತತ್ಸಮ/ಅಲಂಕಾರ · GK past papers',
  '2026-10-01': 'Science · Karnataka geography · current affairs · English traps · Computer',
  '2026-10-02': 'VAO 2024 full mock: Paper 1 at 10:30, Paper 2 at 14:30, then 2 hours on mistakes',
  '2026-10-03': 'Fix mock mistakes · Kannada literature · one timed past paper · sleep early',
  '2026-10-04': 'Exam day: be at the centre by 8:30. Admit card + original ID. Shade every row.',
};

let installEvt = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  if (S.cards.length && /^#\/?(home)?$/.test(location.hash || '#/home')) route();
});

// ---------- Home ----------
function Home(root) {
  const d = dayStat();
  const all = filterCards('all');
  const k = counts(all);
  const exam = EXAM - Date.now();
  root.append(h('section', { class: 'hero' },
    h('div', { class: 'hero-top' }, h('span', null, 'VAO exam in'), h('span', { class: 'pill' }, 'Target 140+ / 200')),
    h('div', { class: 'big' }, timeLeft(exam)),
    h('div', { class: 'hero-sub' }, 'Sun 4 Oct · Paper 1 10:30 · Paper 2 14:30'),
    PLAN[today()] ? h('div', { class: 'plan' }, h('b', null, 'Today: '), PLAN[today()]) : null));

  if (installEvt) {
    root.append(h('div', { class: 'card install' }, h('div', null, h('b', null, 'Install VAO Prep'), h('p', null, 'Opens full-screen from your home screen and works offline.')),
      btn('Install', async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; route(); }, 'primary')));
  }

  root.append(h('section', { class: 'card rings' },
    ring(Math.min(100, pct(d.n, 150)), d.n, 'answered today'),
    ring(pct(d.ok, d.ok + d.bad + d.skip), `${pct(d.ok, d.ok + d.bad + d.skip)}%`, 'accuracy'),
    ring(Math.min(100, pct(d.nw, S.p.settings.newPerDay)), d.nw, 'new cards'),
    ring(Math.min(100, pct(d.ms, 6 * 36e5)), `${Math.round(d.ms / 6e4)}m`, 'focused time')));

  root.append(h('button', { class: 'cta', type: 'button', onclick: () => go('#/study') },
    h('span', null, 'Continue studying'),
    h('span', { class: 'ctacounts' }, h('i', { class: 'n' }, `${k.fresh} new`), h('i', { class: 'l' }, `${k.learn} learn`), h('i', { class: 'd' }, `${k.due} due`))));

  const secStats = sectionStats();
  const learned = learnedBySection();
  const grid = h('section', { class: 'secgrid' });
  for (const [key, label] of Object.entries(SECTIONS)) {
    const s = secStats[key], L = learned[key];
    grid.append(h('button', { class: `sectile sec-${key}`, type: 'button', onclick: () => { S.p.settings.focus = `sec:${key}`; saveProgress(); go('#/study'); } },
      h('b', null, label), h('span', { class: 'acc' }, s.n ? `${pct(s.ok, s.n)}% right` : 'not started'),
      h('div', { class: 'bar' }, h('i', { style: `width:${pct(L.seen, L.total)}%` })), h('small', null, `${L.seen} / ${L.total} seen`)));
  }
  root.append(h('h2', { class: 'sub' }, 'Sections'), grid);

  const mcount = Object.keys(S.p.mistakes).length;
  root.append(h('section', { class: 'quick' },
    btn('⚡ Quick 20', () => startQuiz(pickSet('all', 20, true), 'Quick 20'), 'tile'),
    btn(`❌ Mistakes (${mcount})`, () => go('#/mistakes'), 'tile'),
    btn('⏱️ Mock test', () => go('#/mock'), 'tile'),
    btn('📘 Notes', () => go('#/notes'), 'tile')));
  root.append(h('p', { class: 'foot' }, `${S.meta.cards} questions · ${S.decks.filter((x) => x.paper).length} official KEA papers · progress saved on this phone`));
}

// ---------- Study (Anki-style) ----------
function Study(root) {
  const stage = h('div', { class: 'stage' });
  const countsEl = h('div', { class: 'counts' });
  let list = [], cur = null, picked = null, revealed = false, t0 = 0, lastId = null;

  const chips = () => focusChips(S.p.settings.focus, (f) => { S.p.settings.focus = f; saveProgress(); chipsBox.replaceChildren(chips()); rebuild(); });
  const chipsBox = h('div', null, chips());
  root.append(h('h1', { class: 'title' }, 'Study'), chipsBox, countsEl, stage);

  function rebuild() { list = filterCards(S.p.settings.focus); lastId = null; next(); }
  function showCounts() {
    const k = counts(list);
    countsEl.replaceChildren(h('span', { class: 'cnt n' }, `${k.fresh} new`), h('span', { class: 'cnt l' }, `${k.learn} learning`),
      h('span', { class: 'cnt d' }, `${k.due} due`), h('span', { class: 'cnt t' }, `${dayStat().n} done today`));
  }
  function next() {
    cur = pickNext(list, Date.now(), lastId) || pickNext(list, Date.now());
    picked = null; revealed = false; t0 = Date.now();
    showCounts(); draw();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function rateButtons(rs) {
    const names = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
    return h('div', { class: 'rates' }, rs.map((r) => h('button', { class: `rate r${r}`, type: 'button', onclick: () => rate(r) },
      h('b', null, names[r]), h('small', null, intervalLabel(cur, r)))));
  }
  function draw() {
    if (!cur) { stage.replaceChildren(doneCard()); return; }
    const actions = h('div', { class: 'actions' });
    if (cur.t === 'b') {
      actions.append(revealed ? rateButtons([1, 2, 3, 4]) : btn('Show answer', () => { revealed = true; draw(); }, 'primary wide'));
    } else if (revealed) {
      actions.append(isCorrect(cur, picked) && picked !== 5 ? rateButtons([2, 3, 4]) : btn(`Again · ${intervalLabel(cur, 1)}`, () => rate(1), 'danger wide'));
    }
    stage.replaceChildren(qView(cur, { picked, revealed, onPick: pick }), actions);
  }
  function pick(k) {
    if (revealed) return;
    picked = k; revealed = true;
    const ok = k === 5 ? -1 : isCorrect(cur, k) ? 1 : 0;
    record(cur, ok, 'study', Date.now() - t0);
    if (ok !== 1) buzz();
    draw();
  }
  function rate(r) {
    if (cur.t === 'b') record(cur, r === 1 ? 0 : 1, 'study', Date.now() - t0);
    grade(cur, r);
    lastId = cur.i;
    next();
  }
  function doneCard() {
    const k = counts(list);
    return h('div', { class: 'card done' }, h('div', { class: 'emoji' }, '🎉'), h('h2', null, 'All caught up here'),
      h('p', null, k.freshAll ? `You've reached today's new-card limit (${S.p.settings.newPerDay}).` : 'No cards left in this focus right now.'),
      h('div', { class: 'row' },
        k.freshAll ? btn('+50 new cards today', () => { S.p.settings.newPerDay += 50; saveProgress(); rebuild(); }, 'primary') : null,
        btn('Practice quiz', () => go('#/practice')), btn('Focus: All', () => { S.p.settings.focus = 'all'; saveProgress(); chipsBox.replaceChildren(chips()); rebuild(); })));
  }
  onKey((e) => {
    if (!cur) return;
    if (!revealed) {
      if (cur.t === 'm' && /^[1-5]$/.test(e.key)) pick(Number(e.key));
      else if (cur.t === 'b' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); revealed = true; draw(); }
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      rate(cur.t === 'm' && !(isCorrect(cur, picked) && picked !== 5) ? 1 : 3);
    } else if (/^[1-4]$/.test(e.key)) {
      const r = Number(e.key);
      if (cur.t === 'b' || (isCorrect(cur, picked) && picked !== 5 ? r > 1 : r === 1)) rate(r);
    }
  });
  const tick = setInterval(showCounts, 30e3);
  onLeave(() => clearInterval(tick));
  rebuild();
}

// ---------- Practice ----------
function pickSet(source, n, random) {
  const pool = filterCards(source).filter((c) => c.t === 'm');
  const set = random ? shuffle([...pool]) : [...pool].sort((a, b) => a.d - b.d || (a.n || 0) - (b.n || 0));
  return set.slice(0, n);
}

let quizState = null;
function startQuiz(cards, title) {
  if (!cards.length) { toast('No questions in that selection yet.'); return; }
  quizState = { cards, title, i: 0, picks: {}, t0: Date.now() };
  go('#/practice/run');
}

function Practice(root, sub) {
  if (sub === 'run' && quizState) return quizRun(root);
  if (sub === 'result' && quizState) return quizResult(root);
  const last = JSON.parse(sessionStorage.getItem('vao.quiz') || '{}');
  const sel = sourceSelect('src', last.src || 'all');
  const cnt = h('select', { id: 'cnt' }, [10, 20, 30, 50, 100].map((n) => h('option', { value: n, selected: n === (last.n || 20) }, `${n} questions`)));
  const ord = h('select', { id: 'ord' }, h('option', { value: 'r', selected: last.o !== 's' }, 'Random order'), h('option', { value: 's', selected: last.o === 's' }, 'Paper order'));
  root.append(h('h1', { class: 'title' }, 'Practice'),
    h('p', { class: 'lead' }, 'Quick quizzes with real KEA marking: +1 right, −0.25 wrong, 0 for the 5th circle.'),
    h('div', { class: 'card form' },
      h('label', null, 'Questions from', sel), h('label', null, 'How many', cnt), h('label', null, 'Order', ord),
      btn('Start quiz', () => {
        sessionStorage.setItem('vao.quiz', JSON.stringify({ src: sel.value, n: Number(cnt.value), o: ord.value }));
        startQuiz(pickSet(sel.value, Number(cnt.value), ord.value === 'r'), sel.selectedOptions[0].textContent);
      }, 'primary wide')));
  const presets = [['sec:english', 'English', 20], ['sec:kannada', 'ಕನ್ನಡ', 20], ['sec:computer', 'Computer', 20], ['sec:gk', 'GK', 25]];
  root.append(h('h2', { class: 'sub' }, 'One-tap drills'), h('div', { class: 'quick' },
    presets.map(([src, label, n]) => btn(`${label} · ${n}`, () => startQuiz(pickSet(src, n, true), `${label} drill`), 'tile'))));
}

function quizRun(root) {
  const q = quizState;
  const bar = h('div', { class: 'progress' }, h('i'));
  const head = h('div', { class: 'runhead' });
  const stage = h('div', { class: 'stage' });
  root.append(head, bar, stage);
  let t0 = Date.now();
  function score() { return markPaper(q.cards.slice(0, q.i + (q.picks[q.cards[q.i]?.i] != null ? 1 : 0)), q.picks).score; }
  function draw() {
    const c = q.cards[q.i];
    const picked = q.picks[c.i] ?? null;
    const revealed = picked != null;
    head.replaceChildren(h('b', null, q.title), h('span', null, `Q ${q.i + 1}/${q.cards.length}`), h('span', { class: 'score' }, `Score ${fmtScore(score())}`));
    bar.firstChild.style.width = `${pct(q.i + (revealed ? 1 : 0), q.cards.length)}%`;
    const actions = h('div', { class: 'actions' });
    if (revealed) actions.append(btn(q.i + 1 < q.cards.length ? 'Next →' : 'See result', nextQ, 'primary wide'));
    actions.append(btn('End quiz', () => go('#/practice/result'), 'ghost'));
    stage.replaceChildren(qView(c, { picked, revealed, onPick: (k) => {
      if (q.picks[c.i] != null) return;
      q.picks[c.i] = k;
      const ok = k === 5 ? -1 : isCorrect(c, k) ? 1 : 0;
      record(c, ok, 'practice', Date.now() - t0);
      if (ok !== 1) buzz();
      draw();
    } }), actions);
  }
  function nextQ() {
    if (q.i + 1 >= q.cards.length) { go('#/practice/result'); return; }
    q.i += 1; t0 = Date.now(); draw(); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  onKey((e) => {
    const c = q.cards[q.i];
    if (q.picks[c.i] == null && /^[1-5]$/.test(e.key)) { const k = Number(e.key); q.picks[c.i] = k; record(c, k === 5 ? -1 : isCorrect(c, k) ? 1 : 0, 'practice', Date.now() - t0); draw(); }
    else if (q.picks[c.i] != null && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); nextQ(); }
  });
  draw();
}

function quizResult(root) {
  const q = quizState;
  const answered = q.cards.filter((c) => q.picks[c.i] != null);
  const r = markPaper(answered, q.picks);
  const wrong = answered.filter((c) => q.picks[c.i] === 5 || !isCorrect(c, q.picks[c.i]));
  root.append(h('h1', { class: 'title' }, 'Quiz result'),
    h('section', { class: 'card result' },
      h('div', { class: 'bigscore' }, fmtScore(r.score), h('small', null, ` / ${answered.length}`)),
      h('div', { class: 'row stats3' }, h('span', { class: 'ok' }, `✔ ${r.right}`), h('span', { class: 'bad' }, `✘ ${r.wrong}`), h('span', { class: 'skipc' }, `5th circle ${r.skip}`)),
      h('p', { class: 'muted' }, `Accuracy ${pct(r.right, answered.length)}% · ${q.title}`)),
    h('div', { class: 'row' },
      wrong.length ? btn(`Retry ${wrong.length} missed`, () => startQuiz(shuffle([...wrong]), 'Retry missed'), 'primary') : null,
      btn('New quiz', () => { quizState = null; go('#/practice'); })));
  if (wrong.length) {
    root.append(h('h2', { class: 'sub' }, 'Review what you missed'));
    wrong.forEach((c) => root.append(reviewItem(c, q.picks[c.i])));
  }
}

function reviewItem(c, picked) {
  const d = h('details', { class: 'review' });
  const snippet = c.q ? c.q.replace(/<[^>]+>/g, '') : c.tx ? c.tx.replace(/^\s*\d+[.,]\s*/, '') : '';
  const label = snippet ? snippet.slice(0, 90) : `${c.deck.short} · Q${c.n}`;
  d.append(h('summary', null, secTag(c), h('span', null, label)));
  d.addEventListener('toggle', () => { if (d.open && d.children.length === 1) d.append(qView(c, { picked, revealed: true })); });
  return d;
}

// ---------- Mock ----------
function paperCards(pid) { return S.cards.filter((c) => c.deck.paper === pid).sort((a, b) => a.n - b.n); }

function Mock(root, sub, arg) {
  if (sub === 'run') return mockRun(root);
  if (sub === 'result') return mockResult(root, Number(arg));
  root.append(h('h1', { class: 'title' }, 'Mock test'),
    h('p', { class: 'lead' }, 'A full official paper, 2-hour timer, OMR-style grid and KEA marking. Blank rows cost −0.25, exactly like the real sheet.'));
  const run = S.p.mockRun;
  if (run) {
    const d = S.decks.find((x) => x.paper === run.pid);
    root.append(h('div', { class: 'card resume' }, h('div', null, h('b', null, 'Mock in progress'), h('p', null, `${d ? d.short : run.pid} · ${timeLeft(run.start + run.dur - Date.now())} left`)),
      h('div', { class: 'row' }, btn('Resume', () => go('#/mock/run'), 'primary'), btn('Abandon', async () => {
        if (await ask('Abandon this mock? Your answers will be lost.', { ok: 'Abandon', danger: true })) { S.p.mockRun = null; saveProgress(true); route(); }
      }, 'ghost'))));
  }
  const kinds = [['GK', 'Paper 1 · General Knowledge'], ['KEC', 'Paper 2 · Kannada, English, Computer'], ['KN', 'Kannada language tests']];
  for (const [kind, label] of kinds) {
    const decks = S.decks.filter((d) => d.paper && d.kind === kind).sort((a, b) => b.paper.localeCompare(a.paper));
    if (!decks.length) continue;
    root.append(h('h2', { class: 'sub' }, label));
    const list = h('div', { class: 'list' });
    for (const d of decks) {
      const n = paperCards(d.paper).length;
      const past = S.p.mocks.filter((m) => m.pid === d.paper);
      const best = past.length ? Math.max(...past.map((m) => m.score)) : null;
      list.append(h('button', { class: 'item', type: 'button', onclick: () => startMock(d.paper) },
        h('div', null, h('b', null, d.short), h('small', null, `${n} questions · 120 min`)),
        best != null ? h('span', { class: 'badge' }, `best ${fmtScore(best)}`) : h('span', { class: 'chev' }, '›')));
    }
    root.append(list);
  }
  if (S.p.mocks.length) {
    root.append(h('h2', { class: 'sub' }, 'Your mock history'));
    const list = h('div', { class: 'list' });
    S.p.mocks.map((m, i) => [m, i]).reverse().forEach(([m, i]) => {
      const d = S.decks.find((x) => x.paper === m.pid);
      list.append(h('button', { class: 'item', type: 'button', onclick: () => go(`#/mock/result/${i}`) },
        h('div', null, h('b', null, d ? d.short : m.pid), h('small', null, new Date(m.at).toLocaleString())), h('span', { class: 'badge' }, `${fmtScore(m.score)} / ${m.total}`)));
    });
    root.append(list);
  }
}

async function startMock(pid) {
  if (S.p.mockRun && !(await ask('Another mock is in progress. Start a new one instead?', { ok: 'Start new' }))) return;
  const n = paperCards(pid).length;
  if (!(await ask(`Start a 120-minute mock with ${n} questions?\n\nThe timer keeps running even if you leave the app.`, { ok: 'Start' }))) return;
  S.p.mockRun = { pid, start: Date.now(), dur: 120 * 60e3, ans: {}, flag: {}, cur: 0 };
  saveProgress(true);
  go('#/mock/run');
}

function mockRun(root) {
  const run = S.p.mockRun;
  if (!run) { go('#/mock'); return; }
  const cards = paperCards(run.pid);
  const deck = S.decks.find((d) => d.paper === run.pid);
  const clock = h('span', { class: 'clock' });
  const head = h('div', { class: 'runhead sticky' }, h('b', null, deck ? deck.short : run.pid), clock,
    btn('Submit', () => submit(false), 'primary small'));
  const stage = h('div', { class: 'stage' });
  const grid = h('div', { class: 'omr', hidden: true });
  root.append(head, grid, stage);

  function tick() {
    const left = run.start + run.dur - Date.now();
    clock.textContent = left > 0 ? `${Math.floor(left / 6e4)}:${String(Math.floor((left % 6e4) / 1000)).padStart(2, '0')}` : '0:00';
    clock.classList.toggle('low', left < 10 * 60e3);
    if (left <= 0) submit(true);
  }
  const iv = setInterval(tick, 1000);
  onLeave(() => clearInterval(iv));

  function drawGrid() {
    grid.replaceChildren(...cards.map((c, i) => {
      const a = run.ans[c.i];
      const cls = ['cell', a == null ? '' : a === 5 ? 'five' : 'done', run.flag[c.i] ? 'flag' : '', i === run.cur ? 'cur' : ''].join(' ');
      return h('button', { class: cls, type: 'button', onclick: () => { run.cur = i; grid.hidden = true; draw(); } }, c.n);
    }));
  }
  function draw() {
    const c = cards[run.cur];
    const answered = cards.filter((x) => run.ans[x.i] != null).length;
    const nav = h('div', { class: 'mocknav' },
      btn('‹ Prev', () => move(-1), 'ghost'),
      btn(`Grid · ${answered}/${cards.length}`, () => { drawGrid(); grid.hidden = !grid.hidden; }, 'ghost'),
      btn(run.flag[c.i] ? '★ Marked' : '☆ Mark', () => { run.flag[c.i] = !run.flag[c.i]; saveProgress(); draw(); }, 'ghost'),
      btn('Next ›', () => move(1), 'primary'));
    const clear = run.ans[c.i] != null ? btn('Clear answer', () => { delete run.ans[c.i]; saveProgress(); draw(); }, 'link') : null;
    stage.replaceChildren(h('div', { class: 'qnum' }, `Question ${run.cur + 1} of ${cards.length}`),
      qView(c, { picked: run.ans[c.i] ?? null, revealed: false, onPick: (k) => { run.ans[c.i] = k; saveProgress(); draw(); } }), clear, nav);
    if (!grid.hidden) drawGrid();
  }
  function move(step) {
    run.cur = Math.max(0, Math.min(cards.length - 1, run.cur + step));
    saveProgress(); draw(); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  let submitting = false;
  async function submit(timeUp) {
    if (!S.p.mockRun || submitting) return;
    const blanks = cards.filter((c) => run.ans[c.i] == null);
    if (!timeUp) {
      submitting = true;
      const msg = blanks.length
        ? `${blanks.length} rows are blank. On the real OMR sheet each blank costs −0.25 (−${fmtScore(blanks.length * 0.25)} here).\n\nShade the 5th circle on all of them and submit?`
        : 'Submit your answers?';
      const okGo = await ask(msg, { ok: blanks.length ? 'Shade 5th & submit' : 'Submit', cancel: 'Go back' });
      submitting = false;
      if (!okGo || !S.p.mockRun) return;
      blanks.forEach((c) => { run.ans[c.i] = 5; });
    }
    const r = markPaper(cards, run.ans);
    // only attempted rows feed accuracy stats and the mistakes list
    cards.forEach((c) => { const a = run.ans[c.i]; if (a != null && a !== 5) record(c, isCorrect(c, a) ? 1 : 0, 'mock'); });
    S.p.mocks.push({ pid: run.pid, at: Date.now(), dur: Date.now() - run.start, total: cards.length, ans: { ...run.ans }, ...r });
    S.p.mockRun = null;
    saveProgress(true);
    if (timeUp) toast('Time is up. Your paper was submitted.');
    go(`#/mock/result/${S.p.mocks.length - 1}`);
  }
  onKey((e) => {
    if (/^[1-5]$/.test(e.key)) { run.ans[cards[run.cur].i] = Number(e.key); saveProgress(); draw(); }
    else if (e.key === 'ArrowRight') move(1);
    else if (e.key === 'ArrowLeft') move(-1);
  });
  tick(); draw();
}

function mockResult(root, idx) {
  const m = S.p.mocks[idx];
  if (!m) { go('#/mock'); return; }
  const cards = paperCards(m.pid);
  const deck = S.decks.find((d) => d.paper === m.pid);
  root.append(h('h1', { class: 'title' }, 'Mock result'),
    h('section', { class: 'card result' },
      h('div', { class: 'muted' }, deck ? deck.short : m.pid),
      h('div', { class: 'bigscore' }, fmtScore(m.score), h('small', null, ` / ${m.total}`)),
      h('div', { class: 'row stats3' }, h('span', { class: 'ok' }, `✔ ${m.right}`), h('span', { class: 'bad' }, `✘ ${m.wrong}`),
        h('span', { class: 'skipc' }, `5th ${m.skip}`), m.blank ? h('span', { class: 'bad' }, `blank ${m.blank}`) : null),
      h('p', { class: 'muted' }, `Time used ${Math.round(m.dur / 6e4)} min · accuracy on attempted ${pct(m.right, m.right + m.wrong)}%`)));
  const secs = Object.entries(m.bySec || {});
  if (secs.length > 1) {
    const t = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Section'), h('th', null, 'Score'), h('th', null, '✔'), h('th', null, '✘'), h('th', null, '5th')));
    secs.forEach(([k, s]) => t.append(h('tr', null, h('td', null, SECTIONS[k] || k), h('td', null, `${fmtScore(s.score)} / ${s.total}`), h('td', null, s.right), h('td', null, s.wrong), h('td', null, s.skip))));
    root.append(h('div', { class: 'card' }, t));
  }
  const filters = [['wrong', 'Wrong'], ['skip', '5th circle'], ['all', 'All']];
  let f = 'wrong';
  const listBox = h('div');
  const bar = h('div', { class: 'chips' });
  function drawList() {
    bar.replaceChildren(...filters.map(([k, l]) => h('button', { class: `chipbtn ${k === f ? 'on' : ''}`, type: 'button', onclick: () => { f = k; drawList(); } }, l)));
    const items = cards.filter((c) => {
      const a = m.ans[c.i];
      if (f === 'wrong') return a != null && a !== 5 && !isCorrect(c, a);
      if (f === 'skip') return a == null || a === 5;
      return true;
    });
    listBox.replaceChildren(...(items.length ? items.map((c) => reviewItem(c, m.ans[c.i] ?? null)) : [h('p', { class: 'muted' }, 'Nothing here.')]));
  }
  root.append(h('h2', { class: 'sub' }, 'Review'), bar, listBox,
    h('div', { class: 'row' }, btn('Mock list', () => go('#/mock')), btn('Practise these mistakes', () => {
      const miss = cards.filter((c) => { const a = m.ans[c.i]; return a == null || a === 5 || !isCorrect(c, a); });
      startQuiz(shuffle(miss), 'Mock mistakes');
    }, 'primary')));
  drawList();
}

// ---------- More, Mistakes, Library, Notes, Stats, Settings ----------
function More(root) {
  const items = [
    ['#/mistakes', '❌', 'Mistakes', `${Object.keys(S.p.mistakes).length} to fix`],
    ['#/search', '🔎', 'Search', 'Find any question, word or topic'],
    ['#/notes', '📘', 'Notes', 'Exam rules, strategy, target, topic notes'],
    ['#/library', '📚', 'Official papers', 'KEA question papers and answer keys'],
    ['#/stats', '📈', 'Stats', 'Accuracy by section, streak, mocks'],
    ['#/settings', '⚙️', 'Settings', 'Daily limit, theme, offline, backup'],
  ];
  root.append(h('h1', { class: 'title' }, 'More'), h('div', { class: 'list' }, items.map(([href, ic, t, s]) =>
    h('a', { class: 'item', href }, h('span', { class: 'ic' }, ic), h('div', null, h('b', null, t), h('small', null, s)), h('span', { class: 'chev' }, '›')))));
}

function Mistakes(root) {
  const ids = Object.entries(S.p.mistakes).sort((a, b) => b[1].t - a[1].t).map(([id]) => S.byId.get(id)).filter(Boolean);
  root.append(h('h1', { class: 'title' }, 'Mistakes'),
    h('p', { class: 'lead' }, 'Everything you got wrong or skipped. A question leaves this list after two correct answers in a row.'));
  if (!ids.length) { root.append(h('div', { class: 'card done' }, h('div', { class: 'emoji' }, '✨'), h('p', null, 'No mistakes yet. Go and make some!'))); return; }
  const mcq = ids.filter((c) => c.t === 'm');
  root.append(h('div', { class: 'row' }, btn(`Practise all (${Math.min(100, mcq.length)})`, () => startQuiz(shuffle([...mcq]).slice(0, 100), 'Mistakes'), 'primary'),
    btn('Study them as cards', () => { S.p.settings.focus = 'mistakes'; saveProgress(); go('#/study'); })));
  const bySec = {};
  ids.forEach((c) => { (bySec[c.sec] ||= []).push(c); });
  for (const [sec, list] of Object.entries(bySec)) {
    root.append(h('h2', { class: 'sub' }, `${SECTIONS[sec] || sec} · ${list.length}`));
    list.slice(0, 60).forEach((c) => root.append(reviewItem(c, null)));
  }
}

function Search(root) {
  const input = h('input', { type: 'search', class: 'search', placeholder: 'e.g. Article 243, ಸಂಧಿ, phishing, idiom', 'aria-label': 'Search questions' });
  const out = h('div');
  root.append(h('h1', { class: 'title' }, 'Search'), input, out);
  let timer = 0;
  const run = () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { out.replaceChildren(h('p', { class: 'muted' }, 'Type at least 2 letters. The English text of past-paper questions is searchable too.')); return; }
    const hits = S.cards.filter((c) => [c.q, c.bk, c.x, c.tx, c.deck.short, ...(c.o || [])].some((t) => t && t.toLowerCase().includes(q)));
    out.replaceChildren(h('p', { class: 'muted' }, `${hits.length} found${hits.length > 60 ? ' · showing 60' : ''}`), ...hits.slice(0, 60).map((c) => reviewItem(c, null)));
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 200); });
  run();
  input.focus();
}

function Library(root) {
  root.append(h('h1', { class: 'title' }, 'Official papers'),
    h('p', { class: 'lead' }, 'Opens KEA\'s own copy (cetonline.karnataka.gov.in). Every question from these papers is already inside the app as cards. The VAO 2024 papers are held back for your Friday mock.'));
  for (const g of S.lib) {
    root.append(h('h2', { class: 'sub' }, g.g));
    root.append(h('div', { class: 'list' }, g.items.map((it) => h('a', { class: 'item', href: it.u, target: '_blank', rel: 'noopener' },
      h('span', { class: 'ic' }, it.key ? '🔑' : '📄'), h('div', null, h('b', null, it.t)), h('span', { class: 'chev' }, '↗')))));
  }
}

function Notes(root, id) {
  if (id) {
    const n = S.notes.find((x) => x.id === id);
    if (!n) { go('#/notes'); return; }
    root.append(h('a', { class: 'backlink', href: '#/notes' }, '‹ Notes'), h('h1', { class: 'title' }, `${n.icon} ${n.title}`),
      h('article', { class: 'card note', html: n.html }));
    return;
  }
  root.append(h('h1', { class: 'title' }, 'Notes'), h('div', { class: 'list' }, S.notes.map((n) =>
    h('a', { class: 'item', href: `#/notes/${n.id}` }, h('span', { class: 'ic' }, n.icon), h('div', null, h('b', null, n.title)), h('span', { class: 'chev' }, '›')))));
}

function Stats(root) {
  const days = Object.values(S.p.days);
  const tot = days.reduce((a, d) => ({ n: a.n + d.n, ok: a.ok + d.ok, ms: a.ms + d.ms }), { n: 0, ok: 0, ms: 0 });
  root.append(h('h1', { class: 'title' }, 'Stats'),
    h('section', { class: 'card rings' },
      ring(Math.min(100, streak() * 20), streak(), 'day streak'),
      ring(pct(tot.ok, tot.n), `${pct(tot.ok, tot.n)}%`, 'all-time accuracy'),
      ring(Math.min(100, pct(tot.n, 3000)), tot.n, 'answers'),
      ring(Math.min(100, pct(tot.ms, 24 * 36e5)), `${Math.round(tot.ms / 36e5 * 10) / 10}h`, 'focused time')));
  const s = sectionStats(), L = learnedBySection();
  const t = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Section'), h('th', null, 'Accuracy'), h('th', null, 'Answered'), h('th', null, 'Learned')));
  Object.entries(SECTIONS).forEach(([k, label]) => t.append(h('tr', null, h('td', null, label),
    h('td', null, s[k].n ? `${pct(s[k].ok, s[k].n)}%` : '–'), h('td', null, s[k].n), h('td', null, `${L[k].learned}/${L[k].total}`))));
  root.append(h('h2', { class: 'sub' }, 'By section'), h('div', { class: 'card' }, t));
  const chart = h('div', { class: 'chart' });
  const dd = new Date();
  dd.setDate(dd.getDate() - 6);
  const week = [];
  for (let i = 0; i < 7; i++) { const k = dd.toLocaleDateString('en-CA'); week.push([k, S.p.days[k] || { n: 0, ok: 0 }]); dd.setDate(dd.getDate() + 1); }
  const max = Math.max(20, ...week.map(([, d]) => d.n));
  week.forEach(([k, d]) => chart.append(h('div', { class: 'col' }, h('i', { style: `height:${pct(d.n, max)}%` }), h('b', null, d.n),
    h('small', null, new Date(`${k}T12:00:00`).toLocaleDateString('en', { weekday: 'short' })))));
  root.append(h('h2', { class: 'sub' }, 'Last 7 days'), h('div', { class: 'card' }, chart));
}

function Settings(root) {
  const st = S.p.settings;
  const set = (k, v) => { st[k] = v; saveProgress(); applySettings(); };
  const num = h('input', { type: 'number', min: 10, max: 2000, step: 10, value: st.newPerDay, onchange: (e) => set('newPerDay', Math.max(10, Number(e.target.value) || 200)) });
  const cap = h('select', { onchange: (e) => set('cap', Number(e.target.value)) }, [2, 3, 4, 7].map((d) => h('option', { value: d, selected: st.cap === d }, `${d} days`)));
  const theme = h('select', { onchange: (e) => set('theme', e.target.value) }, [['auto', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']].map(([v, t]) => h('option', { value: v, selected: st.theme === v }, t)));
  const font = h('input', { type: 'range', min: 85, max: 130, step: 5, value: st.font, oninput: (e) => set('font', Number(e.target.value)) });
  const toggle = (k, label) => h('label', { class: 'switch' }, h('span', null, label), h('input', { type: 'checkbox', checked: !!st[k], onchange: (e) => set(k, e.target.checked) }));
  const dl = h('div', { class: 'muted' });
  const dlBtn = btn('Download all images for offline', () => downloadAll(dl, dlBtn), 'primary wide');
  const storage = h('small', { class: 'muted' });
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then((e) => { storage.textContent = `Using ${(e.usage / 1e6).toFixed(0)} MB of storage on this device.`; });
  const file = h('input', { type: 'file', accept: 'application/json', hidden: true, onchange: async (e) => {
    try { importProgress(await e.target.files[0].text()); toast('Progress restored'); route(); } catch (err) { toast(`Import failed: ${err.message}`); }
  } });
  root.append(h('h1', { class: 'title' }, 'Settings'),
    h('div', { class: 'card form' },
      h('label', null, 'New cards per day', num), h('label', null, 'Longest gap before a review', cap),
      h('label', null, 'Theme', theme), h('label', null, 'Text size', font),
      toggle('invert', 'Dark-mode question pictures'), toggle('haptics', 'Vibrate on a wrong answer')),
    h('h2', { class: 'sub' }, 'Offline'),
    h('div', { class: 'card form' }, h('p', { class: 'muted' }, `${S.meta.media} question pictures (about 55 MB). Download once on Wi-Fi and the whole app works without internet.`), dlBtn, dl, storage),
    h('h2', { class: 'sub' }, 'Backup'),
    h('div', { class: 'card form' },
      h('p', { class: 'muted' }, 'Progress is stored only on this device. Export it now and then.'),
      h('div', { class: 'row' },
        btn('Export progress', () => {
          const a = h('a', { href: URL.createObjectURL(exportProgress()), download: `vao-progress-${today()}.json` });
          document.body.append(a); a.click(); a.remove();
        }),
        btn('Import progress', () => file.click()), file,
        btn('Reset progress', async () => {
          if (await ask('Erase all progress, mistakes and mock results on this device?', { ok: 'Erase', danger: true })) { resetProgress(); toast('Progress reset'); route(); }
        }, 'danger'))),
    h('p', { class: 'foot' }, `Question bank built ${new Date(S.meta.built).toLocaleString()} · ${S.meta.cards} questions`));
}

async function downloadAll(out, button) {
  if (!('caches' in window)) { out.textContent = 'This browser cannot store files offline.'; return; }
  button.disabled = true;
  const urls = [...new Set(S.cards.flatMap((c) => [...(c.img || []), ...(c.ib || [])]))];
  const cache = await caches.open('vao-media');
  let done = 0, failed = 0, idx = 0;
  const worker = async () => {
    while (idx < urls.length) {
      const u = urls[idx++];
      try {
        const abs = new URL(u, location.href).href;
        if (!(await cache.match(abs))) {
          const res = await fetch(abs);
          if (res.ok) await cache.put(abs, res); else failed += 1;
        }
      } catch { failed += 1; }
      done += 1;
      if (done % 20 === 0 || done === urls.length) out.textContent = `Saved ${done} / ${urls.length}${failed ? ` (${failed} failed, tap again to retry)` : ''}`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  button.disabled = false;
  out.textContent = failed ? `Done with ${failed} failures. Tap again to retry.` : `All ${urls.length} pictures saved. The app now works offline.`;
}

function applySettings() {
  const st = S.p.settings;
  document.documentElement.dataset.theme = st.theme;
  document.documentElement.dataset.invert = st.invert ? '1' : '0';
  document.documentElement.style.fontSize = `${st.font}%`;
}

// ---------- boot ----------
async function boot() {
  loadProgress();
  applySettings();
  tickCountdown();
  setInterval(tickCountdown, 30e3);
  try {
    await loadData();
  } catch (e) {
    view.replaceChildren(h('div', { class: 'empty' }, h('p', null, 'Could not load the question bank.'), h('small', null, String(e.message)),
      btn('Retry', () => location.reload(), 'primary')));
    return;
  }
  addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('A new version of VAO Prep is ready.', { label: 'Reload', run: () => location.reload() });
    });
  }
}
boot();
