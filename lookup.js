// Book details from Open Library and Google Books (both free, no key needed).

const OL = 'https://openlibrary.org';
const GB = 'https://www.googleapis.com/books/v1/volumes';

async function getJSON(url, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

export function cleanISBN(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^0-9X]/g, '');
  if (s.length === 13 && /^\d{13}$/.test(s)) return s;
  if (s.length === 10 && /^\d{9}[\dX]$/.test(s)) return isbn10to13(s);
  return null;
}
function isbn10to13(s10) {
  const core = '978' + s10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += +core[i] * (i % 2 ? 3 : 1);
  return core + ((10 - (sum % 10)) % 10);
}
export function validISBN13(s) {
  if (!/^97[89]\d{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += +s[i] * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === +s[12];
}

const yearOf = s => (String(s || '').match(/\b(1[5-9]\d\d|20\d\d)\b/) || [])[1] || '';
const httpsify = u => (u || '').replace(/^http:/, 'https:').replace('&edge=curl', '');

function fromGoogle(v) {
  const i = v.volumeInfo || {};
  const ids = i.industryIdentifiers || [];
  const isbn = (ids.find(x => x.type === 'ISBN_13') || {}).identifier || cleanISBN((ids.find(x => x.type === 'ISBN_10') || {}).identifier) || '';
  return {
    title: [i.title, i.subtitle].filter(Boolean).join(': '),
    shortTitle: i.title || '',
    author: (i.authors || []).join(', '),
    isbn, pages: i.pageCount ? String(i.pageCount) : '',
    publisher: i.publisher || '', published: yearOf(i.publishedDate),
    cover: httpsify(i.imageLinks?.thumbnail || i.imageLinks?.smallThumbnail || ''),
    source: 'Google Books',
  };
}
function fromOLDoc(d) {
  const isbn = (d.isbn || []).find(x => /^97[89]\d{10}$/.test(x)) || '';
  return {
    title: d.title || '', shortTitle: d.title || '',
    author: (d.author_name || []).slice(0, 3).join(', '),
    isbn, pages: d.number_of_pages_median ? String(d.number_of_pages_median) : '',
    publisher: (d.publisher || [])[0] || '', published: d.first_publish_year ? String(d.first_publish_year) : '',
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : '',
    source: 'Open Library',
  };
}

// Resolves true if the image loads and isn't a 1×1 placeholder.
export function probeImage(url, ms = 9000) {
  return new Promise(res => {
    if (!url) return res(false);
    const img = new Image();
    const t = setTimeout(() => { img.src = ''; res(false); }, ms);
    img.onload = () => { clearTimeout(t); res(img.naturalWidth > 10 && img.naturalHeight > 10); };
    img.onerror = () => { clearTimeout(t); res(false); };
    img.src = url;
  });
}

export async function lookupISBN(isbn) {
  const [ol, gb] = await Promise.allSettled([
    getJSON(`${OL}/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`),
    getJSON(`${GB}?q=isbn:${isbn}`),
  ]);
  const o = ol.status === 'fulfilled' ? ol.value[`ISBN:${isbn}`] : null;
  const g = gb.status === 'fulfilled' && gb.value.items?.length ? fromGoogle(gb.value.items[0]) : null;
  if (!o && !g) {
    if (ol.status === 'rejected' && gb.status === 'rejected') throw new Error('offline');
    return null;
  }
  const oo = o ? {
    title: [o.title, o.subtitle].filter(Boolean).join(': '),
    author: (o.authors || []).map(a => a.name).join(', '),
    pages: o.number_of_pages ? String(o.number_of_pages) : '',
    publisher: o.publishers?.[0]?.name || '',
    published: yearOf(o.publish_date),
    cover: o.cover?.large || o.cover?.medium || '',
  } : {};
  const gg = g || {};
  const book = {
    isbn,
    title: gg.title || oo.title || '',
    author: gg.author || oo.author || '',
    pages: gg.pages || oo.pages || '',
    publisher: gg.publisher || oo.publisher || '',
    published: gg.published || oo.published || '',
  };
  // Prefer the larger Open Library scan, fall back to Google's thumbnail.
  const candidates = [oo.cover, `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`, gg.cover].filter(Boolean);
  book.cover_url = '';
  for (const c of candidates) { if (await probeImage(c)) { book.cover_url = c; break; } }
  return book;
}

export async function searchBooks(query) {
  const q = encodeURIComponent(query);
  const [gb, ol] = await Promise.allSettled([
    getJSON(`${GB}?q=${q}&maxResults=12&printType=books`),
    getJSON(`${OL}/search.json?q=${q}&limit=12&fields=title,author_name,cover_i,isbn,number_of_pages_median,first_publish_year,publisher`),
  ]);
  if (gb.status === 'rejected' && ol.status === 'rejected') throw new Error('offline');
  const out = [];
  const seen = new Set();
  const add = r => {
    const k = (r.shortTitle + '|' + r.author).toLowerCase() + '|' + r.cover;
    if (seen.has(k)) return;
    seen.add(k); out.push(r);
  };
  const g = gb.status === 'fulfilled' ? (gb.value.items || []).map(fromGoogle) : [];
  const o = ol.status === 'fulfilled' ? (ol.value.docs || []).map(fromOLDoc) : [];
  // Interleave so both sources show near the top.
  for (let i = 0; i < Math.max(g.length, o.length); i++) { if (o[i]) add(o[i]); if (g[i]) add(g[i]); }
  return out;
}

// Best single match for a book we only know by title + author (used for filling in old entries).
export async function findMatch(title, author) {
  const t = title.replace(/\s+-\s+|:/g, ' ').replace(/\s+/g, ' ').trim();
  const surname = (author || '').split(/\s+/).pop() || '';
  const tries = [
    () => getJSON(`${OL}/search.json?title=${encodeURIComponent(title)}&author=${encodeURIComponent(author || '')}&limit=5&fields=title,author_name,cover_i,isbn,number_of_pages_median,first_publish_year,publisher`).then(j => (j.docs || []).map(fromOLDoc)),
    () => getJSON(`${OL}/search.json?q=${encodeURIComponent(t + ' ' + surname)}&limit=5&fields=title,author_name,cover_i,isbn,number_of_pages_median,first_publish_year,publisher`).then(j => (j.docs || []).map(fromOLDoc)),
    () => getJSON(`${GB}?q=${encodeURIComponent(`intitle:${t}` + (surname ? ` inauthor:${surname}` : ''))}&maxResults=5&printType=books`).then(j => (j.items || []).map(fromGoogle)),
  ];
  let fallback = null;
  for (const run of tries) {
    let list = [];
    try { list = await run(); } catch { continue; }
    const withCover = list.find(r => r.cover);
    if (withCover) return withCover;
    fallback ||= list[0] || null;
  }
  return fallback;
}

// Several cover options for the cover picker.
export async function coverOptions(title, author, isbn) {
  const opts = [];
  if (isbn) opts.push({ cover: `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`, source: 'Open Library (this ISBN)' });
  try {
    const res = await searchBooks(`${title} ${author || ''}`.trim());
    res.filter(r => r.cover).forEach(r => opts.push({ cover: r.cover, source: r.source, title: r.shortTitle }));
  } catch { /* offline */ }
  const seen = new Set();
  return opts.filter(o => !seen.has(o.cover) && seen.add(o.cover));
}
