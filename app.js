import { db, toCSV, booksFromCSV, newId, today, keyOf } from './store.js';
import { cleanISBN, lookupISBN, searchBooks, findMatch, coverOptions, probeImage } from './lookup.js';
import { paceChart, yearColumns, monthHeatmap, barList, hideTip } from './charts.js';

const FORMATS = ['Physical', 'Kindle', 'Audiobook'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FKEYS = ['Physical', 'Kindle', 'Audiobook', 'Mixed'];
const FLABELS = { Physical: 'Physical', Kindle: 'Kindle', Audiobook: 'Audiobook', Mixed: 'More than one' };
const FCOLORS = { Physical: 'var(--s1)', Kindle: 'var(--s2)', Audiobook: 'var(--s3)', Mixed: 'var(--s4)' };
const NOW = new Date();
const THIS_YEAR = NOW.getFullYear();

const state = {
  books: [], view: 'shelf', q: '', fmt: null, backlogSort: 'newest',
  statsYear: THIS_YEAR, compare: 'prev', showTable: false,
  dirty: new Set(), lastBackup: null, coverJob: null,
  get changes() { return this.dirty.size; },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const main = $('#main');
const sheet = $('#sheet');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const icon = (id, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

// ---------- book helpers ----------
const formatsOf = b => (b.format || 'Physical').split('/').filter(Boolean);
const fmtKey = b => { const f = formatsOf(b); return f.length === 1 ? f[0] : 'Mixed'; };
// A book is on the backlog (owned, not started), being read, or finished.
const statusOf = b => (b.status === 'backlog' ? 'backlog' : b.finished ? 'finished' : 'reading');
const isReading = b => statusOf(b) === 'reading';
const isBacklog = b => statusOf(b) === 'backlog';
const finYear = b => (b.finished ? +b.finished.slice(0, 4) : null);
function finDate(b) {
  if (!b.finished) return null;
  const [y, m, d] = b.finished.split('-').map(Number);
  const dt = new Date(y, (m || 7) - 1, d || 15); // month-only dates sit mid-month…
  return !d && dt > NOW ? new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate()) : dt; // …but never in the future
}
function dayOfYear(dt) {
  const start = new Date(dt.getFullYear(), 0, 1);
  return Math.min(364, Math.round((dt - start) / 864e5));
}
function showDate(s, long = false) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  if (!m) return String(y);
  if (!d) return `${MONTHS[m - 1]} ${y}`;
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: long ? 'long' : 'short', year: 'numeric' });
}
const fullDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
function daysBetween(a, b) {
  if (!fullDate(a) || !fullDate(b)) return null;
  return Math.round((new Date(b) - new Date(a)) / 864e5) + 1;
}
function hue(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
const PH = ['#2b3a86', '#33585a', '#6b3a4b', '#735a2c', '#32506e', '#4f4a6e', '#5e3f30', '#2f5240', '#58324f', '#3d4652'];
function coverHTML(b) {
  const ph = `<div class="ph" style="background:${PH[hue(b.title + b.author) % PH.length]}"><span class="ph-t">${esc(b.title)}</span><span class="ph-a">${esc(b.author)}</span></div>`;
  if (!b.cover_url) return `<div class="cover">${ph}</div>`;
  return `<div class="cover">${ph}<img src="${esc(b.cover_url)}" alt="" loading="lazy" decoding="async" onerror="this.remove()"></div>`;
}
const fmtIcons = b => formatsOf(b).map(f => icon(f.toLowerCase())).join('');
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---------- persistence ----------
async function saveBook(b, { quiet } = {}) {
  b.updated = today();
  b.status = statusOf(b);
  const i = state.books.findIndex(x => x.id === b.id);
  if (i >= 0) state.books[i] = b; else state.books.push(b);
  await db.put(b);
  await markDirty([b.id]);
  if (!quiet) render();
}
async function markDirty(ids) {
  ids.forEach(id => state.dirty.add(id));
  await db.setMeta('dirty', [...state.dirty]);
  updateBackupDot();
  if (navigator.storage?.persist && !state.persistAsked) { state.persistAsked = true; navigator.storage.persist().catch(() => {}); }
}
function updateBackupDot() { $('.tabs .dot').hidden = state.changes === 0; }

// ---------- toast ----------
let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button type="button">${esc(action.label)}</button>` : '');
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 8000 : 3200);
}

// ---------- routing ----------
function setView(v) {
  state.view = v;
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  $('#addBtn span').textContent = v === 'backlog' ? 'Add to backlog' : 'Add book';
  hideTip();
  render();
  window.scrollTo({ top: 0 });
}
function render() {
  if (state.view === 'shelf') renderShelf();
  else if (state.view === 'backlog') renderBacklog();
  else if (state.view === 'stats') renderStats();
  else renderBackup();
}

// ---------- shelf ----------
function backupBanner() {
  if (!state.changes || !state.books.length) return '';
  const since = state.lastBackup ? `since your last backup on ${new Date(state.lastBackup).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'and no backup in iCloud Drive yet';
  return `<div class="banner">${icon('cloud')}<p>${plural(state.changes, 'book')} changed on this iPad ${since}.</p><button class="btn" data-act="backup">Back up now</button></div>`;
}

function matches(b) {
  const q = norm(state.q);
  return (!q || norm(b.title).includes(q) || norm(b.author).includes(q) || (b.isbn || '').includes(q)) &&
    (!state.fmt || formatsOf(b).includes(state.fmt));
}
function cardLine(b) {
  const st = statusOf(b);
  if (st === 'backlog') return b.added ? 'Added ' + showDate(b.added) : 'On your backlog';
  if (st === 'reading') return b.started ? 'Started ' + showDate(b.started) : 'Reading';
  return showDate(b.finished);
}
const card = b => `<button class="book" data-id="${b.id}">
    <div style="position:relative">${coverHTML(b)}${isReading(b) ? '<span class="badge-reading">Reading</span>' : ''}</div>
    <span class="meta"><span class="t">${esc(b.title)}</span><span class="a">${esc(b.author)}</span>
    <span class="f">${fmtIcons(b)}<span>${esc(cardLine(b))}</span></span></span>
  </button>`;
function toolbar(extra = '') {
  return `<div class="toolbar">
      <label class="search">${icon('search')}<span class="visually-hidden">Search</span>
        <input class="input" type="search" id="q" placeholder="Search titles, authors, ISBNs" value="${esc(state.q)}" autocomplete="off"></label>
      <div class="chips" role="group" aria-label="Format">
        <button class="chip" aria-pressed="${!state.fmt}" data-fmt="">All</button>
        ${FORMATS.map(f => `<button class="chip" aria-pressed="${state.fmt === f}" data-fmt="${f}">${icon(f.toLowerCase())}${f}</button>`).join('')}
      </div>${extra}
    </div>`;
}
function wireSearch() {
  const qi = $('#q');
  qi?.addEventListener('input', () => {
    state.q = qi.value;
    const pos = qi.selectionStart;
    render();
    const n = $('#q'); n.focus(); n.setSelectionRange(pos, pos);
  });
}

function renderShelf() {
  if (!state.books.length) return renderEmpty();
  const q = norm(state.q);
  const list = state.books.filter(b => !isBacklog(b) && matches(b));
  const reading = list.filter(isReading).sort((a, b) => (b.started || '').localeCompare(a.started || ''));
  const byYear = new Map();
  list.filter(b => statusOf(b) === 'finished').sort((a, b) => b.finished.localeCompare(a.finished) || (b.updated || '').localeCompare(a.updated || ''))
    .forEach(b => { const y = finYear(b); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(b); });

  const todayDoy = dayOfYear(NOW);
  const yearHead = (y, n) => {
    let vs = '';
    if (y === THIS_YEAR && !q && !state.fmt) {
      const prev = state.books.filter(b => finYear(b) === y - 1 && dayOfYear(finDate(b)) <= todayDoy).length;
      vs = `<span class="vs">${prev} by this time in ${y - 1}</span>`;
    }
    return `<div class="year-head"><h2>${y}</h2><span class="count">${plural(n, 'book')}</span>${vs}</div>`;
  };

  const nothing = !state.books.some(b => !isBacklog(b));
  main.innerHTML = `
    ${toolbar()}
    ${backupBanner()}
    ${reading.length ? `<section class="shelf-section reading-now"><div class="year-head"><h2>Reading now</h2></div><div class="grid">${reading.map(card).join('')}</div></section>` : ''}
    ${[...byYear].map(([y, bs]) => `<section class="shelf-section">${yearHead(y, bs.length)}<div class="grid">${bs.map(card).join('')}</div></section>`).join('')}
    ${nothing ? `<p class="no-results">Nothing on your shelf yet. When you start a book from your backlog it appears here under Reading now.</p>`
      : !reading.length && !byYear.size ? `<p class="no-results">No books match “${esc(state.q)}”${state.fmt ? ` in ${state.fmt}` : ''}.</p>` : ''}
  `;
  wireSearch();
}

// ---------- backlog ----------
const SORTS = {
  newest: ['Recently added', (a, b) => (b.added || '').localeCompare(a.added || '') || (b.updated || '').localeCompare(a.updated || '')],
  oldest: ['Waiting longest', (a, b) => (a.added || '').localeCompare(b.added || '')],
  author: ['Author', (a, b) => surname(a.author).localeCompare(surname(b.author)) || a.title.localeCompare(b.title)],
  title: ['Title', (a, b) => a.title.replace(/^(the|a|an) /i, '').localeCompare(b.title.replace(/^(the|a|an) /i, ''))],
};
const surname = a => (a || '').split(',')[0].trim().split(/\s+/).pop().toLowerCase();

function renderBacklog() {
  const all = state.books.filter(isBacklog);
  if (!all.length) {
    main.innerHTML = `<div class="empty">
      <h1>Your backlog is empty</h1>
      <p>Add the books you own but haven’t started yet. When you start one, open it and tick “I’ve started reading this” to move it to Reading now.</p>
      <div class="row"><button class="btn primary" data-act="add">${icon('plus')}Add to backlog</button></div></div>`;
    return;
  }
  const list = all.filter(matches).sort(SORTS[state.backlogSort][1]);
  const oldest = all.map(b => b.added).filter(Boolean).sort()[0];
  const sortSel = `<label class="compare sort">Sort by <select class="input" id="sortSel">${Object.entries(SORTS).map(([k, [lab]]) => `<option value="${k}" ${state.backlogSort === k ? 'selected' : ''}>${lab}</option>`).join('')}</select></label>`;
  main.innerHTML = `
    ${toolbar(sortSel)}
    <section class="shelf-section">
      <div class="year-head"><h2>Backlog</h2><span class="count">${plural(all.length, 'book')} waiting</span>${oldest ? `<span class="vs">oldest added ${esc(showDate(oldest))}</span>` : ''}</div>
      ${list.length ? `<div class="grid">${list.map(card).join('')}</div>` : `<p class="no-results">No backlog books match “${esc(state.q)}”${state.fmt ? ` in ${state.fmt}` : ''}.</p>`}
    </section>`;
  wireSearch();
  $('#sortSel').onchange = e => { state.backlogSort = e.target.value; renderBacklog(); };
}

async function startReading(b) {
  const before = { ...b };
  await saveBook({ ...b, status: 'reading', started: today(), finished: '' });
  toast(`“${b.title}” moved to Reading now`, { label: 'Undo', run: () => saveBook(before) });
}

async function renderEmpty() {
  main.innerHTML = `<div class="empty">
    <h1>Your reading log is empty</h1>
    <p>Bring in your history from a CSV in iCloud Drive, or add the book you’re reading now.</p>
    <div class="row">
      <button class="btn primary" data-act="import-merge">Import a CSV</button>
      <button class="btn" data-act="add">Add a book</button>
      <button class="btn" data-act="seed" hidden>Load the sample history</button>
    </div></div>`;
  try {
    const r = await fetch('seed.csv', { method: 'HEAD', cache: 'no-store' });
    if (r.ok) $('[data-act="seed"]').hidden = false;
  } catch { /* none bundled */ }
}

// ---------- detail ----------
function openDetail(id) {
  const b = state.books.find(x => x.id === id);
  if (!b) return;
  const days = daysBetween(b.started, b.finished);
  const backlog = isBacklog(b);
  const facts = [
    ['ISBN', b.isbn], ['Pages', b.pages], ['Publisher', b.publisher], ['Published', b.published],
  ].filter(([, v]) => v);
  const stamp = (s, cls = '') => s ? `<span class="stamp ${cls}">${esc(showDate(s).toUpperCase())}</span>` : `<span class="stamp none">${cls || backlog ? 'not yet' : 'not logged'}</span>`;
  sheet.innerHTML = `
    <div class="sheet-head"><h2 id="sheetTitle">${backlog ? 'On your backlog' : isReading(b) ? 'Reading now' : 'Finished ' + esc(showDate(b.finished))}</h2>
      <button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div>
    <div class="sheet-body">
      <div class="detail">
        ${coverHTML(b)}
        <div>
          <h3>${esc(b.title)}</h3>
          <p class="by">${esc(b.author)}</p>
          ${backlog ? `<label class="start-check"><input type="checkbox" id="startNow"><span>I’ve started reading this<small>Moves it to Reading now, started today</small></span></label>` : ''}
          <div class="formats-row">${formatsOf(b).map(f => `<span class="fmt-pill">${icon(f.toLowerCase())}${f}</span>`).join('')}</div>
          ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
          <div class="slip" aria-label="Dates">
            <div class="slip-head"><span>Started</span><span>Finished</span></div>
            <div class="slip-row">${stamp(b.started)}${stamp(b.finished, 'second')}</div>
            <div class="slip-foot">${backlog ? (b.added ? `On your backlog since ${esc(showDate(b.added))}` : 'On your backlog') : days ? `Read in ${plural(days, 'day')}` : isReading(b) && fullDate(b.started) ? `Day ${daysBetween(b.started, today())} of reading` : '&nbsp;'}</div>
          </div>
        </div>
      </div>
    </div>
    <div class="sheet-actions">
      <button class="btn danger" data-act="delete">Delete</button>
      <span class="spacer"></span>
      ${isReading(b) ? '<button class="btn" data-act="finish">Finished today</button>' : ''}
      <button class="btn primary" data-act="edit">Edit</button>
    </div>`;
  sheet.dataset.id = id;
  openSheet();
  sheet.onchange = async ev => {
    if (ev.target.id !== 'startNow' || !ev.target.checked) return;
    ev.target.disabled = true;
    await new Promise(r => setTimeout(r, 350)); // let the tick register before the sheet closes
    closeSheet();
    await startReading(b);
  };
  sheet.onclick = async ev => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (ev.target.closest('[data-close]')) return closeSheet();
    if (act === 'edit') openEditor(b);
    if (act === 'finish') { await saveBook({ ...b, finished: today() }); toast(`Finished “${b.title}”`); openDetail(b.id); }
    if (act === 'delete') {
      if (!confirm(`Delete “${b.title}” from your log?`)) return;
      state.books = state.books.filter(x => x.id !== b.id);
      await db.remove(b.id); await markDirty([b.id]);
      closeSheet(); render();
      toast('Book deleted', { label: 'Undo', run: async () => { await saveBook(b); } });
    }
  };
}

function openSheet() {
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
}
function closeSheet() { sheet.close(); }
sheet.addEventListener('click', ev => { if (ev.target === sheet) closeSheet(); });
sheet.addEventListener('close', () => { sheet.onclick = null; sheet.onchange = null; });

// ---------- editor (add + edit) ----------
function openEditor(existing) {
  const isNew = !existing;
  const startBacklog = !existing && state.view === 'backlog';
  const d = existing ? { ...existing, status: statusOf(existing) } : { id: newId(), title: '', author: '', isbn: '', format: 'Physical', status: startBacklog ? 'backlog' : 'reading', started: startBacklog ? '' : today(), finished: '', pages: '', publisher: '', published: '', cover_url: '', added: today() };
  let found = !isNew;

  const dateInput = (name, val) => {
    const monthOnly = /^\d{4}-\d{2}$/.test(val || '');
    return `<div class="date-row"><input class="input" type="${monthOnly ? 'month' : 'date'}" name="${name}" value="${esc(val || '')}" max="${monthOnly ? today().slice(0, 7) : today()}">
      ${monthOnly ? `<button type="button" class="btn quiet" data-exact="${name}">Add day</button>` : ''}
      <button type="button" class="btn quiet" data-clear="${name}">Clear</button></div>`;
  };

  const draw = () => {
    const st = d.status;
    sheet.innerHTML = `
      <div class="sheet-head"><h2 id="sheetTitle">${isNew ? (st === 'backlog' ? 'Add to your backlog' : 'Add a book') : 'Edit book'}</h2>
        <button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div>
      <form class="sheet-body" id="bookForm" novalidate>
        ${isNew ? `<div class="find">
          <label class="field"><span>ISBN</span>
            <div class="find-row"><input class="input" id="isbnFind" inputmode="numeric" enterkeyhint="search" autocomplete="off" placeholder="978…" value="${esc(d.isbn)}">
            <button type="button" class="btn" data-act="lookup">Look up</button>
            <button type="button" class="btn" data-act="scan" aria-label="Scan barcode">${icon('barcode')}<span>Scan</span></button></div></label>
          <label class="field"><span>No ISBN? Search by title or author</span>
            <div class="find-row"><input class="input" id="tq" enterkeyhint="search" autocomplete="off" placeholder="e.g. The Honourable Schoolboy">
            <button type="button" class="btn" data-act="search">Search</button></div></label>
          <div class="status-line" id="findStatus" aria-live="polite"></div>
          <div class="results" id="results"></div>
          ${!found ? '<button type="button" class="btn quiet" data-act="manual" style="justify-self:start">Enter details by hand</button>' : ''}
        </div>` : ''}
        ${found ? `<div class="form-grid">
          <div>
            <div id="coverPreview">${coverHTML(d)}</div>
            <div class="cover-tools">
              <button type="button" class="btn" data-act="covers">Choose another cover</button>
              <label class="btn">${icon('camera')}Use a photo<input type="file" accept="image/*" id="photo" hidden></label>
            </div>
          </div>
          <div class="fields">
            <label class="field wide"><span>Title</span><input class="input" name="title" required value="${esc(d.title)}"></label>
            <label class="field wide"><span>Author</span><input class="input" name="author" value="${esc(d.author)}"></label>
            <div class="field wide"><span id="fmtLab">Format</span>
              <div class="toggle-fmt" role="group" aria-labelledby="fmtLab">
                ${FORMATS.map(f => `<button type="button" class="chip" data-tfmt="${f}" aria-pressed="${formatsOf(d).includes(f)}">${icon(f.toLowerCase())}${f}</button>`).join('')}
              </div>
              <p class="hint">${st === 'backlog' ? 'The format you own it in.' : 'Pick more than one if you switched between them.'}</p></div>
            <div class="field wide"><span id="stLab">Status</span>
              <div class="toggle-fmt" role="group" aria-labelledby="stLab">
                ${[['backlog', 'On my backlog'], ['reading', 'Reading'], ['finished', 'Finished']].map(([k, lab]) => `<button type="button" class="chip" data-status="${k}" aria-pressed="${st === k}">${lab}</button>`).join('')}
              </div>
              ${st === 'backlog' ? '<p class="hint">Owned but not started. It stays off your shelf and stats until you start it.</p>' : ''}</div>
            ${st !== 'backlog' ? `<label class="field"><span>Started</span>${dateInput('started', d.started)}</label>` : ''}
            ${st === 'finished' ? `<label class="field"><span>Finished</span>${dateInput('finished', d.finished)}</label>` : st === 'reading' ? '<div class="field"></div>' : ''}
            <label class="field"><span>ISBN</span><input class="input" name="isbn" inputmode="numeric" value="${esc(d.isbn)}"></label>
            <label class="field"><span>Pages</span><input class="input" name="pages" inputmode="numeric" value="${esc(d.pages)}"></label>
            <label class="field"><span>Publisher</span><input class="input" name="publisher" value="${esc(d.publisher)}"></label>
            <label class="field"><span>First published</span><input class="input" name="published" inputmode="numeric" value="${esc(d.published)}"></label>
          </div>
        </div>
        <div id="coverPicker"></div>` : ''}
      </form>
      ${found ? `<div class="sheet-actions">
        ${!isNew ? '<button type="button" class="btn quiet" data-act="cancel">Cancel</button>' : ''}<span class="spacer"></span>
        <button type="submit" form="bookForm" class="btn primary">${isNew ? (st === 'backlog' ? 'Add to backlog' : 'Add to log') : 'Save changes'}</button></div>` : ''}`;
    openSheet();
  };

  const status = (msg, err) => { const s = $('#findStatus'); if (s) { s.textContent = msg; s.classList.toggle('err', !!err); } };
  const readForm = () => {
    const f = $('#bookForm');
    if (!f || !found) return;
    for (const k of ['title', 'author', 'isbn', 'pages', 'publisher', 'published', 'started', 'finished']) {
      const el = f.elements[k];
      if (el) d[k] = el.value.trim();
    }
  };
  const fill = r => {
    readForm();
    Object.assign(d, {
      title: r.title || d.title, author: r.author || d.author, isbn: r.isbn || d.isbn,
      pages: r.pages || '', publisher: r.publisher || '', published: r.published || '',
      cover_url: r.cover_url ?? r.cover ?? '',
    });
    found = true;
    draw();
  };

  async function doLookup() {
    const raw = $('#isbnFind').value;
    const isbn = cleanISBN(raw);
    if (!isbn) return status('That doesn’t look like an ISBN. It’s the 10 or 13 digits above the barcode.', true);
    status('Looking up ' + isbn + '…');
    try {
      const r = await lookupISBN(isbn);
      if (!r) return status('No book found for that ISBN. Try searching by title instead.', true);
      const dup = state.books.find(b => b.isbn === isbn);
      fill(r);
      const where = dup && ({ backlog: 'on your backlog', reading: 'reading now', finished: 'finished ' + showDate(dup.finished) })[statusOf(dup)];
      status(dup ? `Already added: ${dup.title} (${where}). Saving will add it again.` : '');
    } catch {
      status('Couldn’t reach the book databases. Check your connection, or enter the details by hand.', true);
    }
  }
  async function doSearch() {
    const q = $('#tq').value.trim();
    if (!q) return;
    status('Searching…');
    $('#results').innerHTML = '';
    try {
      const res = await searchBooks(q);
      if (!res.length) return status('Nothing found. Try fewer words, or enter the details by hand.', true);
      status('Tap the edition you read.');
      $('#results').innerHTML = res.slice(0, 18).map((r, i) => `<button type="button" class="result" data-r="${i}">
        ${coverHTML({ ...r, cover_url: r.cover })}<span><b>${esc(r.shortTitle)}</b><br>${esc(r.author)}${r.published ? ', ' + esc(r.published) : ''}</span><span class="src">${esc(r.source)}</span></button>`).join('');
      $('#results').onclick = ev => {
        const btn = ev.target.closest('[data-r]');
        if (btn) { fill(res[+btn.dataset.r]); }
      };
    } catch {
      status('Couldn’t reach the book databases. Check your connection, or enter the details by hand.', true);
    }
  }
  async function showCovers() {
    readForm();
    const box = $('#coverPicker');
    box.innerHTML = '<p class="hint" style="margin-top:18px">Finding covers…</p>';
    const opts = await coverOptions(d.title, d.author, cleanISBN(d.isbn));
    const ok = [];
    await Promise.all(opts.slice(0, 16).map(async o => { if (await probeImage(o.cover)) ok.push(o); }));
    if (!ok.length) { box.innerHTML = '<p class="hint" style="margin-top:18px">No other covers found. You can take a photo of the cover instead.</p>'; return; }
    box.innerHTML = `<p class="hint" style="margin-top:18px">Tap a cover to use it.</p><div class="cover-picker">${ok.map((o, i) => `<button type="button" data-c="${i}" aria-label="Cover from ${esc(o.source)}"><div class="cover"><img src="${esc(o.cover)}" alt=""></div></button>`).join('')}</div>`;
    box.onclick = ev => {
      const b = ev.target.closest('[data-c]');
      if (!b) return;
      d.cover_url = ok[+b.dataset.c].cover;
      $('#coverPreview').innerHTML = coverHTML(d);
      box.innerHTML = '';
    };
  }

  sheet.onclick = async ev => {
    if (ev.target.closest('[data-close]')) return closeSheet();
    const t = ev.target.closest('[data-act],[data-tfmt],[data-clear],[data-exact],[data-status]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'lookup') doLookup();
    if (act === 'search') doSearch();
    if (act === 'manual') { found = true; draw(); $('#bookForm').elements.title.focus(); }
    if (act === 'cancel') return existing ? openDetail(existing.id) : closeSheet();
    if (act === 'covers') showCovers();
    if (act === 'scan') {
      const code = await openScanner();
      if (code) { $('#isbnFind').value = code; doLookup(); }
    }
    if (t.dataset.tfmt) {
      readForm();
      const f = t.dataset.tfmt;
      let cur = formatsOf(d);
      cur = cur.includes(f) ? cur.filter(x => x !== f) : [...cur, f];
      if (!cur.length) cur = [f];
      d.format = FORMATS.filter(x => cur.includes(x)).join('/');
      $$('[data-tfmt]', sheet).forEach(b => b.setAttribute('aria-pressed', String(cur.includes(b.dataset.tfmt))));
    }
    if (t.dataset.status) {
      readForm();
      d.status = t.dataset.status;
      if (d.status !== 'backlog' && !d.started) d.started = today();
      if (d.status === 'finished' && !d.finished) d.finished = today();
      draw();
    }
    if (t.dataset.clear) { readForm(); d[t.dataset.clear] = ''; if (t.dataset.clear === 'finished') d.finished = ''; draw(); }
    if (t.dataset.exact) { readForm(); d[t.dataset.exact] = d[t.dataset.exact] + '-01'; draw(); }
  };
  sheet.onchange = async ev => {
    if (ev.target.id === 'photo' && ev.target.files[0]) {
      readForm();
      d.cover_url = await shrinkImage(ev.target.files[0]);
      $('#coverPreview').innerHTML = coverHTML(d);
    }
  };
  sheet.onkeydown = ev => {
    if (ev.key !== 'Enter') return;
    if (ev.target.id === 'isbnFind') { ev.preventDefault(); doLookup(); }
    if (ev.target.id === 'tq') { ev.preventDefault(); doSearch(); }
  };
  sheet.onsubmit = async ev => {
    ev.preventDefault();
    readForm();
    if (!d.title) { $('#bookForm').elements.title.focus(); return toast('Add a title first'); }
    if (d.isbn) d.isbn = cleanISBN(d.isbn) || d.isbn;
    if (d.pages) d.pages = String(parseInt(d.pages, 10) || '');
    if (d.status === 'backlog') { d.started = ''; d.finished = ''; }
    if (d.status === 'reading') d.finished = '';
    if (d.status === 'finished' && !d.finished) return toast('Add the date you finished it');
    if (d.started && d.finished && d.started > d.finished && fullDate(d.finished)) return toast('The finish date is before the start date');
    if (d.status !== 'backlog' && existing?.status === 'backlog' && existing.added) d.added = existing.added;
    await saveBook(d);
    toast(isNew ? (d.status === 'backlog' ? `Added “${d.title}” to your backlog` : `Added “${d.title}”`) : 'Changes saved');
    openDetail(d.id);
  };
  draw();
  if (isNew) setTimeout(() => $('#isbnFind')?.focus(), 50);
}

function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const h = Math.min(600, img.naturalHeight), w = Math.round(img.naturalWidth * (h / img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.78));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ---------- barcode scanner ----------
let zxingLoaded;
function loadZXing() {
  zxingLoaded ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/zxing.min.js';
    s.onload = () => res(window.ZXing);
    s.onerror = rej;
    document.head.appendChild(s);
  });
  return zxingLoaded;
}
function openScanner() {
  const dlg = $('#scanner'), video = $('#scanVideo'), hint = $('#scanHint');
  hint.textContent = 'Point the camera at the barcode on the back cover.';
  dlg.showModal();
  return new Promise(async resolve => {
    let reader, done = false;
    const finish = code => {
      if (done) return; done = true;
      try { reader?.reset(); } catch { /* already stopped */ }
      video.srcObject?.getTracks?.().forEach(t => t.stop());
      dlg.close();
      resolve(code);
    };
    $('#scanCancel').onclick = () => finish(null);
    dlg.oncancel = e => { e.preventDefault(); finish(null); };
    try {
      const ZX = await loadZXing();
      const hints = new Map();
      hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [ZX.BarcodeFormat.EAN_13]);
      hints.set(ZX.DecodeHintType.TRY_HARDER, true);
      reader = new ZX.BrowserMultiFormatReader(hints, 250);
      await reader.decodeFromConstraints({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } }, video, result => {
        if (!result) return;
        const code = result.getText();
        if (/^97[89]\d{10}$/.test(code)) { navigator.vibrate?.(40); finish(code); }
        else hint.textContent = 'That’s not a book barcode. Look for the one starting 978 or 979.';
      });
    } catch (e) {
      hint.textContent = e && e.name === 'NotAllowedError'
        ? 'Camera access is off. Allow it in Settings › Safari › Camera (or for this app), then try again.'
        : 'The camera couldn’t start. Type the ISBN instead.';
    }
  });
}

// ---------- stats ----------
function statsData() {
  const done = state.books.filter(b => b.finished);
  const years = [...new Set(done.map(finYear))];
  const minY = Math.min(...years, THIS_YEAR), maxY = Math.max(...years, THIS_YEAR);
  const all = [];
  for (let y = minY; y <= maxY; y++) all.push(y);
  const by = {};
  all.forEach(y => { by[y] = []; });
  done.forEach(b => by[finYear(b)].push(b));
  const doys = {};
  all.forEach(y => { doys[y] = by[y].map(b => dayOfYear(finDate(b))).sort((a, b) => a - b); });
  return { all, by, doys };
}
const countBy = (sorted, d) => { let n = 0; for (const x of sorted) { if (x <= d) n++; else break; } return n; };

function renderStats() {
  if (!state.books.some(b => b.finished)) {
    main.innerHTML = `<div class="empty"><h1>No finished books yet</h1><p>Stats appear once you’ve finished a book or imported your history.</p><div class="row"><button class="btn primary" data-act="add">Add a book</button></div></div>`;
    return;
  }
  const { all, by, doys } = statsData();
  if (!all.includes(state.statsYear)) state.statsYear = all[all.length - 1];
  const Y = state.statsYear;
  const isCur = Y === THIS_YEAR;
  const todayDoy = dayOfYear(NOW);
  const end = isCur ? todayDoy : 364;
  const fullYears = all.filter(y => y !== Y && y !== THIS_YEAR && by[y].length);
  let cmp = state.compare === 'prev' ? Y - 1 : state.compare;
  if (cmp !== 'avg' && !all.includes(+cmp)) cmp = fullYears.length ? 'avg' : null;
  if (cmp !== 'avg' && cmp != null) cmp = +cmp;

  const avgFn = d => fullYears.length ? fullYears.reduce((a, y) => a + countBy(doys[y], d), 0) / fullYears.length : 0;
  const cmpFn = cmp === 'avg' ? avgFn : cmp != null ? d => countBy(doys[cmp], d) : null;
  const cmpLabel = cmp === 'avg' ? 'Average year' : String(cmp);

  const books = by[Y];
  const n = books.length;
  // headline comparison
  let caption = '';
  if (cmpFn) {
    const other = Math.round(cmpFn(end) * 10) / 10;
    const diff = Math.round((n - other) * 10) / 10;
    const whenTxt = isCur ? (cmp === 'avg' ? 'an average year at this point' : `this point in ${cmp}`) : (cmp === 'avg' ? `an average year (${other})` : `${cmp} (${other})`);
    caption = diff === 0 ? `Level with ${whenTxt}` :
      `<strong class="${diff > 0 ? 'delta-up' : 'delta-down'}">${diff > 0 ? '+' : '−'}${Math.abs(diff)}</strong> ${diff > 0 ? 'ahead of' : 'behind'} ${whenTxt}${isCur && cmp !== 'avg' ? ` (${other})` : ''}`;
  }
  const withPages = books.filter(b => +b.pages > 0);
  const pages = withPages.reduce((a, b) => a + +b.pages, 0);
  const durations = books.map(b => daysBetween(b.started, b.finished)).filter(Boolean);
  const avgDays = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  const monthsElapsed = isCur ? NOW.getMonth() + NOW.getDate() / 31 : 12;
  const perMonth = n / monthsElapsed;
  const projected = isCur ? Math.round(n / ((todayDoy + 1) / 365)) : null;
  const fmtCounts = FKEYS.map(k => [k, books.filter(b => fmtKey(b) === k).length]).filter(([, v]) => v).sort((a, b) => b[1] - a[1]);

  const yearChips = [...all].reverse().map(y => `<button class="chip" data-year="${y}" aria-pressed="${y === Y}">${y}</button>`).join('');
  const cmpOptions = `<option value="prev" ${state.compare === 'prev' ? 'selected' : ''}>Previous year</option>` +
    (fullYears.length ? `<option value="avg" ${state.compare === 'avg' ? 'selected' : ''}>Average year</option>` : '') +
    [...all].reverse().filter(y => y !== Y).map(y => `<option value="${y}" ${String(state.compare) === String(y) ? 'selected' : ''}>${y}</option>`).join('');

  main.innerHTML = `
    <div class="stats-top">
      <div class="years" role="group" aria-label="Year">${yearChips}</div>
      <label class="compare">Compare with <select class="input" id="cmpSel">${cmpOptions}</select></label>
    </div>
    <section class="hero">
      <div><div class="hero-num">${n}</div><div class="hero-cap">${plural(n, 'book').replace(/^\d+ /, '')} ${isCur ? 'so far in' : 'in'} ${Y}${caption ? '<br>' + caption : ''}</div></div>
      <div class="tiles">
        <div class="tile"><div class="lab">Per month</div><div class="val">${perMonth.toFixed(1)}</div><div class="sub">${projected != null ? `On course for ${projected}` : `${plural(n, 'book')} over 12 months`}</div></div>
        <div class="tile"><div class="lab">Pages read</div><div class="val">${pages ? pages.toLocaleString('en-GB') : '—'}</div><div class="sub">${pages ? (withPages.length < n ? `From ${withPages.length} of ${n} books` : 'All books counted') : 'Run “Find covers” to add page counts'}</div></div>
        <div class="tile"><div class="lab">Days per book</div><div class="val">${avgDays ?? '—'}</div><div class="sub">${avgDays ? `Average of ${plural(durations.length, 'book')} with both dates` : 'Needs start and finish dates'}</div></div>
        <div class="tile"><div class="lab">Main format</div><div class="val">${fmtCounts[0] ? FLABELS[fmtCounts[0][0]] : '—'}</div><div class="sub">${fmtCounts.map(([k, v]) => `${FLABELS[k]} ${v}`).join(', ')}</div></div>
      </div>
    </section>
    <div class="panels">
      <section class="panel full">
        <h3>Pace through the year</h3>
        <p class="sub">Books finished by each date. Grey lines are your other years.</p>
        <div class="legend"><span><i style="background:var(--s1)"></i>${Y}</span>${cmpFn ? `<span><i style="background:var(--s2)"></i>${cmpLabel}</span>` : ''}<span><i style="background:var(--other-line)"></i>Other years</span></div>
        <div class="chart" id="paceChart"></div>
      </section>
      <section class="panel full">
        <div class="panel-head"><div><h3>Books per year</h3><p class="sub">Tap a year to compare it.</p></div>
          <button class="btn quiet table-toggle" data-act="table">${state.showTable ? 'Show chart' : 'Show as table'}</button></div>
        <div class="legend">${FKEYS.map(k => `<span><i class="sq" style="background:${FCOLORS[k]}"></i>${FLABELS[k]}</span>`).join('')}</div>
        <div class="chart" id="yearChart"></div>
      </section>
      <section class="panel full">
        <h3>Month by month</h3>
        <p class="sub">Books finished each month. Tap a square to see which.</p>
        <div class="chart" id="heat"></div>
      </section>
      <section class="panel"><h3>Authors in ${Y}</h3><p class="sub">Most books finished</p><div class="chart" id="authY"></div></section>
      <section class="panel"><h3>Authors, all years</h3><p class="sub">Most books finished since ${all[0]}</p><div class="chart" id="authAll"></div></section>
    </div>`;

  const series = all.filter(y => y !== Y && y !== cmp && by[y].length).map(y => ({
    label: String(y), role: 'other', steps: doys[y], fn: d => countBy(doys[y], d), end: y === THIS_YEAR ? todayDoy : 364,
  }));
  if (cmpFn) series.push({ label: cmpLabel, role: 'compare', color: 'var(--s2)', steps: cmp === 'avg' ? null : doys[cmp], fn: cmpFn, end: cmp === THIS_YEAR ? todayDoy : 364 });
  series.push({ label: String(Y), role: 'main', color: 'var(--s1)', steps: doys[Y], fn: d => countBy(doys[Y], d), end });

  const yearData = {};
  all.forEach(y => { yearData[y] = {}; FKEYS.forEach(k => { yearData[y][k] = by[y].filter(b => fmtKey(b) === k).length; }); });
  const cells = {};
  all.forEach(y => { cells[y] = Array.from({ length: 12 }, () => []); by[y].forEach(b => cells[y][finDate(b).getMonth()].push(b.title)); });

  const authorTop = list => {
    const m = new Map();
    list.forEach(b => { const a = (b.author || 'Unknown').trim(); m.set(a, (m.get(a) || 0) + 1); });
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([label, value]) => ({ label, value }));
  };

  const draw = () => {
    paceChart($('#paceChart'), { series });
    if (state.showTable) {
      $('#yearChart').innerHTML = `<table class="data"><thead><tr><th>Year</th>${FKEYS.map(k => `<th>${FLABELS[k]}</th>`).join('')}<th>Total</th></tr></thead><tbody>${[...all].reverse().map(y => `<tr><td>${y}</td>${FKEYS.map(k => `<td>${yearData[y][k]}</td>`).join('')}<td><b>${by[y].length}</b></td></tr>`).join('')}</tbody></table>`;
    } else {
      yearColumns($('#yearChart'), { years: all, keys: FKEYS, colors: FCOLORS, labels: FLABELS, data: yearData, selected: Y, onPick: y => { state.statsYear = y; renderStats(); } });
    }
    monthHeatmap($('#heat'), { years: [...all].reverse(), cells, selected: Y });
    barList($('#authY'), authorTop(books));
    barList($('#authAll'), authorTop(state.books.filter(b => b.finished)));
  };
  draw();
  statsRedraw = draw;

  $('#cmpSel').onchange = e => { state.compare = e.target.value; renderStats(); };
}
let statsRedraw = null;
let resizeT;
new ResizeObserver(() => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (state.view === 'stats' && statsRedraw && $('#paceChart')) statsRedraw(); }, 120);
}).observe(main);

// ---------- backup ----------
function renderBackup() {
  const missing = state.books.filter(b => !b.cover_url).length;
  const last = state.lastBackup ? new Date(state.lastBackup) : null;
  const job = state.coverJob;
  main.innerHTML = `<div class="backup">
    <section class="card">
      <h2>Back up to iCloud Drive</h2>
      <div class="last"><span class="pip ${state.changes || !last ? 'warn' : ''}"></span>
        <span>${last ? `Last backed up ${last.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} at ${last.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.` : 'Not backed up yet.'}
        ${last ? (state.changes ? ` ${plural(state.changes, 'book')} changed since then.` : ' Everything’s in your backup.') : ''}</span></div>
      <p>Your log lives on this iPad. A backup saves the whole log as one CSV file in iCloud Drive, where it syncs to your other devices and opens in Numbers or Excel.</p>
      <ol class="steps">
        <li>Tap <b>Back up now</b>.</li>
        <li>In the share sheet, choose <b>Save to Files</b>.</li>
        <li>Pick a folder in <b>iCloud Drive</b> (a “Reading Log” folder works well) and tap <b>Save</b>. Choose <b>Replace</b> if it asks.</li>
      </ol>
      <div class="row"><button class="btn primary" data-act="backup">${icon('cloud')}Back up now</button>
        <button class="btn quiet" data-act="download">Download the CSV instead</button></div>
    </section>
    <section class="card">
      <h2>Restore or import</h2>
      <p>Choose a CSV from Files. It can be a backup from this app, or a sheet laid out like your old spreadsheet: Title, Author, Year, Month, Format for books you’ve read, or Title, Author, Year Bought, Format for your backlog.</p>
      <div class="row"><button class="btn" data-act="import-merge">Import and merge</button>
        <button class="btn danger" data-act="import-replace">Replace everything</button></div>
      <p class="hint" style="margin-top:12px">Merging keeps your current books and adds or updates the ones in the file. Replacing swaps your whole log for the file.</p>
    </section>
    <section class="card">
      <h2>Find covers and page counts</h2>
      <p>${missing ? `${plural(missing, 'book')} ${missing === 1 ? 'doesn’t' : 'don’t'} have a cover yet. This looks each one up on Open Library and Google Books by title and author, about a second per book. You can change any cover afterwards from the book’s Edit screen.` : 'Every book has a cover.'}</p>
      ${job ? `<div class="progress"><div style="width:${Math.round(job.done / job.total * 100)}%"></div></div><p class="hint" id="jobText">${job.done} of ${job.total} checked, ${job.found} covers found</p>` : ''}
      <div class="row">${job ? '<button class="btn" data-act="stop-covers">Stop</button>' : missing ? `<button class="btn" data-act="covers">Find ${plural(missing, 'cover')}</button>` : ''}</div>
    </section>
    <section class="card">
      <h2>On this iPad</h2>
      <p id="storageInfo">${plural(state.books.length, 'book')} stored.</p>
    </section>
  </div>`;
  if (navigator.storage?.persisted) {
    navigator.storage.persisted().then(p => {
      const el = $('#storageInfo');
      if (el) el.textContent = `${plural(state.books.length, 'book')} stored. ${p ? 'Safari has marked this storage as permanent, so it won’t be cleared to save space.' : 'Add this app to your Home Screen so Safari keeps its storage, and back up regularly.'}`;
    });
  }
}

function download(csv, name) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
async function markBackedUp() {
  state.dirty = new Set(); state.lastBackup = new Date().toISOString();
  await db.setMeta('dirty', []); await db.setMeta('lastBackup', state.lastBackup);
  updateBackupDot(); render();
}
async function backup(forceDownload) {
  const csv = toCSV(state.books);
  const name = 'reading-log.csv';
  const file = new File([csv], name, { type: 'text/csv' });
  if (!forceDownload && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      await markBackedUp();
      toast('Backup saved');
    } catch (e) {
      if (e.name !== 'AbortError') { download(csv, name); await markBackedUp(); }
      else toast('Backup cancelled');
    }
  } else {
    download(csv, name);
    await markBackedUp();
    toast('CSV downloaded');
  }
}

function pickFile() {
  return new Promise(resolve => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.csv,text/csv,text/comma-separated-values,text/plain' });
    inp.onchange = () => resolve(inp.files[0] || null);
    inp.click();
  });
}
async function importCSV(mode, text) {
  if (!text) {
    const file = await pickFile();
    if (!file) return;
    text = await file.text();
  }
  let incoming;
  try { incoming = booksFromCSV(text); } catch (e) { return toast(e.message); }
  if (!incoming.length) return toast('No books found in that file');
  if (mode === 'replace') {
    if (state.books.length && !confirm(`Replace all ${state.books.length} books on this iPad with the ${incoming.length} in this file?`)) return;
    await db.clear();
    await db.putMany(incoming);
    state.books = incoming;
    toast(`Imported ${plural(incoming.length, 'book')}`);
  } else {
    const byId = new Map(state.books.map(b => [b.id, b]));
    const byKey = new Map(state.books.map(b => [keyOf(b), b]));
    let added = 0, updated = 0;
    const changed = [];
    for (const nb of incoming) {
      const ex = byId.get(nb.id) || byKey.get(keyOf(nb));
      if (ex) {
        for (const [k, v] of Object.entries(nb)) if (v && k !== 'id') ex[k] = v;
        changed.push(ex); updated++;
      } else { state.books.push(nb); changed.push(nb); added++; }
    }
    await db.putMany(changed);
    toast(`${plural(added, 'book')} added, ${updated} updated`);
    await markDirty(changed.map(b => b.id));
  }
  // A fresh import from a backup means the backup is current.
  if (mode === 'replace') await markBackedUp();
  setView(incoming.every(isBacklog) ? 'backlog' : 'shelf');
}

async function findCovers() {
  const todo = state.books.filter(b => !b.cover_url);
  if (!todo.length) return;
  const job = state.coverJob = { total: todo.length, done: 0, found: 0, stop: false };
  render();
  for (const b of todo) {
    if (job.stop) break;
    try {
      const m = await findMatch(b.title, b.author);
      if (m && m.cover) {
        b.cover_url = m.cover;
        if (!b.pages && m.pages) b.pages = m.pages;
        if (!b.published && m.published) b.published = m.published;
        await db.put(b);
        job.found++;
      }
    } catch { /* skip this one */ }
    job.done++;
    if (state.view === 'backup') {
      const bar = $('.progress div'), txt = $('#jobText');
      if (bar) bar.style.width = Math.round(job.done / job.total * 100) + '%';
      if (txt) txt.textContent = `${job.done} of ${job.total} checked, ${job.found} covers found`;
    }
    await new Promise(r => setTimeout(r, 350));
  }
  state.coverJob = null;
  if (job.found) await markDirty(todo.filter(b => b.cover_url).map(b => b.id));
  toast(`Found ${plural(job.found, 'cover')}${job.total - job.found ? `; ${job.total - job.found} still missing` : ''}`);
  render();
}

// ---------- global events ----------
$$('.tabs button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
$('#addBtn').addEventListener('click', () => openEditor(null));
main.addEventListener('click', async ev => {
  const book = ev.target.closest('.book');
  if (book) return openDetail(book.dataset.id);
  const chip = ev.target.closest('[data-fmt]');
  if (chip) { state.fmt = chip.dataset.fmt || null; return render(); }
  const yr = ev.target.closest('[data-year]');
  if (yr) { state.statsYear = +yr.dataset.year; return renderStats(); }
  const act = ev.target.closest('[data-act]')?.dataset.act;
  if (act === 'add') openEditor(null);
  if (act === 'backup') backup(false);
  if (act === 'download') backup(true);
  if (act === 'import-merge') importCSV('merge');
  if (act === 'import-replace') importCSV('replace');
  if (act === 'covers') findCovers();
  if (act === 'stop-covers' && state.coverJob) state.coverJob.stop = true;
  if (act === 'table') { state.showTable = !state.showTable; renderStats(); }
  if (act === 'seed') {
    const text = await (await fetch('seed.csv', { cache: 'no-store' })).text();
    importCSV('merge', text);
  }
});
document.addEventListener('pointerdown', ev => { if (!ev.target.closest('.chart')) hideTip(); });

// ---------- boot ----------
(async function boot() {
  try {
    state.books = (await db.all()) || [];
    state.dirty = new Set((await db.getMeta('dirty')) || []);
    state.lastBackup = (await db.getMeta('lastBackup')) || null;
  } catch (e) {
    main.innerHTML = `<div class="empty"><h1>Storage isn’t available</h1><p>This browser blocked local storage (private browsing does this). Open the app from your Home Screen or a normal Safari tab.</p></div>`;
    return;
  }
  updateBackupDot();
  render();

  if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost') {
    navigator.serviceWorker?.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('A new version is ready', { label: 'Reload', run: () => nw.postMessage('skipWaiting') });
          }
        });
      });
    }).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker?.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
  }
})();
