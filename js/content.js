// Reads the connection settings at call time (not import time) so they can be changed after the page loads.
export const getCfg = () => window.SITE_CONFIG || {};
export const isConfigured = () => {
  const c = getCfg();
  return Boolean(c.supabaseUrl && c.supabaseAnonKey);
};

export const photoUrl = (path) => `${getCfg().supabaseUrl}/storage/v1/object/public/photos/${path}`;
export const modelUrl = (path) => `${getCfg().supabaseUrl}/storage/v1/object/public/models/${path}`;

export async function rest(query) {
  const c = getCfg();
  const res = await fetch(`${c.supabaseUrl}/rest/v1/${query}`, {
    headers: { apikey: c.supabaseAnonKey, Authorization: "Bearer " + c.supabaseAnonKey },
  });
  if (!res.ok) throw new Error(res.status + " " + query);
  return res.json();
}

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

// The project list: the built-in projects from data.js, adjusted by anything saved from admin mode
// (renamed, hidden, or given a replacement model) plus any projects added from admin mode. Never throws.
export async function loadProjectList(defaults) {
  const base = defaults.map((p) => ({ ...p, source: "static", isDefault: true }));
  base.hiddenDefaults = [];
  if (!isConfigured()) return base;
  try {
    const rows = await withTimeout(rest("projects?select=*"), 3000);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out = [];
    const hidden = [];
    for (const p of base) {
      const row = byId.get(p.id);
      if (row && row.hidden) { hidden.push({ id: p.id, title: row.title || p.title }); continue; }
      if (row) {
        if (row.title) p.title = row.title;
        if (row.notes != null) p.notes = row.notes;
        if (row.model_path) {
          p.model = modelUrl(row.model_path);
          p.modelPath = row.model_path;
          p.cadMeta = row.model_meta || null;
          p.source = "db";
        }
      }
      out.push(p);
    }
    const known = new Set(defaults.map((d) => d.id));
    rows
      .filter((r) => !known.has(r.id) && !r.hidden && r.model_path)
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || String(a.updated_at).localeCompare(String(b.updated_at)))
      .forEach((r) =>
        out.push({
          id: r.id, title: r.title || r.id, notes: r.notes || "", explode: true, source: "db",
          model: modelUrl(r.model_path), modelPath: r.model_path, cadMeta: r.model_meta || null,
        })
      );
    out.hiddenDefaults = hidden;
    return out;
  } catch (err) {
    console.warn("Could not load the project list:", err);
    return base;
  }
}

// Merges saved titles, notes, and photos over the projects. Never throws.
export async function loadContent(projects) {
  const merged = projects.map((p) => ({ ...p, photos: [] }));
  if (!isConfigured()) return merged;
  try {
    const [rows, photos] = await Promise.all([
      rest("projects?select=*"),
      rest("photos?select=*&order=sort.asc,created_at.asc"),
    ]);
    for (const p of merged) {
      const row = rows.find((r) => r.id === p.id);
      if (row) {
        if (row.title) p.title = row.title;
        if (row.notes != null) p.notes = row.notes;
      }
      p.photos = photos
        .filter((x) => x.project_id === p.id)
        .map((x) => ({ id: x.id, path: x.path, caption: x.caption || "", url: photoUrl(x.path) }));
    }
  } catch (err) {
    console.warn("Could not load saved content:", err);
  }
  return merged;
}
