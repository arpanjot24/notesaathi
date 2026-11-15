'use strict';

var $ = function (sel) { return document.querySelector(sel); };
var NOTES_KEY = 'notesaathi.notes';

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

/* ───────── saved notes ───────── */
var notes = [];
function loadNotes() {
  try { notes = JSON.parse(localStorage.getItem(NOTES_KEY) || '[]') || []; } catch (e) { notes = []; }
}
function persistNotes() {
  try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); }
  catch (e) { toast('Phone storage for notes is full. Delete some old notes.'); }
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
window.onBack = function () {
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
  $('#btn-make').textContent = n === 1 ? 'Make my notes' : 'Make my notes (' + n + ' pages)';
  var box = $('#thumbs');
  box.innerHTML = '';
  for (var i = 0; i < n; i++) {
    var d = document.createElement('div');
    d.className = 'thumb';
    d.innerHTML = '<img alt=""><span class="thumb-n">' + (i + 1) + '</span>' +
      '<button class="thumb-x" data-i="' + i + '" aria-label="Remove page ' + (i + 1) + '">✕</button>';
    box.appendChild(d);
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
    var count = n.pages.length + (n.pages.length === 1 ? ' page' : ' pages');
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

function startJob() {
  var n = Android.pageCount();
  if (!n) return;
  if (!hasKey()) {
    toast('First add your AI key in Settings.');
    openSettings();
    return;
  }
  job = { n: n, results: new Array(n), errors: {}, pending: [], active: 0 };
  for (var i = 0; i < n; i++) job.pending.push(i);
  renderPages();
  pump();
}

function pump() {
  while (job.active < 2 && job.pending.length) {
    var i = job.pending.shift();
    delete job.errors[i];
    job.active++;
    Android.transcribe(i);
  }
  renderJob();
}

function renderJob() {
  var box = $('#job');
  if (!job) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  var done = 0;
  for (var i = 0; i < job.n; i++) if (job.results[i]) done++;
  var failed = Object.keys(job.errors).length;
  var running = job.active > 0 || job.pending.length > 0;
  $('#job-spin').classList.toggle('hidden', !running);
  $('#job-bar').style.width = Math.round(((done + failed) / job.n) * 100) + '%';
  $('#job-text').textContent = running
    ? 'Reading and writing your notes… ' + done + ' of ' + job.n + ' pages done'
    : done + ' of ' + job.n + ' pages done, ' + failed + ' could not be done';
  $('#job-errors').innerHTML = Object.keys(job.errors).map(function (k) {
    return '<div>Page ' + (Number(k) + 1) + ': ' + esc(job.errors[k]) + '</div>';
  }).join('');
  $('#job-actions').classList.toggle('hidden', running || failed === 0);
  $('#btn-keep').classList.toggle('hidden', done === 0);
}

function onPageDone(d) {
  if (!job) return;
  job.active--;
  if (d.ok) job.results[d.index] = d.data;
  else job.errors[d.index] = d.error || 'Something went wrong.';
  if (job.pending.length) { pump(); return; }
  renderJob();
  if (job.active === 0 && Object.keys(job.errors).length === 0) finishJob();
}

function finishJob() {
  var pages = [];
  for (var i = 0; i < job.n; i++) {
    if (job.results[i]) pages.push({ source: i + 1, data: job.results[i], margin: '' });
  }
  job = null;
  renderJob();
  if (!pages.length) { renderPages(); return; }
  var first = pages.filter(function (p) { return !p.data.unreadable; })[0];
  var note = {
    id: Date.now(),
    title: (first && first.data.title) || 'My notes',
    created: Date.now(),
    pages: pages
  };
  notes.unshift(note);
  persistNotes();
  Android.clearPages();
  renderPages();
  renderNotesList();
  openNote(note.id);
}

/* ───────── note viewer ───────── */
function sheetHtml(page, index, total) {
  var d = page.data || {};
  var main = '<div class="sheet-page">Page ' + (index + 1) + ' of ' + total +
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
    var m = d.mnemonic;
    if (m && (m.story || m.title)) {
      var links = list(m.links);
      main += '<div class="box box-story"><h4>📖 Remember it with a story' +
        (m.title ? ': ' + ink(m.title) : '') + '</h4><p>' + ink(m.story || '') + '</p>' +
        (links.length ? '<div class="story-links-title">How it connects</div><ul class="links">' +
          links.map(function (p) { return '<li>' + ink(p) + '</li>'; }).join('') + '</ul>' : '') +
        '</div>';
    }
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
var SETTING_IDS = ['geminiKey', 'geminiModel', 'claudeKey', 'claudeModel', 'mnemonicStyle', 'subject'];

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
  show('settings');
}

function saveSettings() {
  var s = {};
  SETTING_IDS.forEach(function (id) { s[id] = $('#' + id).value.trim(); });
  var checked = document.querySelector('input[name=provider]:checked');
  s.provider = checked ? checked.value : 'offline';
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
  } else if (event === 'pages') {
    renderPages();
    if (d.message) toast(d.message);
  } else if (event === 'error') {
    toast(d.message || 'Something went wrong.');
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
  $('#btn-clear').onclick = function () { Android.clearPages(); renderPages(); };
  $('#btn-make').onclick = startJob;
  $('#thumbs').onclick = function (e) {
    var b = e.target.closest ? e.target.closest('.thumb-x') : null;
    if (b) { Android.removePage(Number(b.getAttribute('data-i'))); renderPages(); }
  };
  $('#btn-retry').onclick = function () {
    job.pending = Object.keys(job.errors).map(Number);
    pump();
  };
  $('#btn-keep').onclick = finishJob;
  $('#notes-list').onclick = function (e) {
    var row = e.target.closest ? e.target.closest('.note-row') : null;
    if (row) openNote(Number(row.getAttribute('data-id')));
  };

  $('#btn-settings').onclick = openSettings;
  $('#btn-settings-back').onclick = function () { show('home'); };
  $('#btn-save-settings').onclick = saveSettings;
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
    if (!confirm('Delete "' + currentNote.title + '"? This cannot be undone.')) return;
    notes = notes.filter(function (n) { return n.id !== currentNote.id; });
    currentNote = null;
    persistNotes();
    window.onBack();
  };
  $('#sheets').addEventListener('input', onMarginInput);

  $('#btn-update').onclick = function () { Android.installUpdate(); };

  $('#version').textContent = 'NoteSaathi ' + Android.version();
  renderPages();
  renderNotesList();
  Android.checkUpdate();
}

init();
