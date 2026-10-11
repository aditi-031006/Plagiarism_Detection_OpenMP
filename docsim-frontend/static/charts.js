/* DocSim - tiny SVG chart helpers (no external libraries, works offline).
   Every function returns an HTML/SVG string; colours come from CSS variables so
   the charts follow the light/dark theme automatically. */
'use strict';

const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtN = n => n == null ? '—' : Math.round(n).toLocaleString();
const fmtT = s => {
  if (s == null || !isFinite(s)) return '—';
  if (s < 1e-3) return (s * 1e6).toFixed(s * 1e6 < 10 ? 1 : 0) + ' µs';
  if (s < 1) return (s * 1e3).toFixed(s < 0.01 ? 2 : 1) + ' ms';
  return s.toFixed(s < 10 ? 2 : 1) + ' s';
};
const fmtX = v => v == null || !isFinite(v) ? '—' : v.toFixed(2) + '×';
const pct = x => (x * 100).toFixed(1) + '%';

/* ---- scales ---- */
function niceScale(lo, hi, n = 5) {
  if (!(hi > lo)) hi = lo + 1;
  const raw = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  const max = Math.ceil(hi / step - 1e-9) * step, ticks = [];
  for (let v = lo; v <= max + step * 1e-6; v += step) ticks.push(+v.toPrecision(12));
  return {ticks, max, step};
}
function logTicks(lo, hi) {
  const t = [];
  for (let e = Math.round(Math.log10(lo)); e <= Math.round(Math.log10(hi)); e++) t.push(Math.pow(10, e));
  return t;
}
const fmtTick = v => v >= 1e6 ? (v / 1e6).toFixed(v % 1e6 ? 1 : 0) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(v % 1e3 ? 1 : 0) + 'k' : String(+v.toPrecision(3));

/* ---- line chart --------------------------------------------------------
   o.series: [{name,color,dash,dots,pts:[[x,y],...],tip:(x,y)=>string}]
   o.hlines: [{y,label,color,dash}]   o.xTicks: explicit x tick values
   o.xScale / o.yScale: 'lin' | 'log'  o.yFmt / o.xFmt: tick formatters        */
function lineChart(o) {
  const W = o.w || 520, H = o.h || 290, L = o.left || 62, R = 16, T = 14, B = 46;
  const pw = W - L - R, ph = H - T - B;
  const xLog = o.xScale === 'log', yLog = o.yScale === 'log';
  const xs = o.series.flatMap(s => s.pts.map(p => p[0]));
  const ys = o.series.flatMap(s => s.pts.map(p => p[1])).concat((o.hlines || []).map(h => h.y));
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  if (x1 === x0) { x0 -= 1; x1 += 1; }
  if (!xLog) { const pad = (x1 - x0) * 0.04 + (o.xPad || 0); x0 -= pad; x1 += pad; if (o.xMin != null) x0 = o.xMin; }
  else { x0 /= 1.25; x1 *= 1.25; }
  let y0, y1, yTicks;
  if (yLog) {
    const pos = ys.filter(v => v > 0);
    y0 = Math.pow(10, Math.floor(Math.log10(Math.min(...pos))));
    y1 = Math.pow(10, Math.ceil(Math.log10(Math.max(...pos))));
    if (y1 <= y0) y1 = y0 * 10;
    yTicks = logTicks(y0, y1);
  } else {
    y0 = o.yMin != null ? o.yMin : 0;
    const ns = niceScale(y0, o.yMax != null ? o.yMax : Math.max(...ys, 1e-12) * 1.05, 5);
    y1 = ns.max; yTicks = ns.ticks;
  }
  const lg = Math.log10;
  const sx = v => L + (xLog ? (lg(v) - lg(x0)) / (lg(x1) - lg(x0)) : (v - x0) / (x1 - x0)) * pw;
  const sy = v => T + ph - (yLog ? (lg(Math.max(v, y0)) - lg(y0)) / (lg(y1) - lg(y0)) : (v - y0) / (y1 - y0)) * ph;
  const yFmt = o.yFmt || fmtTick, xFmt = o.xFmt || fmtTick;
  const xTicks = o.xTicks || (xLog ? logTicks(x0 * 1.25, x1 / 1.25) : niceScale(Math.max(0, x0), x1, 5).ticks);

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || 'Line chart')}">`;
  yTicks.forEach(v => {
    s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/>`
       + `<text x="${L - 8}" y="${sy(v) + 4}" text-anchor="end">${esc(yFmt(v))}</text>`;
  });
  xTicks.forEach(v => {
    if (v < x0 - 1e-9 || v > x1 + 1e-9) return;
    s += `<text x="${sx(v)}" y="${H - B + 18}" text-anchor="middle">${esc(xFmt(v))}</text>`
       + `<line class="base" x1="${sx(v)}" x2="${sx(v)}" y1="${T + ph}" y2="${T + ph + 4}"/>`;
  });
  s += `<line class="base" x1="${L}" x2="${W - R}" y1="${T + ph}" y2="${T + ph}"/>`;
  if (o.xTitle) s += `<text class="axis-title" x="${L + pw / 2}" y="${H - 6}" text-anchor="middle">${esc(o.xTitle)}</text>`;
  (o.hlines || []).forEach(h => {
    const c = h.color || 'var(--seq)';
    s += `<line x1="${L}" x2="${W - R}" y1="${sy(h.y)}" y2="${sy(h.y)}" stroke="${c}" stroke-width="1.6" stroke-dasharray="${h.dash || '6 5'}"/>`
       + `<text class="ref-label" x="${W - R - 4}" y="${sy(h.y) - 7}" text-anchor="end" style="fill:${c}">${esc(h.label || '')}</text>`;
  });
  o.series.forEach(se => {
    if (!se.pts.length) return;
    const d = se.pts.map((p, i) => (i ? 'L' : 'M') + sx(p[0]).toFixed(1) + ' ' + sy(p[1]).toFixed(1)).join(' ');
    s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="${se.dash ? 1.8 : 2.6}" stroke-linejoin="round" stroke-linecap="round"${se.dash ? ` stroke-dasharray="${se.dash}"` : ''}/>`;
    if (se.dots !== false) se.pts.forEach(p => {
      const tip = se.tip ? se.tip(p[0], p[1]) : `${se.name}\n${xFmt(p[0])}: ${yFmt(p[1])}`;
      s += `<circle cx="${sx(p[0]).toFixed(1)}" cy="${sy(p[1]).toFixed(1)}" r="5" fill="${se.color}" data-tip="${esc(tip)}"/>`;
    });
  });
  return s + '</svg>';
}

/* ---- vertical bar chart (histograms, schedule comparison) ----------------
   o.bars: [{label,value,color,tip,display}]   o.log: use log10(1+v)            */
function barChart(o) {
  const W = o.w || 680, H = o.h || 290, L = o.left || 56, R = 10, T = 24, B = o.bottom || 50;
  const pw = W - L - R, ph = H - T - B, n = o.bars.length;
  const mx = Math.max(...o.bars.map(b => b.value), 1e-12);
  const f = o.log ? (v => Math.log10(1 + v)) : (v => v);
  let ticks, top;
  if (o.log) {
    const e = Math.max(1, Math.ceil(Math.log10(1 + mx)));
    ticks = [0]; for (let i = 1; i <= e; i++) ticks.push(Math.pow(10, i));
    top = f(ticks[ticks.length - 1]);
  } else {
    const ns = niceScale(0, mx * 1.08, 4); ticks = ns.ticks; top = ns.max;
  }
  const yFmt = o.yFmt || fmtTick;
  const sy = v => T + ph - (f(v) / top) * ph;
  const slot = pw / n, bw = Math.min(64, slot * 0.68);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || 'Bar chart')}">`;
  ticks.forEach(v => {
    s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/>`
       + `<text x="${L - 8}" y="${sy(v) + 4}" text-anchor="end">${esc(yFmt(v))}</text>`;
  });
  o.bars.forEach((b, i) => {
    const x = L + slot * i + (slot - bw) / 2, y = sy(b.value), h = Math.max(0, T + ph - y);
    s += `<rect class="bar-v" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${b.color}" data-tip="${esc(b.tip || b.label + '\n' + fmtN(b.value))}"/>`
       + `<text class="val" x="${(x + bw / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle">${esc(b.display != null ? b.display : fmtN(b.value))}</text>`
       + `<text x="${(x + bw / 2).toFixed(1)}" y="${H - B + 18}" text-anchor="middle">${esc(b.label)}</text>`;
  });
  s += `<line class="base" x1="${L}" x2="${W - R}" y1="${T + ph}" y2="${T + ph}"/>`;
  if (o.xTitle) s += `<text class="axis-title" x="${L + pw / 2}" y="${H - 6}" text-anchor="middle">${esc(o.xTitle)}</text>`;
  if (o.hline) {
    const c = o.hline.color || 'var(--seq)';
    s += `<line x1="${L}" x2="${W - R}" y1="${sy(o.hline.y)}" y2="${sy(o.hline.y)}" stroke="${c}" stroke-width="1.6" stroke-dasharray="6 5"/>`
       + `<text class="ref-label" x="${W - R - 4}" y="${sy(o.hline.y) - 7}" text-anchor="end" style="fill:${c}">${esc(o.hline.label || '')}</text>`;
  }
  return s + '</svg>';
}

/* ---- overlap strip: a document drawn as a bar, shared passages in yellow ---- */
function overlapStrip(ranges, id, label) {
  let s = `<svg viewBox="0 0 1000 28" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">`;
  ranges.forEach((r, i) => {
    s += `<rect class="seg-m" data-strip="${id}" data-i="${i}" x="${(r.from * 1000).toFixed(1)}" y="0" width="${Math.max(3, (r.to - r.from) * 1000).toFixed(1)}" height="28" data-tip="${esc('Shared passage ' + (i + 1) + ' · ' + r.words + ' words\nClick to jump to it')}"/>`;
  });
  return s + '</svg>';
}

/* ---- tooltips: any element with data-tip ---- */
(function () {
  const tip = () => document.getElementById('tip');
  document.addEventListener('mousemove', e => {
    const t = tip(); if (!t) return;
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) { t.classList.remove('on'); return; }
    t.textContent = el.getAttribute('data-tip');
    t.classList.add('on');
    const w = t.offsetWidth, h = t.offsetHeight;
    let x = e.clientX + 14, y = e.clientY + 16;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > innerHeight - 8) y = e.clientY - h - 14;
    t.style.left = x + 'px'; t.style.top = y + 'px';
  });
  document.addEventListener('mouseleave', () => { const t = tip(); if (t) t.classList.remove('on'); });
})();
