import * as THREE from "three";

export const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Parts are nodes named "Group|Label|index" (what the converter writes). A model from another tool has arbitrary
// node names and geometry in world space, so rebuild it into that shape: one centred mesh per original mesh.
export function normalizeModel(root) {
  let named = false;
  root.traverse((o) => {
    for (let n = o; n && !named; n = n.parent) if ((n.name || "").includes("|")) named = true;
  });
  if (named) return;

  root.updateMatrixWorld(true);
  const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });

  meshes.forEach((m, i) => {
    const geo = m.geometry.clone();
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, m.matrixWorld));
    geo.computeBoundingBox();
    const c = geo.boundingBox.getCenter(new THREE.Vector3());
    geo.translate(-c.x, -c.y, -c.z);

    let group = "Model";
    for (let n = m.parent; n && n !== root; n = n.parent) {
      if (n.name && n.name !== "Scene" && n.name !== "RootNode") { group = n.name; break; }
    }
    const label = (m.name || (m.parent && m.parent !== root && m.parent.name) || `Part ${i + 1}`).replace(/\|/g, " ");
    const mesh = new THREE.Mesh(geo, m.material);
    mesh.name = `${group.replace(/\|/g, " ")}|${label}|${i + 1}`;
    mesh.position.copy(c);
    if (m.parent) m.parent.remove(m);
    root.add(mesh);
  });
}

// Eigenvectors of a symmetric 3x3 matrix by Jacobi rotations (used to find a part's principal axes).
function principalAxes(cov) {
  const a = cov.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-18) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return [0, 1, 2].map((j) => [v[0][j], v[1][j], v[2][j]]);
}

// Size, surface area, and (when the mesh is closed) volume of a geometry given in metres, in the same units the
// site's CAD panel shows: millimetres, cm^2 and cm^3.
export function geometryStats(geo) {
  const pos = geo.attributes.position;
  const index = geo.index;
  const triCount = index ? index.count / 3 : pos.count / 3;
  const get = (i) => (index ? index.getX(i) : i);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cr = new THREE.Vector3();
  let area = 0, volume = 0;
  const edges = new Map();
  const edgeKey = (i, j) => (i < j ? i + "_" + j : j + "_" + i);
  const countEdges = triCount <= 400000;
  // Meshes from other tools often repeat a vertex once per face (for normals / UVs). Give coincident vertices one
  // shared id so a closed shape still counts as closed.
  const canon = new Int32Array(countEdges ? pos.count : 0);
  if (countEdges) {
    const seen = new Map();
    for (let i = 0; i < pos.count; i++) {
      const key = Math.round(pos.getX(i) * 1e6) + "," + Math.round(pos.getY(i) * 1e6) + "," + Math.round(pos.getZ(i) * 1e6);
      let id = seen.get(key);
      if (id === undefined) { id = seen.size; seen.set(key, id); }
      canon[i] = id;
    }
  }
  for (let t = 0; t < triCount; t++) {
    const i0 = get(t * 3), i1 = get(t * 3 + 1), i2 = get(t * 3 + 2);
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    cr.crossVectors(b.clone().sub(a), c.clone().sub(a));
    area += cr.length() / 2;
    volume += a.dot(cr.clone().crossVectors(b, c)) / 6;
    if (countEdges) {
      const c0 = canon[i0], c1 = canon[i1], c2 = canon[i2];
      for (const k of [edgeKey(c0, c1), edgeKey(c1, c2), edgeKey(c2, c0)]) edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  const watertight = countEdges && edges.size > 0 && [...edges.values()].every((n) => n === 2);

  // principal-axis extents, sampling very large meshes
  const step = Math.max(1, Math.floor(pos.count / 40000));
  const pts = [];
  for (let i = 0; i < pos.count; i += step) pts.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
  const mean = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) cov[r][q] += (p[r] - mean[r]) * (p[q] - mean[q]);
  const axes = principalAxes(cov);
  const extents = axes.map((ax) => {
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) {
      const d = (p[0] - mean[0]) * ax[0] + (p[1] - mean[1]) * ax[1] + (p[2] - mean[2]) * ax[2];
      lo = Math.min(lo, d); hi = Math.max(hi, d);
    }
    return hi - lo;
  }).sort((x, y) => y - x);

  return {
    extent_mm: extents.map((e) => Math.round(e * 10000) / 10),
    volume_cm3: watertight ? Math.round(Math.abs(volume) * 1e8) / 100 : null,
    area_cm2: Math.round(area * 1e5) / 10,
  };
}
