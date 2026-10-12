// Storage: IndexedDB on the device, plus CSV import/export for iCloud Drive backups.

const DB_NAME = 'reading-log';
let dbp = null;

function openDB() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function run(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    const r = fn(store);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const db = {
  all: () => run('books', 'readonly', s => s.getAll()),
  put: book => run('books', 'readwrite', s => s.put(book)),
  putMany: books => run('books', 'readwrite', s => { books.forEach(b => s.put(b)); }),
  remove: id => run('books', 'readwrite', s => s.delete(id)),
  clear: () => run('books', 'readwrite', s => s.clear()),
  getMeta: key => run('meta', 'readonly', s => s.get(key)),
  setMeta: (key, val) => run('meta', 'readwrite', s => s.put(val, key)),
};

// ---------- CSV ----------
export const COLUMNS = ['id', 'title', 'author', 'isbn', 'format', 'status', 'started', 'finished', 'pages', 'publisher', 'published', 'cover_url', 'added', 'updated'];

function esc(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCSV(books) {
  const sorted = [...books].sort((a, b) => (b.finished || '9999').localeCompare(a.finished || '9999') || (b.started || '').localeCompare(a.started || ''));
  const lines = [COLUMNS.join(',')];
  for (const b of sorted) lines.push(COLUMNS.map(c => esc(b[c])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', i = 0, q = false;
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function normaliseFormat(f) {
  const s = (f || '').toLowerCase();
  const out = [];
  if (/phys|paper|hard|print/.test(s)) out.push('Physical');
  if (/kindle|ebook|e-book|digital/.test(s)) out.push('Kindle');
  if (/audio/.test(s)) out.push('Audiobook');
  return out.join('/') || 'Physical';
}

// Accepts this app's CSV, or the older spreadsheet layout (Title, Author, Year, Month, Format).
export function booksFromCSV(text) {
  const rows = parseCSV(text);
  const hi = rows.findIndex(r => r.some(c => c.trim().toLowerCase() === 'title'));
  if (hi < 0) throw new Error('Couldn’t find a “title” column in that file.');
  const head = rows[hi].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const col = name => head.indexOf(name);
  const legacy = col('id') < 0 && col('year') >= 0;
  const legacyToRead = col('id') < 0 && col('year_bought') >= 0;
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const get = name => { const k = col(name); return k >= 0 ? (r[k] || '').trim() : ''; };
    const title = get('title');
    if (!title) continue;
    let b;
    if (legacyToRead) {
      const y = get('year_bought');
      b = { title, author: get('author'), format: normaliseFormat(get('format')), status: 'backlog', started: '', finished: '', added: /^\d{4}$/.test(y) ? `${y}-01-01` : '' };
    } else if (legacy) {
      const y = get('year'), m = MONTHS[get('month').slice(0, 3).toLowerCase()];
      const finished = y ? (m ? `${y}-${String(m).padStart(2, '0')}` : `${y}`) : '';
      b = { title, author: get('author'), format: normaliseFormat(get('format')), finished, started: '' };
    } else {
      b = {};
      for (const c of COLUMNS) b[c] = get(c);
      if (b.format) b.format = b.format.split('/').map(x => normaliseFormat(x)).join('/');
    }
    b.status = normaliseStatus(b.status, b);
    if (!b.id) b.id = newId();
    if (b.pages) b.pages = String(parseInt(b.pages, 10) || '');
    b.added ||= today();
    out.push(b);
  }
  return out;
}

function normaliseStatus(s, b) {
  s = (s || '').toLowerCase();
  if (/backlog|to.?read|tbr|unread|owned/.test(s)) return 'backlog';
  return b.finished ? 'finished' : 'reading';
}

export function newId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const keyOf = b => `${(b.title || '').toLowerCase().replace(/[^a-z0-9]/g, '')}|${(b.author || '').toLowerCase().replace(/[^a-z]/g, '')}|${b.finished || ''}`;
