import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { PROJECTS, CONTACT } from "./data.js";
import { loadContent } from "./content.js";
import { initTheme, initDrawer, initLightbox, initAdmin, isAdmin, onAdminChange } from "./ui.js";

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const RING_R = 3.4;
const FIT = 2.9;
const ORANGE = 0xe5751f;

const stage = $("stage");
const canvas = $("gl");
const wrap = $("ring");

/* ---------- Renderer / scene ---------- */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(3, 6, 4);
scene.add(key);
const rim = new THREE.DirectionalLight(0xffffff, 0.4);
rim.position.set(-4, 3, -5);
scene.add(rim);

const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 120);
const camTarget = new THREE.Vector3();
const controls = new OrbitControls(camera, canvas);
Object.assign(controls, { enabled: false, enableDamping: true, dampingFactor: 0.08, enablePan: false, minDistance: 1.8, maxDistance: 11, rotateSpeed: 0.7 });
controls.maxPolarAngle = Math.PI * 0.52;

const ring = new THREE.Group();
scene.add(ring);

/* ---------- Content ---------- */
const projects = PROJECTS.map((p) => ({ ...p, photos: [] }));
const drawer = initDrawer();
initLightbox();
initAdmin();

/* ---------- Items ---------- */
const hitSphere = new THREE.SphereGeometry(1.3, 12, 8);
const hitMat = new THREE.MeshBasicMaterial({ visible: false });

function makeGhost() {
  const g = new THREE.Group();
  const geo = new THREE.IcosahedronGeometry(0.85, 1);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.75 }));
  const solid = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.08 }));
  g.add(solid, edges);
  g.userData.mats = [edges.material, solid.material];
  return g;
}

const items = projects.map((p, i) => {
  const phi = (i / projects.length) * TAU;
  const group = new THREE.Group();
  group.position.set(Math.sin(phi) * RING_R, 0, Math.cos(phi) * RING_R);
  const holder = new THREE.Group();
  const tilt = new THREE.Group();
  const spin = new THREE.Group();
  const hit = new THREE.Mesh(hitSphere, hitMat);
  const it = {
    p, i, phi, group, holder, tilt, spin, hit,
    vis: 1, visFrom: 1, hover: 0, mode: "ring",
    tiltAngle: 0.42, spinSpeed: 0.2, spinTarget: 0,
    ghost: null, root: null, parts: [], meshes: [], fitR: 1.4, fitY: 0.9,
  };
  hit.userData.item = it;
  it.ghost = makeGhost();
  spin.add(it.ghost);
  tilt.add(spin);
  holder.add(tilt, hit);
  group.add(holder);
  ring.add(group);
  tilt.rotation.x = it.tiltAngle;
  spin.rotation.y = i * 0.9;
  return it;
});

/* ---------- Model loading ---------- */
const CATEGORY_LIFT = {
  core: 0.45, motor: 0.62, cap: 1.05, mount: 0.4, arm: 0, tube: 0, beam: 0,
  socket: -0.28, insert: -0.5, gusset: 0.55, sleeve: 0.3, tjoint: -0.12, joint: 0.2,
};

function setupModel(it, gltf) {
  const root = gltf.scene;
  const geoCache = new Map();
  const meshes = [];
  const nodes = new Map();

  root.traverse((o) => {
    if (!o.isMesh) return;
    let g = geoCache.get(o.geometry.uuid);
    if (!g) {
      g = toCreasedNormals(o.geometry, Math.PI / 5);
      geoCache.set(o.geometry.uuid, g);
    }
    o.geometry = g;
    o.material = o.material.clone();
    o.material.emissive = new THREE.Color(0x000000);
    let n = o;
    while (n && n !== root && !(n.name || "").includes("|")) n = n.parent;
    if (n && n !== root) {
      o.userData.node = n;
      nodes.set(n, n);
    }
    meshes.push(o);
  });

  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const s = FIT / Math.max(size.x, size.z);
  root.position.sub(center);
  const pivot = new THREE.Group();
  pivot.scale.setScalar(s);
  pivot.add(root);

  // Explosion vectors: radial push (farther parts travel farther) plus a vertical offset per part category.
  const extent = Math.max(size.x, size.z);
  const parts = [...nodes.keys()].map((node) => {
    const [cat, label] = node.name.split("|");
    return { node, cat, label, base: node.position.clone(), dir: new THREE.Vector3() };
  });
  let maxR = 0;
  parts.forEach((pt) => (maxR = Math.max(maxR, Math.hypot(pt.base.x, pt.base.z))));
  parts.forEach((pt) => {
    const r = Math.hypot(pt.base.x, pt.base.z);
    const rn = r / (maxR || 1);
    if (r > 0.02) {
      const push = extent * 0.34 * (0.3 + 0.7 * rn);
      pt.dir.set((pt.base.x / r) * push, 0, (pt.base.z / r) * push);
    }
    pt.dir.y = (CATEGORY_LIFT[pt.cat] ?? 0.2) * extent * 0.2;
  });

  // Camera framing: radius and height of the fully exploded assembly, in ring units.
  let fitR = 0, fitY = 0;
  parts.forEach((pt) => {
    let rad = 0;
    pt.node.traverse((o) => {
      if (o.isMesh) {
        o.geometry.computeBoundingSphere();
        rad = Math.max(rad, o.geometry.boundingSphere.radius);
      }
    });
    const e = pt.base.clone().add(pt.dir);
    fitR = Math.max(fitR, Math.hypot(e.x, e.z) + rad);
    fitY = Math.max(fitY, Math.abs(e.y) + rad * 0.3);
  });
  it.fitR = fitR * s * 1.06;
  it.fitY = fitY * s + 0.35;

  it.spin.remove(it.ghost);
  it.ghost.traverse((o) => { o.geometry?.dispose(); });
  it.ghost = null;
  it.spin.add(pivot);
  it.root = root;
  it.parts = parts;
  it.meshes = meshes;
  it.spinSpeed = 0.16;
}

const loader = new GLTFLoader();
const progress = $("progress");
let loading = 0;
projects.forEach((p, i) => {
  if (!p.model) return;
  loading++;
  loader.load(
    p.model,
    (gltf) => {
      setupModel(items[i], gltf);
      if (--loading === 0) progress.style.opacity = "0";
    },
    (ev) => { if (ev.total) progress.style.width = Math.round((ev.loaded / ev.total) * 100) + "%"; },
    (err) => { console.warn("Model failed to load:", p.model, err); if (--loading === 0) progress.style.opacity = "0"; }
  );
});

/* ---------- Camera poses ---------- */
let aspect = 1;
let ringRx = RING_R;
function ringPose() {
  const v = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dist = Math.max(7.6, (ringRx + 1.5) / (v * aspect) - RING_R * 0.55);
  return { pos: new THREE.Vector3(0, 2.2 + dist * 0.28, RING_R + dist), target: new THREE.Vector3(0, 0.1, 0) };
}
function focusPose(it) {
  const v = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const d = Math.max((it.fitY + it.fitR * 0.45) / v, it.fitR / (v * aspect));
  return { pos: new THREE.Vector3(0, d * 0.4, RING_R + d), target: new THREE.Vector3(0, 0, RING_R) };
}

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  aspect = w / h;
  ringRx = RING_R * clamp(aspect / 1.25, 0.45, 1);
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

/* ---------- Tweens ---------- */
const tweens = [];
function tween(dur, fn, done) {
  const tw = { t: 0, dur: reduce ? 0.05 : dur, fn, done, dead: false };
  tweens.push(tw);
  return tw;
}

/* ---------- State ---------- */
let state = "ring"; // ring | zoom | focused | leaving
let active = null;
let ringTheta = 0;
let scrollDriven = true;
let exploded = 0;
let explodeTween = null;
let visible = true;
const pointerN = new THREE.Vector2();
const parallax = new THREE.Vector2();
const parallaxT = new THREE.Vector2();

new IntersectionObserver(([e]) => (visible = e.isIntersecting), { rootMargin: "100px" }).observe(wrap);

function setExplode(e) {
  exploded = e;
  if (active) for (const pt of active.parts) pt.node.position.copy(pt.base).addScaledVector(pt.dir, e);
  $("explode").value = String(e);
}

function scrollTarget() {
  const r = wrap.getBoundingClientRect();
  const total = Math.max(1, r.height - innerHeight);
  const p = clamp(-r.top / total, 0, 1);
  return -p * ((projects.length - 1) / projects.length) * TAU;
}

function hasDetails(p) {
  return isAdmin() || p.photos.length > 0 || Boolean(p.notes);
}
function updateHud() {
  if (!active) return;
  $("hud-title").textContent = active.p.title;
  $("explode-wrap").hidden = !(active.p.explode && active.root);
  $("open-drawer").hidden = !hasDetails(active.p);
}

/* ---------- Focus / leave ---------- */
function focus(it) {
  if (state !== "ring") return;
  state = "zoom";
  active = it;
  setTip(null);
  visible = true;
  document.documentElement.classList.add("lock");
  stage.classList.add("is-focused");
  stage.classList.remove("can-click");
  $("hud").hidden = false;
  updateHud();
  setExplode(0);

  const th0 = ringTheta;
  let th1 = -it.phi;
  th1 += Math.round((th0 - th1) / TAU) * TAU;
  const c0 = camera.position.clone();
  const t0 = camTarget.clone();
  const f = focusPose(it);
  scrollDriven = false;
  it.mode = "present";
  it.spinTarget = Math.round(it.spin.rotation.y / TAU) * TAU + 0.5;
  items.forEach((o) => (o.visFrom = o.vis));

  tween(1.6, (k0) => {
    const k = ease(k0);
    ringTheta = lerp(th0, th1, k);
    camera.position.lerpVectors(c0, f.pos, k);
    camTarget.lerpVectors(t0, f.target, k);
    for (const o of items) if (o !== it) o.vis = lerp(o.visFrom, 0, clamp(k * 1.5, 0, 1));
  }, () => {
    state = "focused";
    controls.maxDistance = Math.max(11, camera.position.distanceTo(f.target) * 1.3);
    controls.target.copy(camTarget);
    controls.enabled = true;
    controls.update();
    if (it.p.explode && it.root) {
      explodeTween = tween(2.2, (k) => setExplode(lerp(0, 1, ease(k))), () => (explodeTween = null));
    }
  });
}

function leave() {
  if (state !== "focused" && state !== "zoom") return;
  const it = active;
  const wasZoom = state === "zoom";
  state = "leaving";
  controls.enabled = false;
  drawer.close();
  setTip(null);
  if (explodeTween) explodeTween.dead = true;
  $("hud").hidden = true;

  const e0 = exploded;
  const c0 = camera.position.clone();
  const t0 = wasZoom ? camTarget.clone() : controls.target.clone();
  const r = ringPose();
  items.forEach((o) => (o.visFrom = o.vis));
  it.mode = "ring";

  tween(1.3, (k0) => {
    const k = ease(k0);
    setExplode(lerp(e0, 0, clamp(k * 1.7, 0, 1)));
    camera.position.lerpVectors(c0, r.pos, k);
    camTarget.lerpVectors(t0, r.target, k);
    for (const o of items) o.vis = lerp(o.visFrom, 1, k);
  }, () => {
    state = "ring";
    active = null;
    scrollDriven = true;
    stage.classList.remove("is-focused");
    document.documentElement.classList.remove("lock");
  });
}

$("close").addEventListener("click", leave);
$("explode").addEventListener("input", (e) => {
  if (explodeTween) explodeTween.dead = true;
  setExplode(parseFloat(e.target.value));
});
$("open-drawer").addEventListener("click", () => active && drawer.open(active.p));
addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (drawer.isOpen()) drawer.close();
  else leave();
});

drawer.onChange(() => { updateHud(); buildList(); });
onAdminChange(updateHud);

/* ---------- Picking / hover ---------- */
const raycaster = new THREE.Raycaster();
const tip = $("tip");
function setTip(html, ev) {
  if (!html) { tip.hidden = true; return; }
  tip.innerHTML = html;
  tip.hidden = false;
  if (ev) tip.style.left = ev.clientX + "px", tip.style.top = ev.clientY + "px";
}
function ndc(ev) {
  const r = canvas.getBoundingClientRect();
  pointerN.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  return pointerN;
}
function pickItem(ev) {
  raycaster.setFromCamera(ndc(ev), camera);
  const hits = raycaster.intersectObjects(items.filter((o) => o.vis > 0.5).map((o) => o.hit), false);
  return hits.length ? hits[0].object.userData.item : null;
}

let hovered = null;
let hoveredMesh = null;
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function setHoveredMesh(mesh) {
  if (hoveredMesh === mesh) return;
  if (hoveredMesh) hoveredMesh.material.emissive.setHex(0x000000);
  hoveredMesh = mesh;
  if (mesh) {
    mesh.material.emissive.setHex(ORANGE);
    mesh.material.emissiveIntensity = 0.55;
  }
}

canvas.addEventListener("pointermove", (ev) => {
  if (ev.pointerType === "touch") return;
  parallaxT.set((ev.clientX / innerWidth - 0.5) * 2, (ev.clientY / innerHeight - 0.5) * 2);
  if (state === "ring") {
    const it = pickItem(ev);
    hovered = it;
    stage.classList.toggle("can-click", Boolean(it));
    if (it) setTip(esc(it.p.title) + (it.root ? "" : "<small>Model coming</small>"), ev);
    else setTip(null);
  } else if (state === "focused" && active && active.meshes.length) {
    raycaster.setFromCamera(ndc(ev), camera);
    const h = raycaster.intersectObjects(active.meshes, false)[0];
    const label = h && h.object.userData.node ? h.object.userData.node.name.split("|")[1].replace(/_/g, " ") : null;
    setHoveredMesh(label ? h.object : null);
    setTip(label ? esc(label) : null, ev);
  }
});
canvas.addEventListener("pointerleave", () => { hovered = null; setHoveredMesh(null); setTip(null); stage.classList.remove("can-click"); });

let down = null;
canvas.addEventListener("pointerdown", (ev) => (down = { x: ev.clientX, y: ev.clientY }));
canvas.addEventListener("pointerup", (ev) => {
  if (!down) return;
  const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
  down = null;
  if (moved > 8 || state !== "ring") return;
  const it = pickItem(ev);
  if (it) focus(it);
});

/* ---------- Keyboard-accessible list ---------- */
function buildList() {
  const ul = $("project-list");
  ul.replaceChildren();
  for (const it of items) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Open " + it.p.title;
    b.addEventListener("click", () => focus(it));
    li.append(b);
    ul.append(li);
  }
}
buildList();

/* ---------- Footer ---------- */
(function footer() {
  const el = $("foot-links");
  const add = (href, text, ext) => {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    if (ext) { a.target = "_blank"; a.rel = "noopener"; }
    el.append(a);
  };
  if (CONTACT.email) add("mailto:" + CONTACT.email, "Email");
  if (CONTACT.github) add(CONTACT.github, "GitHub", true);
})();

/* ---------- Theme ---------- */
function applyTheme() {
  const accent = css("--accent");
  const dark = document.documentElement.dataset.theme === "dark";
  renderer.toneMappingExposure = dark ? 1.1 : 1.05;
  scene.environmentIntensity = dark ? 1.15 : 1;
  key.intensity = dark ? 1.6 : 1.2;
  rim.intensity = dark ? 2.6 : 0.4;
  for (const it of items) if (it.ghost) it.ghost.userData.mats.forEach((m) => m.color.set(accent));
}
initTheme(applyTheme);
applyTheme();

/* ---------- Saved content (titles, notes, photos) ---------- */
loadContent(projects).then((merged) => {
  merged.forEach((m, i) => Object.assign(projects[i], { title: m.title, notes: m.notes, photos: m.photos }));
  buildList();
  updateHud();
});

/* ---------- Loop ---------- */
let last = performance.now();
let t = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  t += dt;

  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    if (tw.dead) { tweens.splice(i, 1); continue; }
    tw.t += dt;
    const k = Math.min(1, tw.t / tw.dur);
    tw.fn(k);
    if (k >= 1) { tweens.splice(i, 1); tw.done && tw.done(); }
  }

  if (!visible && state === "ring") return;

  if (scrollDriven) ringTheta += (scrollTarget() - ringTheta) * (1 - Math.exp(-dt * 5));
  if (state === "ring") {
    parallax.lerp(parallaxT, 1 - Math.exp(-dt * 3));
    const r = ringPose();
    camera.position.copy(r.pos);
    if (!reduce) { camera.position.x += parallax.x * 0.45; camera.position.y += -parallax.y * 0.2; }
    camTarget.copy(r.target);
  }

  for (const it of items) {
    const a = it.phi + ringTheta;
    it.group.position.set(Math.sin(a) * ringRx, 0, Math.cos(a) * RING_R);
    const isActive = it === active && (state === "zoom" || state === "focused");
    const bob = reduce || isActive ? 0 : Math.sin(t * 0.9 + it.i * 1.7) * 0.07;
    it.holder.position.y += (bob - it.holder.position.y) * (1 - Math.exp(-dt * 6));
    it.hover += ((it === hovered && state === "ring" ? 1 : 0) - it.hover) * (1 - Math.exp(-dt * 10));
    const s = Math.max(it.vis * (1 + 0.06 * it.hover), 0.0001);
    it.holder.scale.setScalar(s);
    it.holder.visible = it.vis > 0.003;

    const wantTilt = isActive ? 0.12 : it.tiltAngle;
    it.tilt.rotation.x += (wantTilt - it.tilt.rotation.x) * (1 - Math.exp(-dt * 3));
    if (isActive) it.spin.rotation.y += (it.spinTarget - it.spin.rotation.y) * (1 - Math.exp(-dt * 3));
    else if (!reduce) it.spin.rotation.y += dt * it.spinSpeed;
  }

  if (state === "focused") controls.update();
  else camera.lookAt(camTarget);

  renderer.render(scene, camera);
});

if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  window.__site = { items, focus, leave, setExplode, get state() { return state; }, camera, controls };
}
