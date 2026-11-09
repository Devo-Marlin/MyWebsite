import { configured, photoUrl } from "./content.js";

const $ = (id) => document.getElementById(id);
const cfg = window.SITE_CONFIG || {};

/* ---------- Theme ---------- */
export function initTheme(onChange) {
  $("theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch (e) {}
    onChange(next);
  });
}

/* ---------- Admin (Supabase, loaded only when needed) ---------- */
let sb = null;
let admin = false;
const adminListeners = [];
export const isAdmin = () => admin;
export const onAdminChange = (fn) => adminListeners.push(fn);

async function client() {
  if (sb) return sb;
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  return sb;
}

function setAdmin(on) {
  admin = on;
  document.body.classList.toggle("is-admin", on);
  $("adminbar").hidden = !on;
  adminListeners.forEach((fn) => fn(on));
}

async function restoreSession() {
  if (!configured) return;
  const hasStored = Object.keys(localStorage).some((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
  if (!hasStored) return;
  try {
    const c = await client();
    const { data } = await c.auth.getSession();
    if (data.session) setAdmin(true);
  } catch (e) { /* stay read-only */ }
}

function initLogin() {
  const dlg = $("login");
  const err = $("login-err");
  const note = $("login-note");

  const open = () => {
    err.textContent = "";
    note.hidden = configured;
    note.textContent = configured ? "" : "Admin is not set up yet. Add your Supabase keys to config.js.";
    dlg.showModal();
    $("login-email").focus();
  };
  $("lock").addEventListener("click", () => (admin ? null : open()));
  $("login-cancel").addEventListener("click", () => dlg.close());
  if (location.hash === "#admin") open();

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!configured) { err.textContent = "Supabase keys are missing in config.js."; return; }
    err.textContent = "";
    try {
      const c = await client();
      const { error } = await c.auth.signInWithPassword({
        email: $("login-email").value.trim(),
        password: $("login-pass").value,
      });
      if (error) { err.textContent = error.message; return; }
      $("login-pass").value = "";
      dlg.close();
      setAdmin(true);
    } catch (ex) {
      err.textContent = "Could not reach Supabase.";
    }
  });

  $("signout").addEventListener("click", async () => {
    try { await (await client()).auth.signOut(); } catch (e) {}
    setAdmin(false);
  });
}

async function resizeImage(file, max = 2200) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.86));
}

/* ---------- Drawer (project notes and photos) ---------- */
export function initDrawer() {
  const drawer = $("drawer");
  let current = null;

  const status = (msg) => { $("status").textContent = msg || ""; };

  function render() {
    if (!current) return;
    const p = current;
    $("drawer-title").textContent = p.title;
    $("drawer-notes").textContent = p.notes || "";
    $("drawer-title-input").value = p.title;
    $("drawer-notes-input").value = p.notes || "";
    const grid = $("photos");
    grid.replaceChildren();
    for (const ph of p.photos) {
      const cell = document.createElement("div");
      cell.className = "photo";
      const img = document.createElement("img");
      img.src = ph.url;
      img.alt = ph.caption || p.title;
      img.loading = "lazy";
      img.addEventListener("click", () => openLightbox(ph.url, img.alt));
      cell.append(img);
      const del = document.createElement("button");
      del.className = "del";
      del.type = "button";
      del.setAttribute("aria-label", "Delete photo");
      del.textContent = "×";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this photo?")) return;
        try {
          const c = await client();
          await c.storage.from("photos").remove([ph.path]);
          await c.from("photos").delete().eq("id", ph.id);
          p.photos = p.photos.filter((x) => x.id !== ph.id);
          render();
          notify(p);
        } catch (ex) { status("Delete failed"); }
      });
      cell.append(del);
      grid.append(cell);
    }
    const editing = admin;
    $("drawer-title").hidden = editing;
    $("drawer-title-input").hidden = !editing;
    $("drawer-notes").hidden = editing;
    $("drawer-notes-input").hidden = !editing;
    $("admin-tools").hidden = !editing;
  }

  const listeners = [];
  const notify = (p) => listeners.forEach((fn) => fn(p));

  function open(project) {
    current = project;
    status("");
    render();
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
  }
  function close() {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
  }
  $("drawer-close").addEventListener("click", close);
  onAdminChange(() => { if (drawer.classList.contains("open")) render(); });

  $("save").addEventListener("click", async () => {
    if (!current || !admin) return;
    status("Saving…");
    try {
      const c = await client();
      const title = $("drawer-title-input").value.trim() || current.title;
      const notes = $("drawer-notes-input").value;
      const { error } = await c.from("projects").upsert({ id: current.id, title, notes, updated_at: new Date().toISOString() });
      if (error) throw error;
      current.title = title;
      current.notes = notes;
      render();
      notify(current);
      status("Saved");
    } catch (ex) { status("Save failed"); }
  });

  $("photo-input").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (!files.length || !current || !admin) return;
    try {
      const c = await client();
      let n = 0;
      for (const f of files) {
        status(`Uploading ${++n}/${files.length}…`);
        const blob = await resizeImage(f);
        const path = `${current.id}/${crypto.randomUUID()}.jpg`;
        const up = await c.storage.from("photos").upload(path, blob, { contentType: "image/jpeg" });
        if (up.error) throw up.error;
        const ins = await c.from("photos").insert({ project_id: current.id, path, caption: "" }).select().single();
        if (ins.error) throw ins.error;
        current.photos.push({ id: ins.data.id, path, caption: "", url: photoUrl(path) });
        render();
      }
      notify(current);
      status("Done");
    } catch (ex) { status("Upload failed"); }
  });

  return { open, close, onChange: (fn) => listeners.push(fn), isOpen: () => drawer.classList.contains("open") };
}

/* ---------- Lightbox ---------- */
function openLightbox(url, alt) {
  const lb = $("lightbox");
  lb.querySelector("img").src = url;
  lb.querySelector("img").alt = alt || "";
  lb.hidden = false;
}
export function initLightbox() {
  const lb = $("lightbox");
  lb.addEventListener("click", () => (lb.hidden = true));
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !lb.hidden) { lb.hidden = true; e.stopPropagation(); } }, true);
}

export function initAdmin() {
  initLogin();
  restoreSession();
}

export { client as getClient, resizeImage as prepareImage };

if (location.hostname === "localhost" || location.hostname === "127.0.0.1") window.__ui = { setAdmin };
