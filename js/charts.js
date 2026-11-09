// Dependency-free SVG charts (line and bar) driven by pasted CSV.
const NS = "http://www.w3.org/2000/svg";
const COLORS = ["var(--maroon)", "var(--orange)", "#5b8fa8", "#8a9a5b", "#b07aa1"];

const el = (name, attrs = {}, text) => {
  const n = document.createElementNS(NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = text;
  return n;
};

// First row is the header (x label, then one name per series). Cells split on comma, tab, or semicolon.
export function parseCsv(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const split = (l) => l.split(/[,\t;]/).map((c) => c.trim());
  const head = split(lines[0]);
  const rows = lines.slice(1).map(split).filter((r) => r.length >= 2);
  if (head.length < 2 || !rows.length) return null;
  return { head, rows };
}

function niceTicks(min, max, count = 5) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step * 0.5; v += step) ticks.push(+v.toPrecision(12));
  return ticks;
}

const fmt = (v) => (Math.abs(v) >= 1000 ? v.toLocaleString() : String(+v.toPrecision(4)));

export function renderChart(spec) {
  const data = parseCsv(spec.csv);
  const wrap = document.createElement("figure");
  wrap.className = "chart";
  if (!data) {
    const p = document.createElement("p");
    p.className = "chart-empty";
    p.textContent = "Add CSV data to draw this chart.";
    wrap.append(p);
    return wrap;
  }

  const W = 640, H = 340, m = { l: 56, r: 18, t: 18, b: 52 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const names = data.head.slice(1);
  const numericX = data.rows.every((r) => r[0] !== "" && !isNaN(parseFloat(r[0])));
  const bar = spec.kind === "bar";
  const xs = data.rows.map((r) => r[0]);
  const series = names.map((_, si) => data.rows.map((r) => parseFloat(r[si + 1])));
  const all = series.flat().filter((v) => !isNaN(v));
  if (!all.length) { wrap.textContent = "No numeric values found."; return wrap; }

  const lo = bar ? Math.min(0, ...all) : Math.min(...all);
  const hi = Math.max(...all);
  const yt = niceTicks(lo, hi);
  const y0 = yt[0], y1 = yt[yt.length - 1];
  const sy = (v) => m.t + ih - ((v - y0) / (y1 - y0)) * ih;

  let sx;
  const useLinear = numericX && !bar;
  if (useLinear) {
    const nx = xs.map(parseFloat);
    const xt = niceTicks(Math.min(...nx), Math.max(...nx), 6);
    const x0 = xt[0], x1 = xt[xt.length - 1];
    sx = (i) => m.l + ((nx[i] - x0) / (x1 - x0)) * iw;
    var xTickList = xt.map((v) => ({ v, x: m.l + ((v - x0) / (x1 - x0)) * iw, label: fmt(v) }));
  } else {
    const step = iw / xs.length;
    sx = (i) => m.l + step * (i + 0.5);
    xTickList = xs.map((label, i) => ({ x: sx(i), label })).filter((_, i) => xs.length <= 12 || i % Math.ceil(xs.length / 10) === 0);
  }

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": spec.title || "Chart", class: "chart-svg" });
  yt.forEach((v) => {
    svg.append(el("line", { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v), class: "grid" }));
    svg.append(el("text", { x: m.l - 8, y: sy(v) + 4, class: "tick", "text-anchor": "end" }, fmt(v)));
  });
  xTickList.forEach((t) => svg.append(el("text", { x: t.x, y: H - m.b + 18, class: "tick", "text-anchor": "middle" }, t.label)));
  svg.append(el("line", { x1: m.l, x2: W - m.r, y1: sy(Math.max(y0, Math.min(0, y1))), y2: sy(Math.max(y0, Math.min(0, y1))), class: "axis" }));
  svg.append(el("line", { x1: m.l, x2: m.l, y1: m.t, y2: m.t + ih, class: "axis" }));
  if (spec.xLabel) svg.append(el("text", { x: m.l + iw / 2, y: H - 8, class: "axis-label", "text-anchor": "middle" }, spec.xLabel));
  if (spec.yLabel) svg.append(el("text", { x: 14, y: m.t + ih / 2, class: "axis-label", "text-anchor": "middle", transform: `rotate(-90 14 ${m.t + ih / 2})` }, spec.yLabel));

  if (bar) {
    const group = iw / xs.length;
    const bw = Math.min(46, (group * 0.72) / series.length);
    series.forEach((vals, si) => {
      vals.forEach((v, i) => {
        if (isNaN(v)) return;
        const cx = sx(i) - (bw * series.length) / 2 + bw * si;
        const base = sy(Math.max(y0, 0));
        const top = sy(v);
        const r = el("rect", { x: cx, y: Math.min(top, base), width: bw - 2, height: Math.abs(base - top), fill: COLORS[si % COLORS.length], class: "bar" });
        r.append(el("title", {}, `${names[si]} · ${xs[i]}: ${fmt(v)}`));
        svg.append(r);
      });
    });
  } else {
    series.forEach((vals, si) => {
      const pts = vals.map((v, i) => (isNaN(v) ? null : [sx(i), sy(v)]));
      const d = pts.reduce((acc, p, i) => (p ? acc + (acc && pts[i - 1] ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1) : acc), "");
      svg.append(el("path", { d, fill: "none", stroke: COLORS[si % COLORS.length], "stroke-width": 2.4, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      pts.forEach((p, i) => {
        if (!p) return;
        const c = el("circle", { cx: p[0], cy: p[1], r: 3.6, fill: COLORS[si % COLORS.length], class: "pt" });
        c.append(el("title", {}, `${names[si]} · ${xs[i]}: ${fmt(vals[i])}`));
        svg.append(c);
      });
    });
  }

  if (spec.title) {
    const cap = document.createElement("figcaption");
    cap.textContent = spec.title;
    wrap.append(cap);
  }
  wrap.append(svg);
  if (names.length > 1) {
    const lg = document.createElement("div");
    lg.className = "legend";
    names.forEach((n, i) => {
      const s = document.createElement("span");
      s.innerHTML = '<i style="background:' + COLORS[i % COLORS.length] + '"></i>';
      s.append(document.createTextNode(n));
      lg.append(s);
    });
    wrap.append(lg);
  }
  return wrap;
}
