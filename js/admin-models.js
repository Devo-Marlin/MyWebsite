import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { getClient, isAdmin } from "./ui.js?v=202611090m";
import { normalizeModel, geometryStats, slug } from "./normalize.js?v=202611090m";

const $ = (id) => document.getElementById(id);
const MAX_TOTAL_TRIS = 90000;
const MAX_UPLOAD = 45 * 1024 * 1024;
const idle = () => new Promise((r) => setTimeout(r, 0));
const reloadPage = () => (typeof window.__reloadOverride === "function" ? window.__reloadOverride() : location.reload());

/* ---------- Converting uploaded files ---------- */
const PALETTE = [
  ["#8c939c", 0.8, 0.42], ["#8c939c", 0.8, 0.42], ["#8c939c", 0.8, 0.42],
  ["#c3c8d0", 0.85, 0.35], ["#c3c8d0", 0.85, 0.35], ["#c3c8d0", 0.85, 0.35],
  ["#2a2d33", 0.6, 0.45], ["#2a2d33", 0.6, 0.45],
  ["#e8dfd2", 0.1, 0.8], ["#861f41", 0.45, 0.5], ["#e5751f", 0.5, 0.45],
];
const hash = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

function labelFromFilename(name) {
  let t = name.replace(/\.[^.]+$/, "");
  t = t.replace(/^\d+[\s_.-]*/, "");
  t = t.replace(/[-_]\d+$/, "").replace(/\s\(\d+\)$/, "");
  t = t.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return t || "Part";
}

// Merge the duplicate vertices of an STL triangle soup into an indexed mesh.
function weld(array) {
  const n = array.length / 3;
  const map = new Map();
  const out = [];
  const idx = new Uint32Array(n);
  const q = 1e6;
  for (let i = 0; i < n; i++) {
    const x = array[i * 3], y = array[i * 3 + 1], z = array[i * 3 + 2];
    const key = Math.round(x * q) + "," + Math.round(y * q) + "," + Math.round(z * q);
    let j = map.get(key);
    if (j === undefined) { j = out.length / 3; out.push(x, y, z); map.set(key, j); }
    idx[i] = j;
  }
  const faces = [];
  for (let t = 0; t < n; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a !== b && b !== c && a !== c) faces.push(a, b, c);
  }
  return { pos: new Float32Array(out), idx: Uint32Array.from(faces) };
}

// Reduce a mesh toward a triangle budget by merging vertices that share a grid cell.
function decimate(mesh, target) {
  const { pos, idx } = mesh;
  if (idx.length / 3 <= target) return mesh;
  const nv = pos.length / 3;
  const lo3 = [Infinity, Infinity, Infinity], hi3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) {
    lo3[k] = Math.min(lo3[k], pos[i * 3 + k]);
    hi3[k] = Math.max(hi3[k], pos[i * 3 + k]);
  }
  const diag = Math.hypot(hi3[0] - lo3[0], hi3[1] - lo3[1], hi3[2] - lo3[2]) || 1;
  const run = (cell) => {
    const map = new Map();
    const remap = new Int32Array(nv);
    const sums = [];
    for (let i = 0; i < nv; i++) {
      const kx = Math.floor((pos[i * 3] - lo3[0]) / cell), ky = Math.floor((pos[i * 3 + 1] - lo3[1]) / cell), kz = Math.floor((pos[i * 3 + 2] - lo3[2]) / cell);
      const key = kx + "," + ky + "," + kz;
      let j = map.get(key);
      if (j === undefined) { j = sums.length; map.set(key, j); sums.push([0, 0, 0, 0]); }
      remap[i] = j;
      const s = sums[j];
      s[0] += pos[i * 3]; s[1] += pos[i * 3 + 1]; s[2] += pos[i * 3 + 2]; s[3]++;
    }
    const newPos = new Float32Array(sums.length * 3);
    sums.forEach((s, j) => { newPos[j * 3] = s[0] / s[3]; newPos[j * 3 + 1] = s[1] / s[3]; newPos[j * 3 + 2] = s[2] / s[3]; });
    const faces = [];
    for (let t = 0; t < idx.length; t += 3) {
      const a = remap[idx[t]], b = remap[idx[t + 1]], c = remap[idx[t + 2]];
      if (a !== b && b !== c && a !== c) faces.push(a, b, c);
    }
    return { pos: newPos, idx: Uint32Array.from(faces) };
  };
  let lo = diag / 6000, hi = diag / 3, best = null;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    const r = run(mid);
    if (r.idx.length / 3 > target) lo = mid;
    else { hi = mid; best = r; }
  }
  return best || run(hi);
}

const toGeometry = (m) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.pos, 3));
  g.setIndex(new THREE.BufferAttribute(m.idx, 1));
  return g;
};

async function exportGlb(scene) {
  const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");
  return new Promise((resolve, reject) =>
    new GLTFExporter().parse(scene, (buf) => resolve(new Blob([buf], { type: "model/gltf-binary" })), reject, { binary: true })
  );
}

// Several STL files (one per part) -> one GLB with a named, centred mesh per part, plus the part stats.
async function convertStl(files, { unit, up }, status) {
  const { STLLoader } = await import("three/addons/loaders/STLLoader.js");
  const loader = new STLLoader();
  const raw = [];
  for (let i = 0; i < files.length; i++) {
    status(`Reading ${files[i].name} (${i + 1} of ${files.length})`);
    raw.push({ file: files[i], geo: loader.parse(await files[i].arrayBuffer()) });
    await idle();
  }

  const box = new THREE.Box3();
  raw.forEach((r) => { r.geo.computeBoundingBox(); box.union(r.geo.boundingBox); });
  const size = box.getSize(new THREE.Vector3());
  let upAxis = up;
  if (up === "auto") upAxis = size.z <= size.x && size.z <= size.y ? "z" : "y";

  const parts = [];
  for (let i = 0; i < raw.length; i++) {
    status(`Preparing ${raw[i].file.name} (${i + 1} of ${raw.length})`);
    const g = raw[i].geo;
    g.scale(unit, unit, unit);
    if (upAxis === "z") g.rotateX(-Math.PI / 2);
    const welded = weld(g.attributes.position.array);
    const label = labelFromFilename(raw[i].file.name);
    parts.push({ label, welded, stats: geometryStats(toGeometry(welded)), tris: welded.idx.length / 3 });
    await idle();
  }

  // share a triangle budget across the parts; small parts keep all of their detail
  const total = parts.reduce((s, p) => s + p.tris, 0);
  const small = parts.filter((p) => p.tris <= 1500);
  const bigTotal = total - small.reduce((s, p) => s + p.tris, 0);
  const budget = Math.max(MAX_TOTAL_TRIS - small.reduce((s, p) => s + p.tris, 0), 2000);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.tris > 1500) {
      status(`Simplifying ${p.label} (${i + 1} of ${parts.length})`);
      p.final = decimate(p.welded, Math.max(1500, Math.round(budget * (p.tris / bigTotal))));
      await idle();
    } else p.final = p.welded;
  }

  const gbox = new THREE.Box3();
  parts.forEach((p) => gbox.union(new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(p.final.pos, 3))));
  const shift = gbox.getCenter(new THREE.Vector3());

  const scene = new THREE.Scene();
  const info = {};
  const seen = {};
  for (const p of parts) {
    const geo = toGeometry(p.final);
    geo.computeBoundingBox();
    const c = geo.boundingBox.getCenter(new THREE.Vector3());
    geo.translate(-c.x, -c.y, -c.z);
    const [hex, metalness, roughness] = PALETTE[hash(p.label) % PALETTE.length];
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: hex, metalness, roughness, side: THREE.DoubleSide }));
    seen[p.label] = (seen[p.label] || 0) + 1;
    mesh.name = `Model|${p.label}|${seen[p.label]}`;
    mesh.position.copy(c).sub(shift);
    scene.add(mesh);
    const key = slug(p.label);
    if (!info[key]) info[key] = { key, label: p.label, category: "Model", count: 0, ...p.stats };
    info[key].count++;
  }
  status("Building the model file…");
  const blob = await exportGlb(scene);
  return { blob, meta: { parts: info }, size: gbox.getSize(new THREE.Vector3()), upAxis };
}

// A ready-made GLB: keep the file as it is and just measure its parts.
async function analyzeGlb(file, status) {
  status("Reading the model…");
  const buf = await file.arrayBuffer();
  const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(buf, "", resolve, reject));
  const root = gltf.scene;
  normalizeModel(root);
  root.updateMatrixWorld(true);
  const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const info = {};
  const box = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh) return;
    let n = o;
    while (n && n !== root && !(n.name || "").includes("|")) n = n.parent;
    const label = (n && n.name.includes("|") ? n.name.split("|")[1] : o.name || "Part").replace(/_/g, " ");
    const group = n && n.name.includes("|") ? n.name.split("|")[0].replace(/_/g, " ") : "Model";
    const geo = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, o.matrixWorld));
    geo.computeBoundingBox();
    box.union(geo.boundingBox);
    const key = slug(label);
    if (!info[key]) info[key] = { key, label, category: group, count: 0, ...geometryStats(geo) };
    info[key].count++;
  });
  return { blob: new Blob([buf], { type: "model/gltf-binary" }), meta: { parts: info }, size: box.getSize(new THREE.Vector3()) };
}

/* ---------- Saving to Supabase ---------- */
async function saveModel({ project, name, files, unit, up, status }) {
  const picked = [...files];
  const glb = picked.filter((f) => /\.glb$/i.test(f.name));
  const stl = picked.filter((f) => /\.stl$/i.test(f.name));
  if (picked.some((f) => /\.gltf$/i.test(f.name))) throw new Error("A .gltf needs its other files; please use a single .glb instead.");
  if (!glb.length && !stl.length) throw new Error("Choose a .glb file, or one or more .stl files.");
  if (glb.length && stl.length) throw new Error("Choose either one .glb or some .stl files, not both.");
  if (glb.length > 1) throw new Error("Choose just one .glb file.");

  const result = glb.length ? await analyzeGlb(glb[0], status) : await convertStl(stl, { unit, up }, status);
  if (result.blob.size > MAX_UPLOAD) {
    throw new Error(`The model is ${(result.blob.size / 1048576).toFixed(0)} MB, over the 45 MB limit. Use fewer or simpler parts.`);
  }
  status(`Uploading ${(result.blob.size / 1048576).toFixed(1)} MB…`);
  const c = await getClient();
  const id = project ? project.id : `${slug(name) || "model"}-${crypto.randomUUID().slice(0, 4)}`;
  const path = `${id}/${crypto.randomUUID()}.glb`;
  const up1 = await c.storage.from("models").upload(path, result.blob, { contentType: "model/gltf-binary" });
  if (up1.error) throw up1.error;

  let sort = 0;
  if (!project) {
    const rows = await c.from("projects").select("sort");
    sort = ((rows.data || []).reduce((m, r) => Math.max(m, r.sort || 0), 0)) + 1;
  }
  const row = { id, model_path: path, model_meta: result.meta, hidden: false, updated_at: new Date().toISOString() };
  if (project) row.title = project.title; else { row.title = name.trim(); row.sort = sort; }
  const saved = await c.from("projects").upsert(row);
  if (saved.error) throw saved.error;
  if (project && project.modelPath) await c.storage.from("models").remove([project.modelPath]).catch(() => {});
  return result;
}

async function deleteProject(project) {
  const c = await getClient();
  const photos = await c.from("photos").select("path").eq("project_id", project.id);
  const paths = (photos.data || []).map((p) => p.path);
  if (paths.length) await c.storage.from("photos").remove(paths);
  await c.from("photos").delete().eq("project_id", project.id);
  await c.from("parts").delete().eq("project_id", project.id);
  if (project.modelPath) await c.storage.from("models").remove([project.modelPath]);
  const res = project.isDefault
    ? await c.from("projects").upsert({ id: project.id, title: project.title, hidden: true, model_path: null, model_meta: null, updated_at: new Date().toISOString() })
    : await c.from("projects").delete().eq("id", project.id);
  if (res.error) throw res.error;
}

async function restoreProject(id) {
  const c = await getClient();
  const res = await c.from("projects").update({ hidden: false }).eq("id", id);
  if (res.error) throw res.error;
}

/* ---------- Interface ---------- */
let ready = false;

export function initAdminModels({ getActive, hiddenDefaults = [] }) {
  if (ready) return;
  ready = true;
  const dlg = $("model-dialog");
  const form = $("model-form");
  const status = (t, bad) => {
    const el = $("model-status");
    el.textContent = t || "";
    el.classList.toggle("bad", Boolean(bad));
  };
  let target = null; // null = new project, otherwise the project being replaced

  const open = (project) => {
    target = project || null;
    form.reset();
    status("");
    $("model-title").textContent = target ? `Replace the model for ${target.title}` : "Add a model";
    $("model-name-row").hidden = Boolean(target);
    $("model-name").required = !target;
    const restore = $("model-restore");
    restore.replaceChildren();
    restore.hidden = target || !hiddenDefaults.length;
    for (const h of hiddenDefaults) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pill";
      b.textContent = `Restore ${h.title}`;
      b.addEventListener("click", async () => {
        try { await restoreProject(h.id); reloadPage(); } catch (e) { status("Could not restore: " + (e.message || e), true); }
      });
      restore.append(b);
    }
    dlg.showModal();
  };

  $("admin-add").addEventListener("click", () => open(null));
  $("replace-model").addEventListener("click", () => { const p = getActive(); if (p) open(p); });
  $("model-cancel").addEventListener("click", () => dlg.close());
  $("model-files").addEventListener("change", () => {
    const stl = [...$("model-files").files].some((f) => /\.stl$/i.test(f.name));
    $("model-stl-opts").hidden = !stl;
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isAdmin()) { status("Sign in as admin first.", true); return; }
    const save = $("model-save");
    save.disabled = true;
    try {
      const r = await saveModel({
        project: target,
        name: $("model-name").value,
        files: $("model-files").files,
        unit: parseFloat($("model-units").value),
        up: $("model-up").value,
        status,
      });
      const s = r.size;
      status(`Saved. Model is ${s.x.toFixed(2)} × ${s.y.toFixed(2)} × ${s.z.toFixed(2)} m. Reloading…`);
      setTimeout(() => reloadPage(), 900);
    } catch (err) {
      status(err.message || String(err), true);
      save.disabled = false;
    }
  });

  $("delete-project").addEventListener("click", async () => {
    const p = getActive();
    if (!p) return;
    if (!confirm(`Delete "${p.title}"?\n\nThis removes its model, photos, and part pages from the site.`)) return;
    try { await deleteProject(p); reloadPage(); } catch (err) { alert("Could not delete: " + (err.message || err)); }
  });
}
