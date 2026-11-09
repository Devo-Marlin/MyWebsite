import { configured, photoUrl } from "./content.js?v=202611090i";
import { isAdmin, onAdminChange, getClient, prepareImage } from "./ui.js?v=202611090i";
import { renderChart } from "./charts.js?v=202611090i";

const $ = (id) => document.getElementById(id);
const cfg = window.SITE_CONFIG || {};
const remote = {}; // projectId -> { partKey: blocks[] }
const clone = (v) => JSON.parse(JSON.stringify(v));

export async function loadPartInfo(projectId) {
  if (!configured) return;
  try {
    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/parts?project_id=eq.${encodeURIComponent(projectId)}&select=key,blocks`, {
      headers: { apikey: cfg.supabaseAnonKey, Authorization: "Bearer " + cfg.supabaseAnonKey },
    });
    if (!res.ok) throw new Error(String(res.status));
    const rows = await res.json();
    remote[projectId] = Object.fromEntries(rows.map((r) => [r.key, r.blocks || []]));
  } catch (err) {
    console.warn("Could not load part pages:", err);
  }
}

/* ---------- Helpers ---------- */
function safeUrl(u) {
  try {
    const url = new URL(String(u || "").trim(), location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch (e) { return null; }
}
function embedUrl(u) {
  const href = safeUrl(u);
  if (!href) return null;
  const url = new URL(href);
  const host = url.hostname.replace(/^www\./, "");
  if (host === "youtube.com" && url.pathname === "/watch" && url.searchParams.get("v")) return "https://www.youtube.com/embed/" + url.searchParams.get("v");
  if (host === "youtu.be") return "https://www.youtube.com/embed/" + url.pathname.slice(1);
  if (host === "vimeo.com" && /^\/\d+/.test(url.pathname)) return "https://player.vimeo.com/video" + url.pathname;
  return href;
}
const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ---------- Block renderers (what visitors see) ---------- */
function renderText(b) {
  const root = h("div", "blk blk-text");
  const lines = String(b.text || "").split(/\r?\n/);
  let list = null, para = [];
  const flush = () => { if (para.length) { root.append(h("p", "", para.join(" "))); para = []; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); list = null; continue; }
    if (line.startsWith("# ")) { flush(); list = null; root.append(h("h3", "", line.slice(2))); }
    else if (/^[-*] /.test(line)) { flush(); if (!list) { list = h("ul"); root.append(list); } list.append(h("li", "", line.slice(2))); }
    else { list = null; para.push(line); }
  }
  flush();
  if (!root.children.length) root.append(h("p", "blk-empty", "Write about this part…"));
  return root;
}
function renderStats(b) {
  const dl = h("dl", "blk blk-stats");
  const rows = String(b.text || "").split(/\r?\n/).map((l) => l.split("|").map((c) => c.trim())).filter((r) => r[0] && r[1]);
  if (!rows.length) { dl.append(h("p", "blk-empty", "Add stats as: Label | Value")); return dl; }
  for (const [k, v] of rows) {
    const d = h("div");
    d.append(h("dt", "", k), h("dd", "", v));
    dl.append(d);
  }
  return dl;
}
function renderImage(b) {
  const fig = h("figure", "blk blk-image");
  const src = safeUrl(b.url);
  if (!src) { fig.append(h("p", "blk-empty", "Add an image")); return fig; }
  const img = h("img");
  img.src = src; img.alt = b.caption || ""; img.loading = "lazy";
  fig.append(img);
  if (b.caption) fig.append(h("figcaption", "", b.caption));
  return fig;
}
function renderEmbed(b) {
  const box = h("div", "blk blk-embed");
  const src = embedUrl(b.url);
  if (!src) { box.append(h("p", "blk-empty", "Add a simulation or page URL")); return box; }
  const f = h("iframe");
  f.src = src; f.loading = "lazy"; f.title = b.caption || "Embedded content";
  f.setAttribute("allowfullscreen", "");
  f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms");
  f.style.height = Math.min(1200, Math.max(200, parseInt(b.height, 10) || 480)) + "px";
  box.append(f);
  if (b.caption) box.append(h("p", "cap", b.caption));
  return box;
}
function renderVideo(b) {
  const box = h("div", "blk blk-video");
  const src = safeUrl(b.url);
  if (!src) { box.append(h("p", "blk-empty", "Add a video file URL")); return box; }
  const v = h("video");
  v.src = src; v.controls = true; v.playsInline = true; v.preload = "metadata";
  box.append(v);
  if (b.caption) box.append(h("p", "cap", b.caption));
  return box;
}
function renderChartBlock(b) {
  const box = h("div", "blk blk-chart");
  box.append(renderChart(b));
  return box;
}
const RENDER = { text: renderText, stats: renderStats, chart: renderChartBlock, image: renderImage, embed: renderEmbed, video: renderVideo };
const TYPE_NAMES = { text: "Text", stats: "Stats", chart: "Chart", image: "Image", embed: "Simulation / embed", video: "Video" };
const NEW_BLOCK = {
  text: () => ({ type: "text", text: "" }),
  stats: () => ({ type: "stats", text: "" }),
  chart: () => ({ type: "chart", kind: "line", title: "", xLabel: "", yLabel: "", csv: "" }),
  image: () => ({ type: "image", url: "", caption: "" }),
  embed: () => ({ type: "embed", url: "", height: 480, caption: "" }),
  video: () => ({ type: "video", url: "", caption: "" }),
};

/* ---------- Editor (admin only) ---------- */
function input(value, onInput, attrs = {}) {
  const i = h("input", "field");
  i.value = value ?? "";
  Object.entries(attrs).forEach(([k, v]) => i.setAttribute(k, v));
  i.addEventListener("input", () => onInput(i.value));
  return i;
}
function area(value, onInput, rows = 5, placeholder = "") {
  const t = h("textarea", "field");
  t.rows = rows; t.value = value ?? ""; t.placeholder = placeholder;
  t.addEventListener("input", () => onInput(t.value));
  return t;
}
function labelled(text, control) {
  const l = h("label", "ed-field");
  l.append(h("span", "", text), control);
  return l;
}

function editorFields(b, refresh) {
  const f = h("div", "ed-fields");
  switch (b.type) {
    case "text":
      f.append(area(b.text, (v) => { b.text = v; refresh(); }, 7, "Describe what this part does and why it was designed this way.\n\nStart a line with # for a heading, or - for a bullet."));
      break;
    case "stats":
      f.append(area(b.text, (v) => { b.text = v; refresh(); }, 6, "One per line:  Label | Value\nMax load | 12 kg\nMaterial | 6061-T6 aluminum"));
      break;
    case "chart": {
      const kind = h("select", "field");
      [["line", "Line"], ["bar", "Bar"]].forEach(([v, t]) => { const o = h("option", "", t); o.value = v; kind.append(o); });
      kind.value = b.kind || "line";
      kind.addEventListener("change", () => { b.kind = kind.value; refresh(); });
      f.append(labelled("Title", input(b.title, (v) => { b.title = v; refresh(); })));
      f.append(labelled("Type", kind));
      const axes = h("div", "ed-row");
      axes.append(labelled("X axis label", input(b.xLabel, (v) => { b.xLabel = v; refresh(); })), labelled("Y axis label", input(b.yLabel, (v) => { b.yLabel = v; refresh(); })));
      f.append(axes);
      f.append(labelled("Data (CSV - first row is the header)", area(b.csv, (v) => { b.csv = v; refresh(); }, 7, "Speed (m/s),Thrust (N),Current (A)\n0,52,18\n5,48,16\n10,41,14\n15,33,11")));
      break;
    }
    case "image": {
      f.append(labelled("Image URL", input(b.url, (v) => { b.url = v; refresh(); }, { placeholder: "https://…" })));
      const up = h("label", "pill");
      up.append(document.createTextNode("Upload image"));
      const file = h("input");
      file.type = "file"; file.accept = "image/*"; file.hidden = true;
      file.addEventListener("change", async () => {
        const fl = file.files[0];
        file.value = "";
        if (!fl) return;
        setStatus("Uploading…");
        try {
          const c = await getClient();
          const blob = await prepareImage(fl);
          const path = `parts/${ctx.project.id}/${ctx.key}/${crypto.randomUUID()}.jpg`;
          const r = await c.storage.from("photos").upload(path, blob, { contentType: "image/jpeg" });
          if (r.error) throw r.error;
          b.url = photoUrl(path);
          dirty = true;
          build();
          setStatus("Uploaded — press Save to keep it");
        } catch (e) { setStatus("Upload failed"); }
      });
      up.append(file);
      f.append(up, labelled("Caption", input(b.caption, (v) => { b.caption = v; refresh(); })));
      break;
    }
    case "embed":
      f.append(labelled("Page or simulation URL (also works with YouTube links)", input(b.url, (v) => { b.url = v; refresh(); }, { placeholder: "https://…" })));
      f.append(labelled("Height (px)", input(b.height, (v) => { b.height = v; refresh(); }, { type: "number", min: "200", max: "1200" })));
      f.append(labelled("Caption", input(b.caption, (v) => { b.caption = v; refresh(); })));
      break;
    case "video":
      f.append(labelled("Video file URL (.mp4 / .webm)", input(b.url, (v) => { b.url = v; refresh(); }, { placeholder: "https://…" })));
      f.append(labelled("Caption", input(b.caption, (v) => { b.caption = v; refresh(); })));
      break;
  }
  return f;
}

function editorCard(b, i) {
  const card = h("div", "blk-edit");
  const head = h("div", "ed-head");
  head.append(h("span", "ed-type", TYPE_NAMES[b.type] || b.type));
  const tools = h("div", "ed-tools");
  const btn = (txt, label, fn, disabled) => {
    const x = h("button", "ed-btn", txt);
    x.type = "button"; x.setAttribute("aria-label", label); x.disabled = Boolean(disabled);
    x.addEventListener("click", fn);
    return x;
  };
  tools.append(
    btn("↑", "Move up", () => { [blocks[i - 1], blocks[i]] = [blocks[i], blocks[i - 1]]; dirty = true; build(); }, i === 0),
    btn("↓", "Move down", () => { [blocks[i + 1], blocks[i]] = [blocks[i], blocks[i + 1]]; dirty = true; build(); }, i === blocks.length - 1),
    btn("×", "Delete block", () => { if (confirm("Delete this block?")) { blocks.splice(i, 1); dirty = true; build(); } })
  );
  head.append(tools);
  const preview = h("div", "ed-preview");
  const draw = () => preview.replaceChildren(RENDER[b.type](b));
  const refresh = () => { dirty = true; draw(); };
  draw();
  card.append(head, editorFields(b, refresh), preview);
  return card;
}

/* ---------- Sheet ---------- */
let ctx = null;
let blocks = [];
let dirty = false;
let armedAt = 0;
let onBack = () => {};
const setStatus = (t) => { const s = $("sheet-status"); if (s) s.textContent = t || ""; };

function cadSection(c) {
  const box = h("section", "cad");
  box.append(h("h3", "cad-title", "From the CAD model"));
  if (!c) { box.append(h("p", "blk-empty", "No CAD data for this part.")); return box; }
  const dl = h("dl", "blk-stats");
  const add = (k, v) => { const d = h("div"); d.append(h("dt", "", k), h("dd", "", v)); dl.append(d); };
  add("Quantity", "×" + c.count);
  add("Size", c.extent_mm.map((n) => +n.toFixed(1)).join(" × ") + " mm");
  if (c.volume_cm3 != null) add("Volume", c.volume_cm3.toLocaleString() + " cm³");
  add("Surface area", c.area_cm2.toLocaleString() + " cm²");
  box.append(dl);
  return box;
}

function build() {
  if (!ctx) return;
  $("sheet-kicker").textContent = ctx.project.title + " · Part";
  $("sheet-title").textContent = ctx.label;
  const chips = $("sheet-chips");
  chips.replaceChildren();
  if (ctx.cad) chips.append(h("span", "chip", "×" + ctx.cad.count + " in assembly"));
  $("sheet-cad").replaceChildren(cadSection(ctx.cad));

  const host = $("sheet-blocks");
  host.replaceChildren();
  if (isAdmin()) {
    blocks.forEach((b, i) => host.append(editorCard(b, i)));
  } else {
    blocks.forEach((b) => host.append(RENDER[b.type](b)));
  }

  const tools = $("sheet-tools");
  tools.hidden = !isAdmin();
  if (isAdmin() && !tools.dataset.ready) {
    tools.dataset.ready = "1";
    const add = $("sheet-add");
    Object.keys(NEW_BLOCK).forEach((t) => {
      const b = h("button", "pill", "+ " + TYPE_NAMES[t]);
      b.type = "button";
      b.addEventListener("click", () => { blocks.push(NEW_BLOCK[t]()); dirty = true; build(); });
      add.append(b);
    });
  }
}

async function save() {
  if (!ctx || !isAdmin()) return;
  setStatus("Saving…");
  try {
    const c = await getClient();
    const { error } = await c.from("parts").upsert({
      project_id: ctx.project.id, key: ctx.key, title: ctx.label, blocks, updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    (remote[ctx.project.id] ||= {})[ctx.key] = clone(blocks);
    dirty = false;
    setStatus("Saved");
  } catch (e) { setStatus("Save failed"); }
}

export function initSheet(opts) {
  onBack = opts.onBack;
  const scroller = $("sheet-scroll");
  // Leaving by button asks first if there are unsaved edits; leaving by scrolling is ignored while editing.
  const leave = (viaGesture) => {
    if (dirty && isAdmin()) {
      if (viaGesture) return;
      if (!confirm("Discard unsaved changes to this page?")) return;
    }
    dirty = false;
    onBack();
  };
  $("sheet-back").addEventListener("click", () => leave(false));

  // Scroll up past the top (wheel, trackpad, or pulling down on a phone) to return to the assembly.
  let acc = 0, accAt = 0;
  scroller.addEventListener("wheel", (e) => {
    if (!isSheetOpen()) return;
    const now = performance.now();
    if (scroller.scrollTop > 2 || e.deltaY >= 0) {
      acc = 0;
      if (scroller.scrollTop > 2) armedAt = now + 250;
      return;
    }
    if (now < armedAt) return;
    if (now - accAt > 400) acc = 0;
    accAt = now;
    acc += -e.deltaY;
    if (acc > 100) { acc = 0; leave(true); }
  }, { passive: true });

  let startY = null, startTop = 0;
  scroller.addEventListener("touchstart", (e) => { startY = e.touches[0].clientY; startTop = scroller.scrollTop; }, { passive: true });
  scroller.addEventListener("touchmove", (e) => {
    if (startY == null || startTop > 2 || performance.now() < armedAt) return;
    if (e.touches[0].clientY - startY > 90 && scroller.scrollTop <= 0) { startY = null; leave(true); }
  }, { passive: true });
  scroller.addEventListener("touchend", () => { startY = null; });
  $("sheet-save").addEventListener("click", save);
  onAdminChange(() => { if (isSheetOpen()) build(); });
}

export function openSheet(c) {
  ctx = c;
  blocks = clone((remote[c.project.id] || {})[c.key] || []);
  setStatus("");
  dirty = false;
  armedAt = performance.now() + 800;
  build();
  const s = $("sheet");
  s.classList.add("open");
  s.setAttribute("aria-hidden", "false");
  $("sheet-scroll").scrollTop = 0;
}

export function closeSheet() {
  const s = $("sheet");
  s.classList.remove("open");
  s.setAttribute("aria-hidden", "true");
}

export const isSheetOpen = () => $("sheet").classList.contains("open");
