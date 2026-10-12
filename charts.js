// Small hand-rolled SVG charts. Colours come from CSS custom properties so light/dark both work.

const NS = 'http://www.w3.org/2000/svg';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CUM_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

const tipEl = () => document.getElementById('tip');
export function showTip(html, x, y) {
  const t = tipEl();
  t.innerHTML = html; t.hidden = false;
  const w = t.offsetWidth, h = t.offsetHeight;
  let left = x + 14, top = y - h - 12;
  if (left + w > window.innerWidth - 8) left = x - w - 14;
  if (top < 8) top = y + 16;
  t.style.left = Math.max(8, left) + 'px';
  t.style.top = top + 'px';
}
export function hideTip() { tipEl().hidden = true; }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function niceMax(v) {
  if (v <= 5) return 5;
  const step = v <= 20 ? 5 : v <= 50 ? 10 : 20;
  return Math.ceil(v / step) * step;
}
function ticks(max) {
  const step = max <= 5 ? 1 : max <= 20 ? 5 : max <= 50 ? 10 : 20;
  const out = [];
  for (let v = 0; v <= max; v += step) out.push(v);
  return out;
}
function svg(w, h) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', `0 0 ${w} ${h}`);
  s.setAttribute('width', w); s.setAttribute('height', h);
  return s;
}

// ---------- cumulative pace ----------
// series: [{label, color, role: 'main'|'compare'|'other', fn: d => count, end: dayIndex, steps: [doy...]}]
export function paceChart(el, { series, yMaxHint }) {
  el.innerHTML = '';
  const W = el.clientWidth || 600, H = Math.round(Math.min(340, Math.max(240, W * 0.42)));
  const m = { l: 34, r: 64, t: 14, b: 28 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const ymax = niceMax(Math.max(yMaxHint || 0, ...series.map(s => s.fn(s.end))));
  const x = d => m.l + (d / 365) * iw;
  const y = v => m.t + ih - (v / ymax) * ih;
  const s = svg(W, H);
  let g = '';
  for (const t of ticks(ymax)) {
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)" stroke-width="1"/>`;
    g += `<text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
  }
  MONTHS.forEach((mn, i) => {
    const narrow = W < 520;
    if (!narrow || i % 2 === 0) g += `<text x="${x(CUM_DAYS[i] + 15)}" y="${H - 8}" text-anchor="middle">${mn}</text>`;
  });
  const path = sr => {
    if (sr.steps) {
      let d = `M${x(0)},${y(0)}`; let c = 0;
      for (const doy of sr.steps) { if (doy > sr.end) break; d += `H${x(doy)}V${y(++c)}`; }
      return d + `H${x(sr.end)}`;
    }
    let d = '';
    for (let day = 0; day <= sr.end; day += 2) d += (d ? 'L' : 'M') + `${x(day)},${y(sr.fn(day))}`;
    return d;
  };
  const order = [...series].sort((a, b) => ({ other: 0, compare: 1, main: 2 }[a.role] - { other: 0, compare: 1, main: 2 }[b.role]));
  for (const sr of order) {
    const w = sr.role === 'other' ? 1.25 : 2;
    const col = sr.role === 'other' ? 'var(--other-line)' : sr.color;
    g += `<path d="${path(sr)}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  // end markers + labels for the emphasised lines, only when they don't collide
  const ends = order.filter(r => r.role !== 'other').map(r => ({ r, yy: y(r.fn(r.end)), xx: x(r.end) }));
  const collide = ends.length === 2 && Math.abs(ends[0].yy - ends[1].yy) < 16;
  for (const e of ends) {
    g += `<circle cx="${e.xx}" cy="${e.yy}" r="4.5" fill="${e.r.color}" stroke="var(--surface)" stroke-width="2"/>`;
    if (!collide) g += `<text class="lbl" x="${e.xx + 9}" y="${e.yy + 4}">${esc(e.r.label)} · ${Math.round(e.r.fn(e.r.end) * 10) / 10}</text>`;
  }
  g += `<line class="xh" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" stroke="var(--ink-3)" stroke-width="1" visibility="hidden"/>`;
  g += `<g class="xdots"></g>`;
  s.innerHTML = g;
  el.appendChild(s);

  const xh = s.querySelector('.xh'), dots = s.querySelector('.xdots');
  const emph = series.filter(r => r.role !== 'other').sort((a, b) => (a.role === 'main' ? -1 : 1) - (b.role === 'main' ? -1 : 1));
  const move = ev => {
    const r = s.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (W / r.width);
    if (px < m.l || px > W - m.r + 10) return leave();
    const d = Math.max(0, Math.min(364, Math.round(((px - m.l) / iw) * 365)));
    xh.setAttribute('x1', x(d)); xh.setAttribute('x2', x(d)); xh.setAttribute('visibility', 'visible');
    const date = new Date(2001, 0, 1 + d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    let html = `<b>${date}</b>`, dh = '';
    for (const sr of emph) {
      if (d > sr.end) { html += `<br><span class="k" style="background:${sr.color}"></span>${esc(sr.label)}: not yet`; continue; }
      const v = sr.fn(d);
      html += `<br><span class="k" style="background:${sr.color}"></span>${esc(sr.label)}: ${Math.round(v * 10) / 10} book${v === 1 ? '' : 's'}`;
      dh += `<circle cx="${x(d)}" cy="${y(v)}" r="4" fill="${sr.color}" stroke="var(--surface)" stroke-width="2"/>`;
    }
    dots.innerHTML = dh;
    showTip(html, ev.clientX, ev.clientY);
  };
  const leave = () => { xh.setAttribute('visibility', 'hidden'); dots.innerHTML = ''; hideTip(); };
  s.addEventListener('pointermove', move);
  s.addEventListener('pointerdown', move);
  s.addEventListener('pointerleave', leave);
}

// ---------- stacked columns: books per year by format ----------
export function yearColumns(el, { years, keys, colors, labels, data, selected, onPick }) {
  el.innerHTML = '';
  const W = el.clientWidth || 600, H = 260;
  const m = { l: 34, r: 8, t: 22, b: 30 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const totals = years.map(yr => keys.reduce((a, k) => a + (data[yr][k] || 0), 0));
  const ymax = niceMax(Math.max(...totals, 1));
  const band = iw / years.length;
  const bw = Math.min(24, band * 0.6);
  const y = v => m.t + ih - (v / ymax) * ih;
  const s = svg(W, H);
  let g = '';
  for (const t of ticks(ymax)) {
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)"/>`;
    g += `<text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
  }
  years.forEach((yr, i) => {
    const cx = m.l + band * i + band / 2;
    let base = 0;
    const segs = keys.filter(k => data[yr][k]);
    segs.forEach((k, j) => {
      const v = data[yr][k];
      const top = j === segs.length - 1;
      const y0 = y(base), y1 = y(base + v) + (j > 0 ? 0 : 0);
      const gap = j > 0 ? 2 : 0; // surface gap between stacked segments
      const hgt = Math.max(0, y0 - y1 - gap);
      const yy = y1;
      const r = top ? Math.min(4, hgt / 2) : 0;
      g += `<path d="${roundTopRect(cx - bw / 2, yy, bw, hgt, r)}" fill="${colors[k]}"/>`;
      base += v;
    });
    const sel = yr === selected;
    if (totals[i]) g += `<text class="val" x="${cx}" y="${y(totals[i]) - 6}" text-anchor="middle">${totals[i]}</text>`;
    const narrow = band < 34;
    const lab = narrow ? `’${String(yr).slice(2)}` : yr;
    g += `<text x="${cx}" y="${H - 10}" text-anchor="middle" ${sel ? 'class="lbl"' : ''}>${lab}</text>`;
    if (sel) g += `<rect x="${cx - 12}" y="${H - 4}" width="24" height="2.5" rx="1.25" fill="var(--accent)"/>`;
    g += `<rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih + m.b}" fill="transparent"/>`;
  });
  s.innerHTML = g;
  el.appendChild(s);
  s.querySelectorAll('.hit').forEach(h => {
    const i = +h.dataset.i, yr = years[i];
    const tip = ev => {
      let html = `<b>${yr}</b>: ${totals[i]} book${totals[i] === 1 ? '' : 's'}`;
      keys.forEach(k => { if (data[yr][k]) html += `<br><span class="k" style="background:${colors[k]}"></span>${labels[k]}: ${data[yr][k]}`; });
      showTip(html, ev.clientX, ev.clientY);
    };
    h.addEventListener('pointermove', tip);
    h.addEventListener('pointerleave', hideTip);
    h.addEventListener('click', ev => { tip(ev); onPick && onPick(yr); });
  });
}
function roundTopRect(x, y, w, h, r) {
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

// ---------- month × year heatmap ----------
export function monthHeatmap(el, { years, cells, selected }) {
  el.innerHTML = '';
  const W = el.clientWidth || 600;
  const m = { l: 46, r: 4, t: 22, b: 4 };
  const cw = (W - m.l - m.r) / 12;
  const ch = Math.min(30, Math.max(22, cw * 0.62));
  const H = m.t + years.length * ch + m.b;
  const steps = ['var(--heat-empty)', 'var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)', 'var(--seq-6)'];
  const dark = document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  const s = svg(W, H);
  let g = '';
  MONTHS.forEach((mn, i) => { g += `<text x="${m.l + cw * i + cw / 2}" y="14" text-anchor="middle">${W < 520 ? mn[0] : mn}</text>`; });
  years.forEach((yr, r) => {
    const yy = m.t + r * ch;
    g += `<text x="${m.l - 8}" y="${yy + ch / 2 + 4}" text-anchor="end" ${yr === selected ? 'class="lbl"' : ''}>${yr}</text>`;
    for (let mo = 0; mo < 12; mo++) {
      const list = cells[yr]?.[mo] || [];
      const n = list.length;
      const fill = steps[Math.min(n, 6)];
      g += `<rect class="cell" data-y="${yr}" data-m="${mo}" x="${m.l + cw * mo + 1}" y="${yy + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="${fill}"/>`;
      if (n) {
        const light = dark ? n <= 3 : n >= 4; // white text on the deep end of the ramp
        g += `<text x="${m.l + cw * mo + cw / 2}" y="${yy + ch / 2 + 4}" text-anchor="middle" style="fill:${light ? '#fff' : '#0d1a33'};font-weight:600;pointer-events:none">${n}</text>`;
      }
    }
  });
  s.innerHTML = g;
  el.appendChild(s);
  s.querySelectorAll('.cell').forEach(c => {
    const list = cells[c.dataset.y]?.[c.dataset.m] || [];
    const tip = ev => {
      const head = `<b>${MONTHS[c.dataset.m]} ${c.dataset.y}</b>: ${list.length || 'no'} book${list.length === 1 ? '' : 's'}`;
      const items = list.slice(0, 8).map(t => `<li>${esc(t)}</li>`).join('') + (list.length > 8 ? `<li>+${list.length - 8} more</li>` : '');
      showTip(head + (items ? `<ul>${items}</ul>` : ''), ev.clientX, ev.clientY);
    };
    c.addEventListener('pointermove', tip);
    c.addEventListener('pointerdown', tip);
    c.addEventListener('pointerleave', hideTip);
  });
}

// ---------- horizontal bars (single series) ----------
export function barList(el, items, { color = 'var(--accent)' } = {}) {
  el.innerHTML = '';
  if (!items.length) { el.innerHTML = '<p class="sub">Nothing to show yet.</p>'; return; }
  const W = el.clientWidth || 400;
  const row = 30, labW = Math.min(170, W * 0.42);
  const H = items.length * row;
  const max = Math.max(...items.map(i => i.value));
  const bw = W - labW - 40;
  const s = svg(W, H);
  let g = '';
  items.forEach((it, i) => {
    const yy = i * row;
    const w = Math.max(3, (it.value / max) * bw);
    g += `<text x="${labW - 10}" y="${yy + row / 2 + 4}" text-anchor="end" style="fill:var(--ink)">${esc(truncate(it.label, Math.floor(labW / 7.2)))}</text>`;
    g += `<path d="M${labW},${yy + 7}H${labW + w - 4}Q${labW + w},${yy + 7} ${labW + w},${yy + 11}V${yy + row - 11}Q${labW + w},${yy + row - 7} ${labW + w - 4},${yy + row - 7}H${labW}Z" fill="${color}"/>`;
    g += `<text class="val" x="${labW + w + 6}" y="${yy + row / 2 + 4}">${it.value}</text>`;
    g += `<rect class="hit" data-i="${i}" x="0" y="${yy}" width="${W}" height="${row}" fill="transparent"/>`;
  });
  s.innerHTML = g;
  el.appendChild(s);
  s.querySelectorAll('.hit').forEach(h => {
    const it = items[+h.dataset.i];
    const tip = ev => showTip(`<b>${esc(it.label)}</b>: ${it.value} book${it.value === 1 ? '' : 's'}${it.note ? '<br>' + esc(it.note) : ''}`, ev.clientX, ev.clientY);
    h.addEventListener('pointermove', tip);
    h.addEventListener('pointerdown', tip);
    h.addEventListener('pointerleave', hideTip);
  });
}
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
