'use strict';

var $ = function (sel) { return document.querySelector(sel); };
var NOTES_KEY = 'notesaathi.notes';
var NEXT_KEY = 'notesaathi.nextFrom';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* Turns the AI's [[k:...]] marks into coloured ink. Text is escaped first. */
function ink(s) {
  var h = esc(s);
  h = h.replace(/\[\[([kdnu]):([\s\S]+?)\]\]/g, function (m, kind, text) {
    return '<span class="hl hl-' + kind + '">' + text + '</span>';
  });
  h = h.replace(/\*\*(.+?)\*\*/g, '<span class="hl hl-k">$1</span>');
  return h.replace(/\[\[[kdnu]:|\]\]/g, '');
}

/* Exact-transcription pages: plain lines, **underlined** as bold, ~~struck out~~ as strike-through. */
function exactLine(line) {
  var h = esc(line);
  h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/~~(.+?)~~/g, '<s>$1</s>');
  return '<div class="exact-line">' + h + '</div>';
}

/*
 * The transcription comes back with one line per handwritten line. Handwritten lines are short,
 * so printing them one per row leaves most of the page width empty. This joins the lines of a
 * paragraph back into running text, without changing a word.
 *
 * A line is joined to the one before it only when that earlier line ran to the edge of the
 * writer's page (it is about as long as the page's longest lines), which is the sign that the
 * writer wrapped mid-sentence. Short lines, numbered points, bullets, arrows, headings and blank
 * lines always start a new row, so lists and structure stay as written.
 */
function exactBlocks(body) {
  var lines = String(body || '').replace(/\s+$/, '').split('\n');
  var lengths = lines.map(function (l) { return l.trim().length; })
    .filter(function (n) { return n > 0; }).sort(function (x, y) { return x - y; });
  var longest = lengths.length ? lengths[Math.floor((lengths.length - 1) * 0.9)] : 0;
  var fullLine = Math.max(24, longest * 0.72);
  var STARTS_NEW = /^(?:\d{1,3}[.)]\s|\(?[a-zA-Z]\)\s|\(?[ivxIVX]{1,4}\)\s|[-•·→↓⇒➔>✓]|\*\s)/;
  var blocks = [];
  var current = -1;
  var previousWasFull = false;
  lines.forEach(function (raw) {
    var t = raw.trim();
    if (!t) { current = -1; previousWasFull = false; return; }
    var heading = /^\*\*[^*]+\*\*:?$/.test(t) || (/:$/.test(t) && t.length < 60);
    if (current >= 0 && previousWasFull && !heading && !STARTS_NEW.test(t)) {
      blocks[current] += ' ' + t;
    } else {
      blocks.push(t);
      current = blocks.length - 1;
    }
    previousWasFull = !heading && t.length >= fullLine;
  });
  return blocks;
}

function exactHtml(text) {
  var all = String(text || '').replace(/\r/g, '');
  var cut = all.search(/^\s*\**\s*DOUBTFUL POINTS\s*:?\s*\**\s*$/mi);
  var body = cut >= 0 ? all.slice(0, cut) : all;
  var doubts = cut >= 0 ? all.slice(cut).split('\n') : [];
  var html = exactBlocks(body).map(exactLine).join('');
  doubts = doubts.map(function (l) { return l.replace(/^\s*[-•*]\s*/, '').trim(); })
    .filter(function (l) { return l && !/^\**\s*DOUBTFUL POINTS\s*:?\s*\**$/i.test(l); });
  // "None" means nothing to flag, so it takes no space at all
  doubts = doubts.filter(function (l) { return !/^none\.?$/i.test(l); });
  if (doubts.length) {
    // one small run-on paragraph instead of a boxed list, to save paper
    html += '<div class="doubt"><b>⚠ Doubtful:</b> ' +
      doubts.map(function (l, i) { return (doubts.length > 1 ? '(' + (i + 1) + ') ' : '') + esc(l); }).join(' ') +
      '</div>';
  }
  return html;
}

function pageTitle(d) {
  if (!d) return '';
  if (d.exact) {
    var first = String(d.text || '').split('\n').filter(function (l) { return l.trim(); })[0] || '';
    return first.replace(/\*\*|~~/g, '').trim().slice(0, 40);
  }
  return d.title || '';
}

function list(v) {
  if (Array.isArray(v)) return v.filter(function (x) { return x != null && String(x).trim() !== ''; });
  if (v == null || v === '') return [];
  return [v];
}

var AI_PROVIDERS = ['gemini', 'claude', 'deepseek', 'openrouter'];

var DEFAULT_EXACT_PROMPT = `You transcribe handwritten Indian law notes (LLB/LLM level) exactly as written, then flag doubtful facts.

TRANSCRIPTION RULES
1. Copy the writer's words verbatim. Do NOT paraphrase, summarise, reorder, or add explanations, definitions or headings that are not on the page.
2. Keep every negative exactly: can't, not, no, never. Double-check these.
3. Keep the writer's abbreviations as-is: R8 = right, ICA, TPA, SOGA, b/w, eg, i.e., S. = Section.
4. Hindi/Punjabi words: write them in the original script, then a short English meaning in [ ].
5. Numbers and years: copy digit by digit. If a digit is unclear, write your best reading followed by (?). Never correct a year or fact inside the transcription.
6. Case names and Acts: use this list to resolve unclear spellings. If a word clearly matches one, use it:
   Luke v Lyde, Slade v Morley, Humber Ferryman's Case, Pacta Sunt Servanda, Assumpsit, Quid Pro Quo, Magna Carta, Indian Contract Act 1872, Transfer of Property Act (TPA), Sale of Goods Act (SOGA), Specific Relief Act, NDPS Act, Vyavaharmayukha, Smritis, Shrutis.
7. Unreadable word: write [?]. Struck-out word: ~~word~~.
8. Arrows (→ ↓) and numbering (1, 2, 3): keep them as written.

OUTPUT FORMAT
- Plain text, one line per handwritten line or bullet.
- Use **bold** only where the writer underlined or highlighted.
- No intro, no closing remarks, no page titles, no summary.

After the transcription, write:
DOUBTFUL POINTS
- List only facts, dates, case names or section numbers in the notes that may be legally or historically wrong. Give the likely correct version. Max 1 line each, max 5 items.
- If nothing is doubtful, write "None".
- Do not change the transcription itself.`;

/* ───────── model catalogue ─────────
   pin / pout: US$ per million tokens (public price lists, November 2026).
   read: how well the model is expected to read handwritten notes. A general guide, not measured. */
var MODELS = {
  gemini: [
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite (older accounts only)', pin: 0.1, pout: 0.4, read: 'good' },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', pin: 0.25, pout: 1.5, read: 'good' },
    { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', pin: 0.3, pout: 2.5, read: 'good' },
    { id: 'gemini-flash-latest', name: 'Gemini Flash', pin: 0.75, pout: 3.75, read: 'very good' },
    { id: 'gemini-pro-latest', name: 'Gemini Pro', pin: 2, pout: 12, read: 'excellent' }
  ],
  claude: [
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', pin: 0.1, pout: 0.5, read: 'good' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', pin: 2, pout: 10, read: 'excellent' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', pin: 4, pout: 20, read: 'excellent' }
  ],
  deepseek: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', pin: 0.28, pout: 0.42, read: 'printed text only' },
    { id: 'deepseek-flash', name: 'DeepSeek Flash', pin: 0.3, pout: 1.2, read: 'basic' }
  ],
  openrouter: [
    { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 (free)', pin: 0, pout: 0, read: 'basic' },
    { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', pin: 0.0507, pout: 0.2028, read: 'basic' },
    { id: 'google/gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', pin: 0.1, pout: 0.4, read: 'good' },
    { id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5', pin: 0.1, pout: 0.5, read: 'good' },
    { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', pin: 0.25, pout: 1.5, read: 'good' },
    { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', pin: 0.825, pout: 4.125, read: 'very good' },
    { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', pin: 2, pout: 10, read: 'excellent' }
  ]
};
var COST_SAVING_MODEL = 'gemini-3.1-flash-lite'; // same name as COST_SAVING_GEMINI_MODEL in Ai.kt
var TYPICAL_IN = 1800, TYPICAL_OUT = 1500; // tokens for an ordinary page of notes

function findModel(provider, id) {
  return (MODELS[provider] || []).filter(function (m) { return m.id === id; })[0] || null;
}

function perPage(m, rate) {
  return (TYPICAL_IN * m.pin + TYPICAL_OUT * m.pout) / 1e6 * rate;
}

/* Fills the four model dropdowns and selects the saved model in each. */
function fillModelPicks(st) {
  var rate = Number(st.usdInr) > 0 ? Number(st.usdInr) : DEFAULT_USD_INR;
  Object.keys(MODELS).forEach(function (provider) {
    var pick = $('#' + provider + 'ModelPick');
    var input = $('#' + provider + 'Model');
    var list = MODELS[provider].slice().sort(function (x, y) { return perPage(x, rate) - perPage(y, rate); });
    pick.innerHTML = list.map(function (m) {
      var cost = perPage(m, rate);
      return '<option value="' + esc(m.id) + '">' + esc(m.name) + ' · ' +
        (cost > 0 ? 'about ' + money(cost) + ' a page' : 'free') + ' · handwriting: ' + esc(m.read) + '</option>';
    }).join('') + '<option value="">Other (type the model name)</option>';
    var known = !!findModel(provider, input.value);
    pick.value = known ? input.value : '';
    $('#' + provider + 'ModelCustom').classList.toggle('hidden', known);
    showModelInfo(provider);
  });
}

/* The closed dropdown cuts long text short, so the chosen model's price and rating go underneath. */
function showModelInfo(provider) {
  var pick = $('#' + provider + 'ModelPick');
  var info = $('#' + provider + 'ModelInfo');
  if (!info) {
    info = document.createElement('div');
    info.id = provider + 'ModelInfo';
    info.className = 'model-info';
    pick.parentNode.appendChild(info);
  }
  var opt = pick.options[pick.selectedIndex];
  info.textContent = pick.value && opt ? opt.textContent.split(' · ').slice(1).join(' · ') : '';
}

function onModelPick(pick) {
  var provider = pick.getAttribute('data-pick');
  var input = $('#' + provider + 'Model');
  var custom = pick.value === '';
  $('#' + provider + 'ModelCustom').classList.toggle('hidden', !custom);
  if (custom) { input.value = ''; input.focus(); }
  else input.value = pick.value;
  showModelInfo(provider);
  input.dispatchEvent(new Event('change'));
}

/* ───────── cost ───────── */
/* Built-in prices in US$ per million tokens [input, output]; editable in Settings. */
function defaultPrices(st) {
  var listed = findModel(st.provider, st[st.provider + 'Model'] || st['default' + st.provider.charAt(0).toUpperCase() + st.provider.slice(1) + 'Model']);
  if (listed) return [listed.pin, listed.pout];
  if (st.provider === 'openrouter') return [0.25, 1.5];
  if (st.provider === 'deepseek') return (st.deepseekModel || '').indexOf('chat') >= 0 ? [0.28, 0.42] : [0.3, 1.2];
  if (st.provider === 'claude') {
    var m = st.claudeModel || st.defaultClaudeModel || '';
    if (m.indexOf('haiku') >= 0) return [0.1, 0.5];
    if (m.indexOf('sonnet') >= 0) return [2, 10];
    if (m.indexOf('fable') >= 0 || m.indexOf('mythos') >= 0) return [8, 40];
    return [4, 20];
  }
  var g = st.geminiModel || st.defaultGeminiModel || '';
  if (g.indexOf('lite') >= 0) return [0.3, 2.5];
  if (g.indexOf('pro') >= 0) return [2, 10];
  return [0.75, 3.75];
}
var DEFAULT_USD_INR = 94;
var DEFAULT_USD_CNY = 6.7;

/* A balance change in the account's own currency, shown with its rupee value. */
function spentText(spent) {
  var st = readSettings();
  var inr = Number(st.usdInr) > 0 ? Number(st.usdInr) : DEFAULT_USD_INR;
  var cny = Number(st.usdCny) > 0 ? Number(st.usdCny) : DEFAULT_USD_CNY;
  var rupees = spent.currency === 'CNY' ? spent.amount * inr / cny : spent.amount * inr;
  var sym = spent.currency === 'CNY' ? '¥' : '$';
  return sym + spent.amount.toFixed(4) + ' (' + money(rupees) + ')';
}

function rupeesFor(usage) {
  var st = readSettings();
  if (!usage || AI_PROVIDERS.indexOf(st.provider) < 0) return 0;
  var rateNow = Number(st.usdInr) > 0 ? Number(st.usdInr) : DEFAULT_USD_INR;
  if (usage.usd > 0) return usage.usd * rateNow; // the service reported the real charge
  var d = defaultPrices(st);
  var pin = Number(st.priceIn) > 0 ? Number(st.priceIn) : d[0];
  var pout = Number(st.priceOut) > 0 ? Number(st.priceOut) : d[1];
  var rate = Number(st.usdInr) > 0 ? Number(st.usdInr) : DEFAULT_USD_INR;
  return ((usage.in || 0) * pin + (usage.out || 0) * pout) / 1e6 * rate;
}
function money(r) { return '₹' + (r >= 100 ? r.toFixed(0) : r.toFixed(2)); }
function tokens(n) { return Number(n || 0).toLocaleString('en-IN'); }
function addUsage(total, u) {
  if (!u) return;
  total.in = (total.in || 0) + (u.in || 0);
  total.out = (total.out || 0) + (u.out || 0);
  total.think = (total.think || 0) + (u.think || 0);
  if (u.usd >= 0) total.usd = (total.usd || 0) + u.usd;
}
function costSavingOn() {
  var st = readSettings();
  return st.provider === 'gemini' && st.costSaving === 'on';
}

function isAi() {
  return AI_PROVIDERS.indexOf(readSettings().provider) >= 0;
}

/* ───────── saved notes ───────── */
var notes = [];
function loadNotes() {
  var raw = Android.loadData('notes');
  if (!raw) { try { raw = localStorage.getItem(NOTES_KEY) || ''; } catch (e) { raw = ''; } } // from versions before 1.0.5
  try { notes = JSON.parse(raw || '[]') || []; } catch (e) { notes = []; }
}
function persistNotes() {
  if (!Android.saveData('notes', JSON.stringify(notes))) {
    toast('Could not save. The phone may be out of storage.');
    return;
  }
  try { localStorage.removeItem(NOTES_KEY); } catch (e) {}
}

/* ───────── views ───────── */
var currentView = 'home';
var currentNote = null;
function show(view) {
  currentView = view;
  ['home', 'note', 'settings'].forEach(function (v) {
    $('#view-' + v).classList.toggle('hidden', v !== view);
  });
  window.scrollTo(0, 0);
}
/* In-app yes/no box. The browser's own confirm() does not show inside the app. */
var modalYes = null;
function ask(message, yesLabel, onYes) {
  $('#modal-text').textContent = message;
  $('#modal-yes').textContent = yesLabel;
  modalYes = onYes;
  $('#modal').classList.remove('hidden');
}
function closeModal() {
  $('#modal').classList.add('hidden');
  modalYes = null;
}

window.onBack = function () {
  if (!$('#modal').classList.contains('hidden')) { closeModal(); return true; }
  if (currentView === 'home') return false;
  if (currentNote && currentNote.preview) currentNote = null;
  show('home');
  renderLiveBar();
  renderNotesList();
  return true;
};

var toastTimer = null;
function toast(msg) {
  var t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 5000);
}

/* ───────── home: source pages ───────── */
function renderPages() {
  var n = Android.pageCount();
  $('#pages-box').classList.toggle('hidden', n === 0 || !!job);
  $('#empty-hint').classList.toggle('hidden', n > 0 || !!job);
  $('#pages-count').textContent = n + (n === 1 ? ' page ready' : ' pages ready');
  // which pages to do: defaults to "the rest", starting after the last page done earlier
  var nextFrom = 1;
  try { nextFrom = Number(localStorage.getItem(NEXT_KEY)) || 1; } catch (e) { nextFrom = 1; }
  if (nextFrom < 1 || nextFrom > n) nextFrom = 1;
  $('#range-row').classList.toggle('hidden', n < 2);
  $('#range-from').value = nextFrom;
  $('#range-to').value = n;
  $('#range-of').textContent = 'of ' + n;
  var box = $('#thumbs');
  box.innerHTML = '';
  var shown = Math.min(n, 24);
  for (var i = 0; i < shown; i++) {
    var d = document.createElement('div');
    d.className = 'thumb';
    d.innerHTML = '<img alt=""><span class="thumb-n">' + (i + 1) + '</span>' +
      '<button class="thumb-x" data-i="' + i + '" aria-label="Remove page ' + (i + 1) + '">✕</button>';
    box.appendChild(d);
  }
  if (n > shown) {
    var more = document.createElement('div');
    more.className = 'thumb thumb-more';
    more.textContent = '+' + (n - shown);
    box.appendChild(more);
  }
  // fill pictures one at a time so the screen stays responsive
  var imgs = box.querySelectorAll('img');
  var k = 0;
  (function next() {
    if (k >= imgs.length) return;
    imgs[k].src = Android.thumb(k);
    k++;
    setTimeout(next, 0);
  })();
}

function renderNotesList() {
  var box = $('#notes-list');
  if (!notes.length) {
    box.innerHTML = '<div class="empty">Nothing saved yet. Your finished notes will appear here.</div>';
    return;
  }
  box.innerHTML = notes.map(function (n) {
    var d = new Date(n.created);
    var when = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    var count = n.pages.length + (n.pages.length === 1 ? ' page' : ' pages') + (n.rupees ? ' · ' + money(n.rupees) : '');
    return '<div class="note-row" data-id="' + n.id + '"><span class="note-row-ico">📒</span><div>' +
      '<div class="note-row-title">' + esc(n.title) + '</div>' +
      '<div class="note-row-meta">' + count + ' · ' + esc(when) + '</div></div></div>';
  }).join('');
}

/* ───────── making notes ───────── */
var job = null;

function hasKey() {
  var s = readSettings();
  if (s.provider === 'claude') return !!s.claudeKey;
  if (s.provider === 'gemini') return !!s.geminiKey;
  if (s.provider === 'deepseek') return !!s.deepseekKey;
  if (s.provider === 'openrouter') return !!s.openrouterKey;
  return true; // on-device mode needs no key
}

/* from / to are page positions counted from 0, both included */
function newJob(n, from, to) {
  return {
    n: n, from: from || 0, to: to == null ? n - 1 : to,
    results: new Array(n), errors: {}, pending: [], active: 0, paused: false, reason: '', streak: 0,
    usage: { in: 0, out: 0 }, margins: {}, pageUsage: {}
  };
}

/* Progress is written after every page, so a long run survives the app being closed. */
function saveJob() {
  Android.saveData('job', job ? JSON.stringify({ n: job.n, from: job.from, to: job.to, results: job.results, usage: job.usage, margins: job.margins, pageUsage: job.pageUsage, balanceStart: job.balanceStart }) : '');
}

function restoreJob() {
  var saved = null;
  try { saved = JSON.parse(Android.loadData('job') || 'null'); } catch (e) { saved = null; }
  if (!saved || !saved.n || saved.n !== Android.pageCount()) { Android.saveData('job', ''); return; }
  job = newJob(saved.n, saved.from, saved.to);
  if (saved.usage) job.usage = saved.usage;
  if (saved.margins) job.margins = saved.margins;
  if (saved.pageUsage) job.pageUsage = saved.pageUsage;
  if (saved.balanceStart) job.balanceStart = saved.balanceStart;
  for (var i = job.from; i <= job.to; i++) {
    if (saved.results && saved.results[i]) job.results[i] = saved.results[i];
    else job.pending.push(i);
  }
  job.paused = true;
  job.reason = 'This run was interrupted. Tap Continue to carry on from where it stopped.';
  if (!job.pending.length) finishJob();
}

function awake(on) { Android.keepAwake(!!on); }

function startJob() {
  var n = Android.pageCount();
  if (!n) return;
  if (!hasKey()) {
    toast('First add your AI key in Settings.');
    openSettings();
    return;
  }
  var from = 1, to = n;
  if (n > 1) {
    from = Number($('#range-from').value);
    to = Number($('#range-to').value);
    var whole = from === Math.floor(from) && to === Math.floor(to);
    if (!whole || from < 1 || to > n || from > to) {
      toast('Choose page numbers between 1 and ' + n + ', with the first not after the last.');
      return;
    }
  }
  job = newJob(n, from - 1, to - 1);
  if (readSettings().provider === 'deepseek') Android.deepseekBalance('start');
  for (var i = job.from; i <= job.to; i++) job.pending.push(i);
  renderPages();
  pump();
}

function pump() {
  while (!job.paused && job.active < 2 && job.pending.length) {
    var i = job.pending.shift();
    delete job.errors[i];
    job.active++;
    Android.transcribe(i);
  }
  awake(job.active > 0);
  renderJob();
}

function renderJob() {
  var box = $('#job');
  if (!job) { box.classList.add('hidden'); renderLiveBar(); return; }
  box.classList.remove('hidden');
  var total = job.to - job.from + 1;
  var done = 0;
  for (var i = job.from; i <= job.to; i++) if (job.results[i]) done++;
  var failedKeys = Object.keys(job.errors);
  var left = job.pending.length;
  var running = job.active > 0 || (!job.paused && left > 0);
  $('#job-spin').classList.toggle('hidden', !running);
  $('#job-bar').style.width = Math.round((done / total) * 100) + '%';
  $('#job-text').textContent = running
    ? 'Reading and writing your notes… ' + done + ' of ' + total + ' pages done' + (job.paused ? ' (stopping)' : '')
    : done + ' of ' + total + ' pages done. ' + (job.reason || (failedKeys.length + ' could not be done.'));
  var shownErrors = failedKeys.slice(-4).map(function (k) {
    return '<div>Page ' + (Number(k) + 1) + ': ' + esc(job.errors[k]) + '</div>';
  });
  if (failedKeys.length > 4) shownErrors.push('<div>…and ' + (failedKeys.length - 4) + ' more pages failed.</div>');
  $('#job-errors').innerHTML = shownErrors.join('');
  var spent = rupeesFor(job.usage);
  $('#job-cost').textContent = spent > 0
    ? 'API cost so far: about ' + money(spent) + (done ? ' (' + money(spent / done) + ' per page)' : '')
    : '';
  $('#job-actions').classList.toggle('hidden', running || (failedKeys.length === 0 && left === 0));
  $('#btn-keep').classList.toggle('hidden', done === 0);
  $('#btn-read').classList.toggle('hidden', done === 0);
  $('#btn-pause').classList.toggle('hidden', !running || job.paused);
  renderLiveBar();
}

function onPageDone(d) {
  if (!job) return;
  job.active--;
  if (d.ok) {
    addUsage(job.usage, d.data._usage);
    if (d.data._usage) job.pageUsage[d.index] = d.data._usage;
    delete d.data._usage;
    job.results[d.index] = d.data;
    job.streak = 0;
    saveJob();
  } else {
    job.errors[d.index] = d.error || 'Something went wrong.';
    job.streak++;
    if (job.streak >= 4 && !job.paused) {
      job.paused = true;
      job.reason = 'Stopped because several pages failed in a row. If it is a usage limit, wait a while and tap Continue.';
    }
  }
  pump();
  if (job.active === 0 && !job.pending.length && !Object.keys(job.errors).length) finishJob();
}

function pauseJob() {
  if (!job || job.paused) return;
  job.paused = true;
  job.reason = 'Paused. Tap Continue when you want the rest.';
  pump();
}

/* Reading the pages that are already done while the rest are still being worked on. */
function doneCount() {
  var done = 0;
  for (var i = job.from; i <= job.to; i++) if (job.results[i]) done++;
  return done;
}

function openPreview(keepScroll) {
  if (!job) return;
  var y = window.pageYOffset;
  var pages = [];
  for (var i = job.from; i <= job.to; i++) {
    if (job.results[i]) pages.push({ source: i + 1, data: job.results[i], margin: job.margins[i] || '', usage: job.pageUsage[i] || null });
  }
  if (!pages.length) return;
  currentNote = { id: 'preview', preview: true, title: 'Pages done so far', pages: pages };
  renderCurrentNote();
  if (keepScroll) window.scrollTo(0, y);
}

function renderLiveBar() {
  var bar = $('#live-bar');
  var on = !!(job && currentNote && currentNote.preview && currentView === 'note');
  bar.classList.toggle('hidden', !on);
  if (!on) return;
  var total = job.to - job.from + 1;
  var done = doneCount();
  var running = job.active > 0 || (!job.paused && job.pending.length > 0);
  var fresh = done - currentNote.pages.length;
  $('#live-spin').classList.toggle('hidden', !running);
  $('#live-text').textContent = done + ' of ' + total + ' pages ready' +
    (running ? ', still working' : ', paused') + (fresh > 0 ? ' · ' + fresh + ' new' : '');
  $('#btn-live').classList.toggle('hidden', fresh <= 0);
}

function continueJob() {
  if (!job) return;
  job.pending = job.pending.concat(Object.keys(job.errors).map(Number)).sort(function (x, y) { return x - y; });
  job.errors = {};
  job.paused = false;
  job.reason = '';
  job.streak = 0;
  pump();
}

function discardJob() {
  if (!job) return;
  ask('Cancel this run? The pages already done in it will be thrown away.', 'Yes, cancel run', function () {
    job = null;
    saveJob();
    awake(false);
    renderJob();
    renderPages();
  });
}

function finishJob() {
  var pages = [];
  for (var i = job.from; i <= job.to; i++) {
    if (job.results[i]) pages.push({ source: i + 1, data: job.results[i], margin: job.margins[i] || '', usage: job.pageUsage[i] || null });
  }
  var partial = job.from > 0 || job.to < job.n - 1;
  var reachedEnd = job.to >= job.n - 1;
  var rangeLabel = ' (pages ' + (job.from + 1) + '–' + (job.to + 1) + ')';
  var nextStart = job.to + 2;
  var usage = job.usage;
  var balanceStart = job.balanceStart || null;
  job = null;
  saveJob();
  awake(false);
  renderJob();
  if (!pages.length) { renderPages(); return; }
  var first = pages.filter(function (p) { return !p.data.unreadable; })[0];
  var note = {
    id: Date.now(),
    title: (pageTitle(first && first.data) || 'My notes') + (partial ? rangeLabel : ''),
    created: Date.now(),
    pages: pages,
    usage: usage,
    balanceStart: balanceStart,
    rupees: rupeesFor(usage),
    needsTopics: isAi() && readSettings().stories !== 'off' && !(first && first.data.exact) && !costSavingOn()
  };
  notes.unshift(note);
  persistNotes();
  Android.log('run total: pages=' + pages.length + ' promptTokenCount=' + (usage.in || 0) +
    ' candidatesTokenCount=' + ((usage.out || 0) - (usage.think || 0)) + ' thoughtsTokenCount=' + (usage.think || 0));
  if (reachedEnd) {
    // the last page is done: the source pages are no longer needed
    Android.clearPages();
    try { localStorage.removeItem(NEXT_KEY); } catch (e) {}
  } else {
    // pages after this range are kept so the next range can be done later
    try { localStorage.setItem(NEXT_KEY, String(nextStart)); } catch (e) {}
  }
  renderPages();
  renderNotesList();
  var readingAt = (currentView === 'note' && currentNote && currentNote.preview) ? window.pageYOffset : null;
  openNote(note.id);
  if (readingAt !== null) window.scrollTo(0, readingAt);
  if (note.needsTopics) startTopics(note);
  else askEndBalance(note);
}

/* ───────── topics: one memory story per topic, written after all pages are read ───────── */
var topicsBusy = {};

function plain(s) { return String(s == null ? '' : s).replace(/\[\[[kdnu]:|\]\]/g, ''); }

function startTopics(note) {
  if (topicsBusy[note.id]) return;
  var digest = [];
  note.pages.forEach(function (p, i) {
    var d = p.data || {};
    if (d.unreadable || d.exact) return;
    var points = [];
    var headings = [];
    list(d.sections).forEach(function (sec) {
      if (typeof sec === 'string') { points.push(plain(sec)); return; }
      if (sec.heading) headings.push(plain(sec.heading));
      list(sec.points).forEach(function (pt) { points.push(plain(pt)); });
    });
    digest.push({
      page: i + 1,
      title: plain(d.title || ''),
      topic: plain(d.topic || ''),
      headings: headings,
      points: points.join(' | ').slice(0, 900)
    });
  });
  if (!digest.length) { note.needsTopics = false; persistNotes(); return; }
  topicsBusy[note.id] = true;
  renderTopicsBar();
  Android.makeTopics(String(note.id), JSON.stringify(digest));
}

/* DeepSeek only: compare the account balance before and after to get the real amount charged. */
function askEndBalance(note) {
  if (note && note.balanceStart && !note.spent) Android.deepseekBalance('end:' + note.id);
}

function onBalance(d) {
  if (!d.ok) return;
  if (d.tag === 'start') {
    if (job && !job.balanceStart) { job.balanceStart = { amount: d.amount, currency: d.currency }; saveJob(); }
    return;
  }
  var id = Number(String(d.tag).replace('end:', ''));
  var note = notes.filter(function (n) { return n.id === id; })[0];
  if (!note || !note.balanceStart || note.balanceStart.currency !== d.currency) return;
  var used = note.balanceStart.amount - d.amount;
  if (used < 0) return; // topped up in between: the difference means nothing
  note.spent = { amount: used, currency: d.currency };
  persistNotes();
  if (currentNote && currentNote.id === id) renderNoteCost();
}

function onPrices(d) {
  var line = $('#price-status');
  var got = [];
  if (d.in != null && d.out != null) {
    $('#priceIn').value = Math.round(d.in * 10000) / 10000;
    $('#priceOut').value = Math.round(d.out * 10000) / 10000;
    got.push('price for ' + d.model);
  }
  if (d.inr) { $('#usdInr').value = Math.round(d.inr * 100) / 100; got.push('exchange rate'); }
  if (d.cny) $('#usdCny').value = Math.round(d.cny * 1000) / 1000;
  if (!got.length) {
    line.className = 'test-result bad';
    line.textContent = '✗ Could not fetch. Check the internet connection.';
    return;
  }
  line.className = 'test-result ok';
  line.textContent = '✓ Filled in: ' + got.join(' and ') + '.' +
    (d.in == null ? ' No listed price for ' + d.model + ', so that stays as it was.' : '') + ' Tap Save to keep.';
}

function onTopicsDone(d) {
  var id = Number(d.id);
  delete topicsBusy[id];
  var note = notes.filter(function (n) { return n.id === id; })[0];
  if (!note) return;
  if (!d.ok) {
    toast(d.error || 'Could not write the memory stories.');
    renderTopicsBar();
    askEndBalance(note);
    return;
  }
  note.pages.forEach(function (p) { delete p.topicTitle; delete p.topicStory; });
  var total = note.pages.length;
  list(d.data && d.data.topics).forEach(function (t) {
    var from = Math.round(Number(t.from)), to = Math.round(Number(t.to));
    if (!(from >= 1) || !(to >= from)) return;
    if (to > total) to = total;
    if (from > total) return;
    if (t.title) note.pages[from - 1].topicTitle = String(t.title);
    if (t.mnemonic && t.mnemonic.story) note.pages[to - 1].topicStory = t.mnemonic;
  });
  note.needsTopics = false;
  if (!note.usage) note.usage = { in: 0, out: 0 };
  var extra = d.data && d.data._usage;
  addUsage(note.usage, extra);
  note.rupees = (note.rupees || 0) + rupeesFor(extra);
  persistNotes();
  askEndBalance(note);
  if (currentNote && currentNote.id === id && currentView === 'note') {
    var y = window.pageYOffset;
    openNote(id);
    window.scrollTo(0, y);
  }
}

function renderTopicsBar() {
  var bar = $('#topics-bar');
  if (!currentNote) { bar.classList.add('hidden'); return; }
  var busy = !!topicsBusy[currentNote.id];
  var needed = !!currentNote.needsTopics;
  bar.classList.toggle('hidden', !busy && !needed);
  $('#topics-spin').classList.toggle('hidden', !busy);
  $('#btn-topics').classList.toggle('hidden', busy);
  $('#topics-text').textContent = busy
    ? 'Grouping pages into topics and writing a memory story for each…'
    : 'Memory stories for each topic are not written yet.';
}

function renderNoteCost() {
  var n = currentNote;
  var u = n && n.usage;
  if (!n || !n.rupees || !u) { $('#note-cost').textContent = ''; return; }
  $('#note-cost').textContent = 'API cost for this document: ' +
    (u.usd > 0 ? 'charged $' + u.usd.toFixed(4) + ', which is ' : 'about ') + money(n.rupees) +
    ' (' + money(n.rupees / n.pages.length) + ' per page) · ' + tokens(u.in) + ' tokens in, ' + tokens(u.out) + ' out' + (u.think ? ' (' + tokens(u.think) + ' of it thinking)' : '') +
    (n.spent ? ' · DeepSeek balance actually went down by ' + spentText(n.spent) : '');
}

/* ───────── note viewer ───────── */
function sheetHtml(page, index, total) {
  var d = page.data || {};
  var main = (page.topicTitle ? '<div class="topic-tag">Topic: ' + esc(page.topicTitle) + '</div>' : '') +
    '<div class="sheet-page">Page ' + (page.source || index + 1) +
    (d.language ? ' · from ' + esc(d.language) : '') + '</div>';

  if (d.unreadable) {
    main += '<h2 class="sheet-title">Could not read this page</h2>' +
      '<div class="unreadable">' + esc(d.reason || 'The picture was not clear enough.') + '</div>';
  } else if (d.exact) {
    main += exactHtml(d.text);
  } else {
    main += '<h2 class="sheet-title">' + ink(d.title || 'Notes') + '</h2>';
    list(d.sections).forEach(function (s) {
      if (typeof s === 'string') { main += '<ul><li>' + ink(s) + '</li></ul>'; return; }
      if (s.heading) main += '<h3>' + ink(s.heading) + '</h3>';
      main += '<ul>' + list(s.points).map(function (p) { return '<li>' + ink(p) + '</li>'; }).join('') + '</ul>';
    });
    var summary = list(d.summary);
    if (summary.length) {
      main += '<div class="box box-summary"><h4>📝 In short</h4><ul>' +
        summary.map(function (p) { return '<li>' + ink(p) + '</li>'; }).join('') + '</ul></div>';
    }
  }

  // the story sits at the end of its topic; older notes and the no-key mode carry one per page
  var m = page.topicStory || d.mnemonic;
  if (m && (m.story || m.title)) {
    var links = list(m.links);
    main += '<div class="box box-story"><h4>📖 ' +
      (page.topicStory ? 'Remember this topic with a story' : 'Remember it with a story') +
      (m.title ? ': ' + ink(m.title) : '') + '</h4><p>' + ink(m.story || '') + '</p>' +
      (links.length ? '<div class="story-links-title">How it connects</div><ul class="links">' +
        links.map(function (p) { return '<li>' + ink(p) + '</li>'; }).join('') + '</ul>' : '') +
      '</div>';
  }

  if (page.usage) {
    main += '<div class="page-tokens no-print">Tokens for this page: ' + tokens(page.usage.in) + ' in · ' +
      tokens((page.usage.out || 0) - (page.usage.think || 0)) + ' out · ' + tokens(page.usage.think) + ' thinking</div>';
  }
  if (d.ocr) {
    main += '<div class="basic-note no-print">The phone read the text of this page and the AI wrote it up from that, so handwriting may be misread.</div>';
  }
  if (d.basic) {
    main += '<div class="basic-note no-print">Made on this phone without AI. For handwriting, smoother English and story mnemonics, add an AI key in Settings.</div>';
  }

  return '<article class="sheet"><div class="sheet-main">' + main + '</div>' +
    '<aside class="sheet-margin"><div class="margin-label">✎ my notes</div>' +
    '<textarea data-page="' + index + '" placeholder="Write here…" aria-label="My notes for page ' + (index + 1) + '">' +
    esc(page.margin || '') + '</textarea></aside></article>';
}

function openNote(id) {
  currentNote = notes.filter(function (n) { return n.id === id; })[0] || null;
  if (!currentNote) return;
  renderCurrentNote();
}

function renderCurrentNote() {
  $('#note-title').textContent = currentNote.title;
  var total = currentNote.pages.length;
  $('#sheets').innerHTML = currentNote.pages.map(function (p, i) { return sheetHtml(p, i, total); }).join('');
  $('#btn-delete').classList.toggle('hidden', !!currentNote.preview);
  renderTopicsBar();
  renderNoteCost();
  show('note');
  renderLiveBar();
}

var marginTimer = null;
function onMarginInput(e) {
  var t = e.target;
  if (!currentNote || t.tagName !== 'TEXTAREA') return;
  var page = currentNote.pages[Number(t.getAttribute('data-page'))];
  page.margin = t.value;
  clearTimeout(marginTimer);
  if (currentNote.preview) {
    // still being worked on: keep the margin note with the run so it lands in the saved notes
    if (job) job.margins[page.source - 1] = t.value;
    marginTimer = setTimeout(saveJob, 600);
  } else {
    marginTimer = setTimeout(persistNotes, 600);
  }
}

/* ───────── settings ───────── */
var SETTING_IDS = ['geminiKey', 'geminiModel', 'claudeKey', 'claudeModel', 'deepseekKey', 'deepseekModel', 'openrouterKey', 'openrouterModel', 'mnemonicStyle', 'subject', 'outputMode', 'customPrompt', 'priceIn', 'priceOut', 'usdInr', 'usdCny'];

function readSettings() {
  try { return JSON.parse(Android.getSettings() || '{}') || {}; } catch (e) { return {}; }
}

function openSettings() {
  var s = readSettings();
  var provider = s.provider || 'offline';
  document.querySelectorAll('input[name=provider]').forEach(function (r) { r.checked = r.value === provider; });
  $('#geminiKey').value = s.geminiKey || '';
  $('#claudeKey').value = s.claudeKey || '';
  $('#geminiModel').value = s.geminiModel || s.defaultGeminiModel || '';
  $('#claudeModel').value = s.claudeModel || s.defaultClaudeModel || '';
  $('#deepseekKey').value = s.deepseekKey || '';
  $('#deepseekModel').value = s.deepseekModel || s.defaultDeepseekModel || '';
  $('#openrouterKey').value = s.openrouterKey || '';
  $('#openrouterModel').value = s.openrouterModel || s.defaultOpenrouterModel || '';
  $('#mnemonicStyle').value = s.mnemonicStyle || 'mix';
  $('#subject').value = s.subject || '';
  $('#outputMode').value = s.outputMode === 'exact' ? 'exact' : 'notes';
  $('#customPrompt').value = s.customPrompt || DEFAULT_EXACT_PROMPT;
  $('#exact-box').classList.toggle('hidden', s.outputMode !== 'exact');
  SWITCHES.forEach(function (sw) {
    $('#' + sw[0]).checked = s[sw[0]] ? s[sw[0]] === 'on' : sw[1];
  });
  $('#priceIn').value = s.priceIn || '';
  $('#priceOut').value = s.priceOut || '';
  $('#usdInr').value = s.usdInr || '';
  $('#usdCny').value = s.usdCny || '';
  $('#price-status').textContent = '';
  fillModelPicks(s);
  showPriceHints();
  $('#test-gemini').textContent = '';
  $('#test-claude').textContent = '';
  $('#test-deepseek').textContent = '';
  $('#test-openrouter').textContent = '';
  show('settings');
}

function showPriceHints() {
  var st = formSettings();
  st.defaultGeminiModel = st.geminiModel;
  st.defaultClaudeModel = st.claudeModel;
  var d = defaultPrices(st);
  var ai = AI_PROVIDERS.indexOf(st.provider) >= 0;
  $('#priceIn').placeholder = ai ? 'built-in: ' + d[0] : 'no cost in no-key mode';
  $('#priceOut').placeholder = ai ? 'built-in: ' + d[1] : 'no cost in no-key mode';
  $('#usdInr').placeholder = 'built-in: ' + DEFAULT_USD_INR;
}

/* switches: [id, on by default] */
var SWITCHES = [['stories', true], ['summaries', true], ['lowThinking', false], ['smallPictures', false], ['cheapStories', true], ['costSaving', false], ['doubtful', true], ['grayPictures', true]];

function formSettings() {
  var s = {};
  SETTING_IDS.forEach(function (id) { s[id] = $('#' + id).value.trim(); });
  SWITCHES.forEach(function (sw) { s[sw[0]] = $('#' + sw[0]).checked ? 'on' : 'off'; });
  var checked = document.querySelector('input[name=provider]:checked');
  s.provider = checked ? checked.value : 'offline';
  return s;
}

function testKey(provider) {
  var s = formSettings();
  s.provider = provider;
  var line = $('#test-' + provider);
  line.className = 'test-result';
  line.textContent = 'Checking…';
  Android.testKey(JSON.stringify(s));
}

function saveSettings() {
  var s = formSettings();
  Android.saveSettings(JSON.stringify(s));
  toast('Settings saved.');
  show('home');
}

/* ───────── messages from the phone side ───────── */
window.onNative = function (event, d) {
  d = d || {};
  if (event === 'busy') {
    $('#busy').classList.toggle('hidden', !d.on);
    if (d.text) $('#busy-text').textContent = d.text;
  } else if (event === 'shared') {
    if (currentView !== 'home') { show('home'); renderNotesList(); }
  } else if (event === 'pages') {
    renderPages();
    if (d.message) toast(d.message);
  } else if (event === 'error') {
    toast(d.message || 'Something went wrong.');
  } else if (event === 'balance') {
    onBalance(d);
  } else if (event === 'prices') {
    onPrices(d);
  } else if (event === 'topicsDone') {
    onTopicsDone(d);
  } else if (event === 'keyTest') {
    var line = $('#test-' + d.provider);
    if (line) {
      line.className = 'test-result ' + (d.ok ? 'ok' : 'bad');
      line.textContent = (d.ok ? '✓ ' : '✗ ') + (d.message || '');
    }
  } else if (event === 'pageDone') {
    onPageDone(d);
  } else if (event === 'update') {
    if (d.available) {
      $('#update-version').textContent = d.version || '';
      $('#update-notes').textContent = d.notes || '';
      $('#update-banner').classList.remove('hidden');
    }
  } else if (event === 'updateProgress') {
    var b = $('#btn-update');
    if (d.done) { b.disabled = false; b.textContent = 'Install'; }
    else { b.disabled = true; b.textContent = d.pct + '%'; }
  } else if (event === 'updateError') {
    var b2 = $('#btn-update');
    b2.disabled = false; b2.textContent = 'Update';
    toast(d.message || 'Update failed.');
  }
};

/* ───────── wiring ───────── */
function init() {
  loadNotes();
  $('#btn-camera').onclick = function () { Android.takePhoto(); };
  $('#btn-gallery').onclick = function () { Android.pickImages(); };
  $('#btn-pdf').onclick = function () { Android.pickPdf(); };
  $('#btn-clear').onclick = function () {
    Android.clearPages();
    try { localStorage.removeItem(NEXT_KEY); } catch (e) {}
    renderPages();
  };
  $('#btn-make').onclick = startJob;
  $('#thumbs').onclick = function (e) {
    var b = e.target.closest ? e.target.closest('.thumb-x') : null;
    if (b) { Android.removePage(Number(b.getAttribute('data-i'))); renderPages(); }
  };
  $('#btn-retry').onclick = continueJob;
  $('#btn-pause').onclick = pauseJob;
  $('#btn-read').onclick = function () { openPreview(false); };
  $('#btn-live').onclick = function () { openPreview(true); };
  $('#btn-keep').onclick = function () {
    if (job.pending.length + Object.keys(job.errors).length === 0) { finishJob(); return; }
    ask('Save only the pages done so far? The remaining pages will be dropped from this run.', 'Yes, save', finishJob);
  };
  $('#btn-discard').onclick = discardJob;
  $('#notes-list').onclick = function (e) {
    var row = e.target.closest ? e.target.closest('.note-row') : null;
    if (row) openNote(Number(row.getAttribute('data-id')));
  };

  $('#btn-settings').onclick = openSettings;
  $('#btn-settings-back').onclick = function () { show('home'); };
  $('#btn-save-settings').onclick = saveSettings;
  document.querySelectorAll('[data-test]').forEach(function (b) {
    b.onclick = function () { testKey(b.getAttribute('data-test')); };
  });
  document.querySelectorAll('[data-show]').forEach(function (b) {
    b.onclick = function () {
      var input = $('#' + b.getAttribute('data-show'));
      var hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      b.textContent = hidden ? 'Hide' : 'Show';
    };
  });

  $('#btn-back').onclick = function () { window.onBack(); };
  $('#btn-print').onclick = function () {
    persistNotes();
    Android.print(currentNote ? currentNote.title : 'Notes');
  };
  $('#btn-delete').onclick = function () {
    if (!currentNote || currentNote.preview) return;
    ask('Delete "' + currentNote.title + '"? This cannot be undone.', 'Yes, delete', function () {
      notes = notes.filter(function (n) { return n.id !== currentNote.id; });
      currentNote = null;
      persistNotes();
      window.onBack();
    });
  };
  $('#sheets').addEventListener('input', onMarginInput);

  $('#btn-update').onclick = function () { Android.installUpdate(); };
  document.querySelectorAll('[data-pick]').forEach(function (pick) {
    pick.addEventListener('change', function () { onModelPick(pick); });
  });
  $('#outputMode').onchange = function () {
    $('#exact-box').classList.toggle('hidden', this.value !== 'exact');
  };
  // turning cost-saving on picks the cheap Flash-Lite model; the model list stays the one place to change it
  $('#costSaving').onchange = function () {
    if (!this.checked) return;
    var pick = $('#geminiModelPick');
    pick.value = COST_SAVING_MODEL;
    onModelPick(pick);
  };
  $('#btn-reset-prompt').onclick = function () { $('#customPrompt').value = DEFAULT_EXACT_PROMPT; };
  $('#btn-prices').onclick = function () {
    var st = formSettings();
    if (AI_PROVIDERS.indexOf(st.provider) < 0) { toast('Choose Gemini, Claude or DeepSeek first. The no-key mode has no cost.'); return; }
    var model = st[st.provider + 'Model'];
    var line = $('#price-status');
    line.className = 'test-result';
    line.textContent = 'Fetching…';
    Android.fetchPrices(st.provider, model);
  };
  $('#btn-topics').onclick = function () {
    if (!currentNote) return;
    if (!isAi()) { toast('Memory stories per topic need an AI key. Choose an AI in Settings.'); return; }
    startTopics(currentNote);
  };
  // a different AI or model has a different price: drop the typed prices so the built-in one applies
  document.querySelectorAll('input[name=provider], #geminiModel, #claudeModel, #deepseekModel, #openrouterModel').forEach(function (el) {
    el.addEventListener('change', function () {
      $('#priceIn').value = '';
      $('#priceOut').value = '';
      $('#price-status').textContent = '';
      showPriceHints();
    });
  });
  $('#modal-no').onclick = closeModal;
  $('#modal-yes').onclick = function () {
    var yes = modalYes;
    closeModal();
    if (yes) yes();
  };

  $('#version').textContent = 'NoteSaathi ' + Android.version();
  restoreJob();
  renderPages();
  renderJob();
  renderNotesList();
  Android.checkUpdate();
}

init();
