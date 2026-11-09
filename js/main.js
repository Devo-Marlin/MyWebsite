import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { PROJECTS, CONTACT } from "./data.js";
import { loadContent } from "./content.js";
import { initTheme, initDrawer, initLightbox, initAdmin, isAdmin, onAdminChange } from "./ui.js";
import { initSheet, openSheet, closeSheet, loadPartInfo } from "./sheet.js";

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const FIT = 3.8;
const GHOST_SCALE = 1.75;
const ORANGE = 0xe5751f;
let exScale = 1;
let active = null;
let exploded = 0;
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

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
const hitSphere = new THREE.SphereGeometry(FIT * 0.5, 14, 10);
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
  const group = new THREE.Group();
  const holder = new THREE.Group();
  const tilt = new THREE.Group();
  const spin = new THREE.Group();
  const hit = new THREE.Mesh(hitSphere, hitMat);
  const it = {
    p, i, group, holder, tilt, spin, hit, home: new THREE.Vector3(),
    vis: 1, visFrom: 1, hover: 0, mode: "browse",
    tiltAngle: 0.42, spinSpeed: 0.1, spinTarget: 0,
    ghost: null, root: null, parts: [], meshes: [], fitR: 1.9, fitY: 1.2,
  };
  hit.userData.item = it;
  it.ghost = makeGhost();
  it.ghost.scale.setScalar(GHOST_SCALE);
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

  // Models without the drone's hand-tuned categories explode by group: each sub-assembly moves away from the
  // overall centre, and its parts spread out around the sub-assembly's own centre.
  if (!parts.some((pt) => pt.cat in CATEGORY_LIFT)) {
    const centre = new THREE.Vector3();
    parts.forEach((pt) => centre.add(pt.base));
    centre.divideScalar(parts.length || 1);
    const groups = new Map();
    parts.forEach((pt) => {
      const g = groups.get(pt.cat) || { sum: new THREE.Vector3(), n: 0 };
      g.sum.add(pt.base);
      g.n++;
      groups.set(pt.cat, g);
    });
    parts.forEach((pt) => {
      const g = groups.get(pt.cat);
      const gc = g.sum.clone().divideScalar(g.n);
      pt.dir.copy(gc).sub(centre).multiplyScalar(0.9).addScaledVector(pt.base.clone().sub(gc), 0.55);
    });
  }

  parts.forEach((pt) => {
    // Bounding-box corners relative to the part's centre, used to frame the camera around the exploded shape.
    pt.corners = [];
    pt.node.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      const { min, max } = o.geometry.boundingBox;
      for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
        pt.corners.push(new THREE.Vector3(x, y, z).applyMatrix4(pt.node.matrix).sub(pt.node.position));
      }
    });
    pt.key = slug(pt.label);
  });
  it.s = s;
  computeFit(it);

  it.spin.remove(it.ghost);
  it.ghost.traverse((o) => { o.geometry?.dispose(); });
  it.ghost = null;
  it.spin.add(pivot);
  it.root = root;
  it.parts = parts;
  it.meshes = meshes;
  it.spinSpeed = 0.08;
}

// Camera framing: radius and height of the exploded assembly, in scene units.
function computeFit(it) {
  let fitR = 0, fitY = 0;
  for (const pt of it.parts) {
    const e = pt.base.clone().addScaledVector(pt.dir, exScale);
    for (const c of pt.corners) {
      fitR = Math.max(fitR, Math.hypot(e.x + c.x, e.z + c.z));
      fitY = Math.max(fitY, Math.abs(e.y + c.y));
    }
  }
  it.fitR = fitR * it.s * 1.1;
  it.fitY = fitY * it.s + 0.35;
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
      fetch(p.model.replace(/\.glb$/, "-parts.json")).then((r) => r.json()).then((j) => (items[i].cad = j.parts)).catch(() => {});
      if (--loading === 0) progress.style.opacity = "0";
    },
    (ev) => { if (ev.total) progress.style.width = Math.round((ev.loaded / ev.total) * 100) + "%"; },
    (err) => { console.warn("Model failed to load:", p.model, err); if (--loading === 0) progress.style.opacity = "0"; }
  );
});

/* ---------- Camera poses ---------- */
let aspect = 1;
let camY = 0;
const metrics = { dist: 8, halfH: 2.3, spacing: 3, xoff: 1.2, bias: 0 };

// Staggered stack: models alternate left and right, each one below the last; the camera travels down with scroll.
function layout() {
  const v = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const m = metrics;
  const portrait = aspect < 0.9;
  // On phones the models fill most of the screen width, sit closer together, and the first one starts high on the screen.
  m.dist = Math.max(6.8, (FIT * (portrait ? 0.68 : 0.85)) / (v * aspect));
  m.halfH = m.dist * v;
  const halfW = m.halfH * aspect;
  m.spacing = portrait ? Math.max(FIT * 0.95, m.halfH * 0.8) : Math.max(FIT * 0.66, m.halfH * 1.3);
  m.xoff = halfW * (portrait ? 0.13 : 0.34);
  m.bias = portrait ? m.halfH * 0.72 : 0;
  items.forEach((it, i) => {
    it.home.set((i % 2 === 0 ? -1 : 1) * m.xoff, -i * m.spacing, 0);
    it.group.position.copy(it.home);
  });
  // Page length follows the stack so models move 1:1 with the finger / wheel and there is no dead scrolling.
  const sh = stage.clientHeight;
  const travel = (items.length - 1) * m.spacing * (sh / (2 * m.halfH));
  wrap.style.height = Math.round(sh + travel + sh * 0.2) + "px";
}
function browsePose() {
  return {
    pos: new THREE.Vector3(0, camY + metrics.dist * 0.14, metrics.dist),
    target: new THREE.Vector3(0, camY, 0),
  };
}
function focusPose(it) {
  const v = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const d = Math.max((it.fitY + it.fitR * 0.45) / v, it.fitR / (v * aspect));
  return { pos: it.home.clone().add(new THREE.Vector3(0, d * 0.4, d)), target: it.home.clone() };
}

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  aspect = w / h;
  exScale = clamp(aspect, 0.55, 1);
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  layout();
  if (active) { computeFit(active); setExplode(exploded); }
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
let state = "ring"; // ring (browsing the stack) | zoom | focused | leaving
let camYTarget = 0;
let explodeTween = null;
let visible = true;
const pointerN = new THREE.Vector2();
const parallax = new THREE.Vector2();
const parallaxT = new THREE.Vector2();

new IntersectionObserver(([e]) => (visible = e.isIntersecting), { rootMargin: "100px" }).observe(wrap);

function setExplode(e) {
  exploded = e;
  if (active) for (const pt of active.parts) pt.node.position.copy(pt.base).addScaledVector(pt.dir, e * exScale);
  $("explode").value = String(e);
}

function scrollTarget() {
  const r = wrap.getBoundingClientRect();
  const total = Math.max(1, r.height - stage.clientHeight);
  const p = clamp(-r.top / total, 0, 1);
  return -p * (projects.length - 1) * metrics.spacing - metrics.bias * (1 - p);
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
  document.documentElement.classList.add("no-scroll");
  stage.classList.add("is-focused");
  stage.classList.remove("can-click");
  $("hud").hidden = false;
  updateHud();
  setExplode(0);

  const c0 = camera.position.clone();
  const t0 = camTarget.clone();
  computeFit(it);
  const f = focusPose(it);
  it.mode = "present";
  it.spinTarget = Math.round(it.spin.rotation.y / TAU) * TAU + 0.5;
  items.forEach((o) => (o.visFrom = o.vis));

  tween(1.6, (k0) => {
    const k = ease(k0);
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
  const r = browsePose();
  items.forEach((o) => (o.visFrom = o.vis));
  it.mode = "browse";

  tween(1.3, (k0) => {
    const k = ease(k0);
    setExplode(lerp(e0, 0, clamp(k * 1.7, 0, 1)));
    camera.position.lerpVectors(c0, r.pos, k);
    camTarget.lerpVectors(t0, r.target, k);
    for (const o of items) o.vis = lerp(o.visFrom, 1, k);
  }, () => {
    state = "ring";
    active = null;
    stage.classList.remove("is-focused");
    document.documentElement.classList.remove("no-scroll");
  });
}

/* ---------- Part focus (click a part, scroll for its page) ---------- */
let partCtx = null;
let partTween = null;
let dimK = 0;

function orbitPose(o, extra) {
  const az = o.az + extra;
  return {
    pos: new THREE.Vector3(o.center.x + Math.sin(az) * Math.cos(o.el) * o.d, o.center.y + Math.sin(o.el) * o.d, o.center.z + Math.cos(az) * Math.cos(o.el) * o.d),
    target: new THREE.Vector3(o.center.x, o.center.y - o.shift, o.center.z),
  };
}

function setDim(k) {
  dimK = k;
  if (!partCtx) return;
  for (const m of partCtx.it.meshes) {
    const mat = m.material;
    if (partCtx.same.has(m)) {
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
      mat.emissive.setHex(k > 0.001 ? ORANGE : 0x000000);
      mat.emissiveIntensity = 0.16 * k;
    } else {
      mat.transparent = k > 0.001;
      mat.opacity = lerp(1, 0.07, k);
      mat.depthWrite = k < 0.6;
      mat.emissive.setHex(0x000000);
    }
  }
}

function enterPart(it, mesh) {
  if (state !== "focused") return;
  const node = mesh.userData.node;
  if (!node) return;
  const [cat, rawLabel] = node.name.split("|");
  const label = rawLabel.replace(/_/g, " ");
  const key = slug(label);
  state = "part-in";
  controls.enabled = false;
  setHoveredMesh(null);
  setTip(null);
  stage.classList.remove("can-click");
  $("hud").hidden = true;

  const same = new Set(it.meshes.filter((m) => m.userData.node && m.userData.node.name.split("|")[1] === rawLabel));
  mesh.updateWorldMatrix(true, false);
  if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
  const bs = mesh.geometry.boundingSphere;
  const center = bs.center.clone().applyMatrix4(mesh.matrixWorld);
  const sc = new THREE.Vector3();
  mesh.getWorldScale(sc);
  const radius = bs.radius * Math.max(sc.x, sc.y, sc.z);
  const v = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const d = Math.max(radius / (0.3 * v), radius / (0.38 * v * aspect), 0.3);
  const orbit = {
    center, d, el: 0.5, spin: 0,
    az: Math.atan2(camera.position.x - center.x, camera.position.z - center.z),
    shift: d * v * 0.46,
  };
  const c0 = camera.position.clone();
  const t0 = controls.target.clone();
  partCtx = { it, mesh, key, label, same, orbit, c0, t0 };
  const pose = orbitPose(orbit, 0);
  camTarget.copy(t0);
  openSheet({ project: it.p, key, label, category: cat, cad: it.cad && it.cad[key] });
  partTween = tween(1.3, (k0) => {
    const k = ease(k0);
    camera.position.lerpVectors(c0, pose.pos, k);
    camTarget.lerpVectors(t0, pose.target, k);
    setDim(k);
  }, () => { state = "part"; partTween = null; });
}

function leavePart() {
  if (state !== "part" && state !== "part-in") return;
  const pc = partCtx;
  if (partTween) partTween.dead = true;
  state = "part-out";
  closeSheet();
  const c0 = camera.position.clone();
  const t0 = camTarget.clone();
  const k0 = dimK;
  tween(1.1, (k) => {
    const e = ease(k);
    camera.position.lerpVectors(c0, pc.c0, e);
    camTarget.lerpVectors(t0, pc.t0, e);
    setDim(lerp(k0, 0, e));
  }, () => {
    setDim(0);
    state = "focused";
    controls.target.copy(pc.t0);
    controls.enabled = true;
    controls.update();
    partCtx = null;
    $("hud").hidden = false;
  });
}
initSheet({ onBack: leavePart });

$("close").addEventListener("click", leave);
$("explode").addEventListener("input", (e) => {
  if (explodeTween) explodeTween.dead = true;
  setExplode(parseFloat(e.target.value));
});
$("open-drawer").addEventListener("click", () => active && drawer.open(active.p));
addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (state === "part" || state === "part-in") { leavePart(); return; }
  if (drawer.isOpen()) drawer.close();
  else leave();
});

drawer.onChange(() => { updateHud(); buildList(); updateLabelText(); });
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
    stage.classList.toggle("can-click", Boolean(label));
    setTip(label ? esc(label) + "<small>Details</small>" : null, ev);
  }
});
canvas.addEventListener("pointerleave", () => { hovered = null; setHoveredMesh(null); setTip(null); stage.classList.remove("can-click"); });

let down = null;
canvas.addEventListener("pointerdown", (ev) => (down = { x: ev.clientX, y: ev.clientY }));
canvas.addEventListener("pointerup", (ev) => {
  if (!down) return;
  const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
  down = null;
  if (moved > 8) return;
  if (state === "focused" && active && active.meshes.length) {
    raycaster.setFromCamera(ndc(ev), camera);
    const hit = raycaster.intersectObjects(active.meshes, false)[0];
    if (hit && hit.object.userData.node) enterPart(active, hit.object);
    return;
  }
  if (state !== "ring") return;
  const it = pickItem(ev);
  if (it) focus(it);
});

/* ---------- Name labels (opposite side of each model) ---------- */
const labelsEl = $("labels");
const labelEls = items.map((it) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "label";
  b.innerHTML = '<span class="n"></span><span class="t"></span>';
  b.querySelector(".n").textContent = String(it.i + 1).padStart(2, "0");
  b.addEventListener("click", () => focus(it));
  labelsEl.append(b);
  return b;
});
function updateLabelText() {
  items.forEach((it, i) => (labelEls[i].querySelector(".t").textContent = it.p.title));
}
updateLabelText();

const projectV = new THREE.Vector3();
function updateLabels() {
  const w = stage.clientWidth, h = stage.clientHeight;
  const portrait = aspect < 0.9;
  items.forEach((it, i) => {
    const el = labelEls[i];
    projectV.copy(it.home).project(camera);
    const sy = (-projectV.y * 0.5 + 0.5) * h;
    const sx = (projectV.x * 0.5 + 0.5) * w;
    const modelOnLeft = i % 2 === 0;
    const fade = state === "ring" ? clamp(1.2 - Math.abs(sy - h / 2) / (h * 0.55), 0, 1) : 0;
    el.style.opacity = fade.toFixed(3);
    el.classList.toggle("below", portrait);
    el.classList.toggle("right", !portrait && !modelOnLeft);
    let x, y = sy, tx = "0", ty = "-50%";
    if (portrait) {
      x = w / 2; y = sy + h * 0.17; tx = "-50%"; ty = "0";
    } else if (modelOnLeft) {
      x = w * 0.66;
    } else {
      x = w * 0.34; tx = "-100%";
    }
    el.style.transform = `translate(${x}px, ${y}px) translate(${tx}, ${ty})`;
  });
}

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
projects.forEach((p) => { if (p.model) loadPartInfo(p.id); });
loadContent(projects).then((merged) => {
  merged.forEach((m, i) => Object.assign(projects[i], { title: m.title, notes: m.notes, photos: m.photos }));
  buildList();
  updateLabelText();
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

  if (state === "part" && partCtx) {
    if (!reduce) partCtx.orbit.spin += dt * 0.14;
    const p = orbitPose(partCtx.orbit, partCtx.orbit.spin);
    camera.position.copy(p.pos);
    camTarget.copy(p.target);
  }
  camYTarget = scrollTarget();
  camY += (camYTarget - camY) * (1 - Math.exp(-dt * 6));
  if (state === "ring") {
    parallax.lerp(parallaxT, 1 - Math.exp(-dt * 3));
    const r = browsePose();
    camera.position.copy(r.pos);
    if (!reduce) { camera.position.x += parallax.x * 0.4; camera.position.y += -parallax.y * 0.18; }
    camTarget.copy(r.target);
  }

  for (const it of items) {
    const isActive = it === active && state !== "ring" && state !== "leaving";
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
  camera.updateMatrixWorld();
  updateLabels();

  renderer.render(scene, camera);
});

if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  window.__site = { items, focus, leave, setExplode, enterPart, leavePart, get state() { return state; }, camera, controls };
}
