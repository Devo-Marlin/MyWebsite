const cfg = window.SITE_CONFIG || {};
export const configured = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);

const headers = { apikey: cfg.supabaseAnonKey, Authorization: "Bearer " + cfg.supabaseAnonKey };

export function photoUrl(path) {
  return `${cfg.supabaseUrl}/storage/v1/object/public/photos/${path}`;
}

async function rest(query) {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${query}`, { headers });
  if (!res.ok) throw new Error(res.status + " " + query);
  return res.json();
}

// Merges saved titles, notes, and photos over the defaults in data.js. Never throws.
export async function loadContent(projects) {
  const merged = projects.map((p) => ({ ...p, photos: [] }));
  if (!configured) return merged;
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
