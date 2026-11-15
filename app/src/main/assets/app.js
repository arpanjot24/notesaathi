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

function list(v) {
  if (Array.isArray(v)) return v.filter(function (x) { return x != null && String(x).trim() !== ''; });
  if (v == null || v === '') return [];
  return [v];
}

/* ───────── cost ───────── */
/* Built-in prices in US$ per million tokens [input, output]; editable in Settings. */
function defaultPrices(st) {
  if (st.provider === 'claude') {
    var m = st.claudeModel || st.defaultClaudeModel || '';
    if (m.indexOf('haiku') >= 0) return [0.1, 0.5];
    if (m.indexOf('sonnet') >= 0) return [2, 10];
    if (m.indexOf('fable') >= 0 || m.indexOf('mythos') >= 0) return [8, 40];
    return [4, 20];
  }
  var g = st.geminiModel || st.defaultGeminiModel || '';
  if (g.indexOf('lite') >= 0) return [0.25, 1.5];
  if (g.indexOf('pro') >= 0) return [2, 10];
  return [0.75, 3.75];
}
var DEFAULT_USD_INR = 88;

function rupeesFor(usage) {
  var st = readSettings();
  if (!usage || (st.provider !== 'gemini' && st.provider !== 'claude')) return 0;
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
}
function isAi() {
  var p = readSettings().provider;
  return p === 'gemini' || p === 'claude';
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
  show('home');
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
  return true; // on-device mode needs no key
}

/* from / to are page positions counted from 0, both included */
function newJob(n, from, to) {
  return {
    n: n, from: from || 0, to: to == null ? n - 1 : to,
    results: new Array(n), errors: {}, pending: [], active: 0, paused: false, reason: '', streak: 0,
    usage: { in: 0, out: 0 }
  };
}

/* Progress is written after every page, so a long run survives the app being closed. */
function saveJob() {
  Android.saveData('job', job ? JSON.stringify({ n: job.n, from: job.from, to: job.to, results: job.results, usage: job.usage }) : '');
}

function restoreJob() {
  var saved = null;
  try { saved = JSON.parse(Android.loadData('job') || 'null'); } catch (e) { saved = null; }
  if (!saved || !saved.n || saved.n !== Android.pageCount()) { Android.saveData('job', ''); return; }
  job = newJob(saved.n, saved.from, saved.to);
  if (saved.usage) job.usage = saved.usage;
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
  if (!job) { box.classList.add('hidden'); return; }
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
}

function onPageDone(d) {
  if (!job) return;
  job.active--;
  if (d.ok) {
    addUsage(job.usage, d.data._usage);
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
    if (job.results[i]) pages.push({ source: i + 1, data: job.results[i], margin: '' });
  }
  var partial = job.from > 0 || job.to < job.n - 1;
  var reachedEnd = job.to >= job.n - 1;
  var rangeLabel = ' (pages ' + (job.from + 1) + '–' + (job.to + 1) + ')';
  var nextStart = job.to + 2;
  var usage = job.usage;
  job = null;
  saveJob();
  awake(false);
  renderJob();
  if (!pages.length) { renderPages(); return; }
  var first = pages.filter(function (p) { return !p.data.unreadable; })[0];
  var note = {
    id: Date.now(),
    title: ((first && first.data.title) || 'My notes') + (partial ? rangeLabel : ''),
    created: Date.now(),
    pages: pages,
    usage: usage,
    rupees: rupeesFor(usage),
    needsTopics: isAi() && readSettings().stories !== 'off'
  };
  notes.unshift(note);
  persistNotes();
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
  openNote(note.id);
  if (note.needsTopics) startTopics(note);
}

/* ───────── topics: one memory story per topic, written after all pages are read ───────── */
var topicsBusy = {};

function plain(s) { return String(s == null ? '' : s).replace(/\[\[[kdnu]:|\]\]/g, ''); }

function startTopics(note) {
  if (topicsBusy[note.id]) return;
  var digest = [];
  note.pages.forEach(function (p, i) {
    var d = p.data || {};
    if (d.unreadable) return;
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

function onTopicsDone(d) {
  var id = Number(d.id);
  delete topicsBusy[id];
  var note = notes.filter(function (n) { return n.id === id; })[0];
  if (!note) return;
  if (!d.ok) {
    toast(d.error || 'Could not write the memory stories.');
    renderTopicsBar();
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
  $('#note-cost').textContent = 'API cost for this document: about ' + money(n.rupees) +
    ' (' + money(n.rupees / n.pages.length) + ' per page) · ' + tokens(u.in) + ' tokens in, ' + tokens(u.out) + ' out';
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
  $('#note-title').textContent = currentNote.title;
  var total = currentNote.pages.length;
  $('#sheets').innerHTML = currentNote.pages.map(function (p, i) { return sheetHtml(p, i, total); }).join('');
  renderTopicsBar();
  renderNoteCost();
  show('note');
}

var marginTimer = null;
function onMarginInput(e) {
  var t = e.target;
  if (!currentNote || t.tagName !== 'TEXTAREA') return;
  currentNote.pages[Number(t.getAttribute('data-page'))].margin = t.value;
  clearTimeout(marginTimer);
  marginTimer = setTimeout(persistNotes, 600);
}

/* ───────── settings ───────── */
var SETTING_IDS = ['geminiKey', 'geminiModel', 'claudeKey', 'claudeModel', 'mnemonicStyle', 'subject', 'priceIn', 'priceOut', 'usdInr'];

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
  $('#mnemonicStyle').value = s.mnemonicStyle || 'mix';
  $('#subject').value = s.subject || '';
  SWITCHES.forEach(function (sw) {
    $('#' + sw[0]).checked = s[sw[0]] ? s[sw[0]] === 'on' : sw[1];
  });
  $('#priceIn').value = s.priceIn || '';
  $('#priceOut').value = s.priceOut || '';
  $('#usdInr').value = s.usdInr || '';
  showPriceHints();
  $('#test-gemini').textContent = '';
  $('#test-claude').textContent = '';
  show('settings');
}

function showPriceHints() {
  var st = formSettings();
  st.defaultGeminiModel = st.geminiModel;
  st.defaultClaudeModel = st.claudeModel;
  var d = defaultPrices(st);
  var ai = st.provider === 'gemini' || st.provider === 'claude';
  $('#priceIn').placeholder = ai ? 'built-in: ' + d[0] : 'no cost in no-key mode';
  $('#priceOut').placeholder = ai ? 'built-in: ' + d[1] : 'no cost in no-key mode';
  $('#usdInr').placeholder = 'built-in: ' + DEFAULT_USD_INR;
}

/* switches: [id, on by default] */
var SWITCHES = [['stories', true], ['summaries', true], ['lowThinking', false], ['smallPictures', false]];

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
    if (!currentNote) return;
    ask('Delete "' + currentNote.title + '"? This cannot be undone.', 'Yes, delete', function () {
      notes = notes.filter(function (n) { return n.id !== currentNote.id; });
      currentNote = null;
      persistNotes();
      window.onBack();
    });
  };
  $('#sheets').addEventListener('input', onMarginInput);

  $('#btn-update').onclick = function () { Android.installUpdate(); };
  $('#btn-topics').onclick = function () {
    if (!currentNote) return;
    if (!isAi()) { toast('Memory stories per topic need an AI key. Choose Gemini or Claude in Settings.'); return; }
    startTopics(currentNote);
  };
  document.querySelectorAll('input[name=provider], #geminiModel, #claudeModel').forEach(function (el) {
    el.addEventListener('change', showPriceHints);
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
