// ==UserScript==
// @name         Savings City – giant monster
// @namespace    savings-city-tweaks
// @version      1.2
// @description  A 👾 button releases a giant green monster with round glasses that walks into the city and smashes buildings into solid chunks. Only in your browser – reload to rebuild.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * How it works
 * ------------
 * - The creature is built from simple shapes (egg-shaped body, tufts, big eyes, round glasses,
 *   short arms, stubby legs with claws) with mottled green colours, animated by hand: it walks
 *   with swaying body and swinging arms, blinks, and looks at what it is about to smash.
 * - It enters from outside the city, walks to the nearest building, and punches it. The building
 *   is a solid: the boxes its walls are made of (one facade mesh per building) are cut into
 *   convex chunks with the facade (windows, colours) on the outside and broken concrete inside –
 *   the same way the nuke script does it. A low, jagged stump stays. The chunks break loose
 *   starting where the fist hit, are pushed away from the monster (upper floors more), tumble,
 *   land and come to rest. Dust rolls out.
 * - Every footstep shakes the view; residents underfoot are squashed (residents script), others
 *   flee; cars underfoot are flattened.
 * - Click the button again to send the monster away. Nothing is sent to the server: reload the
 *   page and the city is back.
 */
(function () {
  'use strict';

  // ---- settings (tiles; 1 tile ≈ 20 m) ----
  const MONSTER_HEIGHT = 2.6;      // top of the head (≈ 50 m); the tallest buildings are ~3
  const WALK_SPEED = 0.55;         // tiles per second
  const TURN_SPEED = 1.4;          // radians per second
  const PUNCH_FORCE = 3;           // how hard the chunks are pushed away (tiles per second, top floors)
  const CRACK_SPEED = 2.5;         // how fast the break runs through a building from where it was hit
  const CHUNK_SIZE = 0.2;          // chunk size (as in the nuke script)
  const STUMP = 0.12;              // a stump up to this high stays standing (jagged)
  const RUIN_COLUMN = 0.3;
  const SHAKE = 10;                // camera shake per footstep (pixels)
  const SOUND = true;
  // -------------------------------------------

  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const JF = [0.04, 0.96];
  let scene = null, renderer = null, K = null;
  const hook = window.__THREE_DEVTOOLS__ || (window.__THREE_DEVTOOLS__ = new EventTarget());
  hook.addEventListener('observe', (e) => {
    const r = e.detail;
    if (!r || !r.isWebGLRenderer || r.__scMonster) return;
    r.__scMonster = true; renderer = r;
    const orig = r.render;
    r.render = function (s, c) { if (!scene && s && s.isScene && c && c.isOrthographicCamera) scene = s; return orig.apply(this, arguments); };
  });
  // the traffic list (same trick as the other scripts)
  let trafficCars = null;
  const origForEach = Array.prototype.forEach;
  Array.prototype.forEach = function () {
    if (this !== trafficCars && this.length) { const c = this[0]; if (c && typeof c === 'object' && typeof c.base === 'number' && typeof c.heading === 'number' && 'from' in c && 'to' in c) trafficCars = this; }
    return origForEach.apply(this, arguments);
  };

  function classes() {
    if (K) return K;
    let mesh = null, lambert = null, color = null;
    scene.traverse((o) => {
      if (!mesh && o.isMesh && !o.isInstancedMesh && o.geometry && o.geometry.attributes.position) mesh = o;
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of ms) { if (!lambert && m.isMeshLambertMaterial) lambert = m; if (!color && m.color && m.color.isColor) color = m.color; }
    });
    if (!mesh || !lambert || !color) return null;
    let proto = Object.getPrototypeOf(mesh.geometry);
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'translate')) proto = Object.getPrototypeOf(proto);
    let o3 = Object.getPrototypeOf(scene);
    while (o3 && !Object.prototype.hasOwnProperty.call(o3, 'add')) o3 = Object.getPrototypeOf(o3);
    K = { Mesh: mesh.constructor, Geometry: proto.constructor, Object3D: o3.constructor, Attr: mesh.geometry.attributes.position.constructor,
      Lambert: lambert.constructor, Color: color.constructor, M4: mesh.matrix.constructor, V3: mesh.position.constructor };
    return K;
  }

  const isFacade = (m) => m && m.map && typeof m.customProgramCacheKey === 'function' && m.customProgramCacheKey() === 'facade';

  // Read the boxes of one building's facade mesh (world coordinates).
  function readMasses(mesh) {
    const g = mesh.geometry, pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, col = g.attributes.color;
    if (!pos || !nor || !uv || !col || pos.count % 4) return [];
    mesh.updateWorldMatrix(true, false);
    const e = mesh.matrixWorld.elements;
    const W = (i) => [e[0] * pos.getX(i) + e[4] * pos.getY(i) + e[8] * pos.getZ(i) + e[12], e[1] * pos.getX(i) + e[5] * pos.getY(i) + e[9] * pos.getZ(i) + e[13], e[2] * pos.getX(i) + e[6] * pos.getY(i) + e[10] * pos.getZ(i) + e[14]];
    const tops = [], walls = [];
    for (let q = 0; q < pos.count; q += 4) {
      const nx = nor.getX(q), ny = nor.getY(q), nz = nor.getZ(q);
      const wn = [e[0] * nx + e[4] * ny + e[8] * nz, e[1] * nx + e[5] * ny + e[9] * nz, e[2] * nx + e[6] * ny + e[10] * nz];
      const P = [0, 1, 2, 3].map((k) => W(q + k)), c = [col.getX(q), col.getY(q), col.getZ(q)];
      if (wn[1] > 0.9) {
        tops.push({ x0: Math.min(...P.map((p) => p[0])), x1: Math.max(...P.map((p) => p[0])), z0: Math.min(...P.map((p) => p[2])), z1: Math.max(...P.map((p) => p[2])), y1: P[0][1], roof: c });
      } else if (Math.abs(wn[0]) > 0.9 || Math.abs(wn[2]) > 0.9) {
        const ax = Math.abs(wn[0]) > 0.9 ? 0 : 2, along = ax === 0 ? 2 : 0, sign = Math.sign(wn[ax]);
        // u depends on the position along the wall, v on the height: read both lines off the quad
        const U = [0, 1, 2, 3].map((k) => [uv.getX(q + k), uv.getY(q + k)]);
        let a = 0, b = 1; for (let k = 1; k < 4; k++) if (Math.abs(P[k][along] - P[0][along]) > 1e-5) { b = k; break; }
        let c2 = 1; for (let k = 1; k < 4; k++) if (Math.abs(P[k][1] - P[0][1]) > 1e-5) { c2 = k; break; }
        const du = (U[b][0] - U[a][0]) / (P[b][along] - P[a][along]), dv = (U[c2][1] - U[0][1]) / (P[c2][1] - P[0][1]);
        walls.push({ ax, along, sign, at: P[0][ax], s0: Math.min(...P.map((p) => p[along])), s1: Math.max(...P.map((p) => p[along])),
          y0: Math.min(...P.map((p) => p[1])), y1: Math.max(...P.map((p) => p[1])), c,
          u: (s) => U[a][0] + (s - P[a][along]) * du, v: (y) => U[0][1] + (y - P[0][1]) * dv });
      }
    }
    const near = (a, b) => Math.abs(a - b) < 1e-3;
    const boxes = [];
    for (const t of tops) {
      const lim = { x: [t.x0, t.x1], z: [t.z0, t.z1] };
      const own = walls.filter((w) => near(w.y1, t.y1) && near(w.at, w.ax === 0 ? (w.sign > 0 ? t.x1 : t.x0) : (w.sign > 0 ? t.z1 : t.z0)) &&
        w.s0 >= (w.along === 0 ? lim.x[0] : lim.z[0]) - 1e-3 && w.s1 <= (w.along === 0 ? lim.x[1] : lim.z[1]) + 1e-3);
      if (own.length < 1) continue;
      const y0 = Math.min(...own.map((w) => w.y0));
      if (t.y1 - y0 < 0.005 || t.x1 - t.x0 < 0.01 || t.z1 - t.z0 < 0.01) continue;
      boxes.push({ x0: t.x0, x1: t.x1, z0: t.z0, z1: t.z1, y0, y1: t.y1, roof: t.roof, walls: own, wallColor: own[0].c });
    }
    for (const b of boxes) b.siblings = boxes;
    return boxes;
  }

  const insideBox = (b, p, eps = 1e-4) => p[0] > b.x0 + eps && p[0] < b.x1 - eps && p[1] > b.y0 + eps && p[1] < b.y1 - eps && p[2] > b.z0 + eps && p[2] < b.z1 - eps;

  // ---- convex polyhedra: a list of faces { v: [[x, y, z], …] counter-clockwise seen from outside, n, tag } ----
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  function newell(v) {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < v.length; i++) { const a = v[i], b = v[(i + 1) % v.length]; x += (a[1] - b[1]) * (a[2] + b[2]); y += (a[2] - b[2]) * (a[0] + b[0]); z += (a[0] - b[0]) * (a[1] + b[1]); }
    return [x, y, z];   // length = 2 × area
  }
  function face(v, n, tag) { if (dot(newell(v), n) < 0) v = v.slice().reverse(); return { v, n, tag }; }
  function boxPoly(x0, y0, z0, x1, y1, z1, tags) {
    return [
      face([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0], tags['+x']),
      face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], tags['-x']),
      face([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0], tags['+y']),
      face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], tags['-y']),
      face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], tags['+z']),
      face([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], [0, 0, -1], tags['-z']),
    ];
  }
  // cut a convex polyhedron by the plane n·p = d: [part behind, part in front]
  function split(poly, n, d) {
    const back = [], front = [], cut = [];
    const EPS = 1e-9;
    for (const f of poly) {
      const b = [], fr = [], m = f.v.length;
      for (let i = 0; i < m; i++) {
        const a = f.v[i], c = f.v[(i + 1) % m];
        let da = dot(n, a) - d, dc = dot(n, c) - d;
        if (Math.abs(da) < EPS) da = 0; if (Math.abs(dc) < EPS) dc = 0;
        if (da <= 0) b.push(a);
        if (da >= 0) fr.push(a);
        if (da === 0) cut.push(a);
        if ((da < 0 && dc > 0) || (da > 0 && dc < 0)) {
          const t = da / (da - dc), p = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t];
          b.push(p); fr.push(p); cut.push(p);
        }
      }
      if (b.length >= 3 && Math.hypot(...newell(b)) > 1e-10) back.push({ v: b, n: f.n, tag: f.tag });
      if (fr.length >= 3 && Math.hypot(...newell(fr)) > 1e-10) front.push({ v: fr, n: f.n, tag: f.tag });
    }
    // the new face where the cut went through: the cut points, in order around their middle
    const seen = new Set(), pts = [];
    for (const p of cut) { const k = p.map((x) => Math.round(x * 1e6)).join(','); if (!seen.has(k)) { seen.add(k); pts.push(p); } }
    if (pts.length >= 3 && back.length && front.length) {
      const c = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length], [0, 0, 0]);
      let u = cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]); const ul = Math.hypot(...u); u = u.map((x) => x / ul);
      const w = cross(n, u);
      pts.sort((p, q) => Math.atan2(dot(sub(p, c), w), dot(sub(p, c), u)) - Math.atan2(dot(sub(q, c), w), dot(sub(q, c), u)));
      back.push(face(pts, n, 'cut'));
      front.push(face(pts.slice(), [-n[0], -n[1], -n[2]], 'cut'));
    }
    return [back, front];
  }
  function bounds(poly) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const f of poly) for (const p of f.v) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
    return { lo, hi };
  }
  // keep cutting the largest direction with a slightly tilted plane until pieces are about `size`
  function shatter(poly, size, out, depth = 0) {
    const { lo, hi } = bounds(poly), ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const k = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2, L = ext[k];
    if (L <= size * rnd(0.8, 1.25) || depth > 40) { out.push(poly); return; }
    for (let attempt = 0; attempt < 6; attempt++) {
      const tilt = attempt < 3 ? 0.5 : 0.1;                       // a cut that failed: try again, straighter
      const n = [rnd(-tilt, tilt), rnd(-tilt, tilt), rnd(-tilt, tilt)]; n[k] = 1;
      const nl = Math.hypot(...n); for (let a = 0; a < 3; a++) n[a] /= nl;
      const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]; c[k] += L * rnd(-0.18, 0.18);
      const [a, b] = split(poly, n, dot(n, c));
      if (a.length >= 4 && b.length >= 4) { shatter(a, size, out, depth + 1); shatter(b, size, out, depth + 1); return; }
    }
    out.push(poly);
  }

  // Triangles (with colour and facade texture coordinates) for one piece.
  function pieceTriangles(poly, box, concrete) {
    const tris = [];
    for (const f of poly) {
      let c = concrete, uvOf = () => JF;
      const t = f.tag;
      if (t && t !== 'cut' && t.ext) {
        const mid = f.v.reduce((s, p) => [s[0] + p[0] / f.v.length, s[1] + p[1] / f.v.length, s[2] + p[2] / f.v.length], [0, 0, 0]);
        const out = [mid[0] + f.n[0] * 0.004, mid[1] + f.n[1] * 0.004, mid[2] + f.n[2] * 0.004];
        if (!box.siblings.some((b) => insideBox(b, out, -1e-4))) {    // really on the outside of the building
          if (t.side === '+y') c = box.roof;
          else {
            const ax = t.side[1] === 'x' ? 0 : 2, sign = t.side[0] === '+' ? 1 : -1;
            const w = box.walls.find((w) => w.ax === ax && w.sign === sign && mid[1] >= w.y0 - 1e-3 && mid[1] <= w.y1 + 1e-3 && mid[w.along] >= w.s0 - 1e-3 && mid[w.along] <= w.s1 + 1e-3);
            if (w) { c = w.c; uvOf = (p) => [w.u(p[w.along]), w.v(p[1])]; }
          }
        }
      }
      const vs = f.v.map((p) => ({ p, n: f.n, c, uv: uvOf(p) }));
      for (let i = 1; i + 1 < vs.length; i++) tris.push([vs[0], vs[i], vs[i + 1]]);
    }
    return tris;
  }

  // rotation of `angle` around a unit axis, as a 3×3 matrix (row-major)
  function rot(x, y, z, angle) {
    const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
  }
  const mul = (A, B) => [
    A[0] * B[0] + A[1] * B[3] + A[2] * B[6], A[0] * B[1] + A[1] * B[4] + A[2] * B[7], A[0] * B[2] + A[1] * B[5] + A[2] * B[8],
    A[3] * B[0] + A[4] * B[3] + A[5] * B[6], A[3] * B[1] + A[4] * B[4] + A[5] * B[7], A[3] * B[2] + A[4] * B[5] + A[5] * B[8],
    A[6] * B[0] + A[7] * B[3] + A[8] * B[6], A[6] * B[1] + A[7] * B[4] + A[8] * B[7], A[6] * B[2] + A[7] * B[5] + A[8] * B[8]];


  // ---------- the creature ----------
  // Built from simple shapes in unit size (1 = top of the head without the hair tufts), then
  // scaled to MONSTER_HEIGHT. Every shape gets slightly varied green per vertex, so the body looks
  // mottled like fur without being fur. Animated parts are separate objects:
  // root (position, heading) → hips → body (bob, sway, lean) → face, glasses, arms (shoulder pivots); legs (hip pivots).
  function shapes() {
    const P = [], N = [], C = [];
    let col = [1, 1, 1], vary = 0, low = null;
    // colour (with mottling amount v); `under` = a second colour that takes over towards the bottom
    const colour = (hex, v = 0, under = null) => { const c = new K.Color(hex); col = [c.r, c.g, c.b]; vary = v; low = under ? (() => { const u = new K.Color(under); return [u.r, u.g, u.b]; })() : null; };
    // smooth mottling: a little 3D wave noise, so neighbouring points get similar shades
    const noise = (p) => (Math.sin(p[0] * 23 + 1.7) + Math.sin(p[1] * 19 + p[0] * 7) + Math.sin(p[2] * 21 + p[1] * 5 + 0.4) + Math.sin((p[0] + p[2]) * 37)) / 4;
    const vtx = (p, n) => {
      const f = 1 + noise(p) * vary * 2;
      let c = col;
      if (low) { const t = Math.min(1, Math.max(0, (0.42 - p[1]) / 0.3 + noise([p[2], p[0], p[1]]) * 0.6)); c = col.map((v, k) => v + (low[k] - v) * t); }
      P.push(...p); N.push(...n); C.push(c[0] * f, c[1] * f, c[2] * f);
    };
    const api = {
      P, N, C, colour,
      // ellipsoid at c with radii r; taper > 0 makes it wider at the bottom (an egg / a pear)
      ellipsoid(c, r, seg = 18, taper = 0, rot = null) {
        const rows = Math.max(6, Math.round(seg * 0.6));
        const pt = (i, j) => {
          const th = (i / rows) * Math.PI, ph = (j / seg) * Math.PI * 2;
          const y0 = Math.cos(th), s = Math.sin(th) * (1 + taper * (-y0));
          let p = [s * Math.cos(ph) * r[0], y0 * r[1], s * Math.sin(ph) * r[2]];
          let n = [s * Math.cos(ph) / r[0], y0 / r[1], s * Math.sin(ph) / r[2]];
          if (rot) { p = rot(p); n = rot(n); }
          const l = Math.hypot(...n) || 1;
          return [[p[0] + c[0], p[1] + c[1], p[2] + c[2]], [n[0] / l, n[1] / l, n[2] / l]];
        };
        for (let i = 0; i < rows; i++) for (let j = 0; j < seg; j++) {
          const a = pt(i, j), b = pt(i + 1, j), d = pt(i + 1, j + 1), e = pt(i, j + 1);
          if (i > 0) { vtx(...a); vtx(...e); vtx(...d); }           // (no slivers at the poles)
          if (i < rows - 1) { vtx(...a); vtx(...d); vtx(...b); }
        }
      },
      // torus in the xy plane around c (facing +z), radius R, tube t, over `arc` radians from `start`
      torus(c, R, t, segU = 32, segV = 8, arc = Math.PI * 2, start = 0, rot = null) {
        const pt = (u, v) => {
          const a = start + (u / segU) * arc, b = (v / segV) * Math.PI * 2;
          const cx = Math.cos(a) * R, cy = Math.sin(a) * R;
          let n = [Math.cos(a) * Math.cos(b), Math.sin(a) * Math.cos(b), Math.sin(b)];
          let p = [cx + n[0] * t, cy + n[1] * t, n[2] * t];
          if (rot) { p = rot(p); n = rot(n); }
          return [[p[0] + c[0], p[1] + c[1], p[2] + c[2]], n];
        };
        for (let u = 0; u < segU; u++) for (let v = 0; v < segV; v++) {
          const a = pt(u, v), b = pt(u + 1, v), d = pt(u + 1, v + 1), e = pt(u, v + 1);
          vtx(...a); vtx(...b); vtx(...d); vtx(...a); vtx(...d); vtx(...e);
        }
      },
      // a cone from base centre c (radius r) to the tip at c + dir·h
      cone(c, dir, r, h, seg = 7) {
        const l = Math.hypot(...dir); const d = dir.map((x) => x / l);
        const u0 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        let u = [d[1] * u0[2] - d[2] * u0[1], d[2] * u0[0] - d[0] * u0[2], d[0] * u0[1] - d[1] * u0[0]]; const ul = Math.hypot(...u); u = u.map((x) => x / ul);
        const w = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
        const tip = [c[0] + d[0] * h, c[1] + d[1] * h, c[2] + d[2] * h];
        for (let i = 0; i < seg; i++) {
          const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
          const q = (a) => [c[0] + (u[0] * Math.cos(a) + w[0] * Math.sin(a)) * r, c[1] + (u[1] * Math.cos(a) + w[1] * Math.sin(a)) * r, c[2] + (u[2] * Math.cos(a) + w[2] * Math.sin(a)) * r];
          const nrm = (a) => { const n = [u[0] * Math.cos(a) + w[0] * Math.sin(a) + d[0] * r / h, u[1] * Math.cos(a) + w[1] * Math.sin(a) + d[1] * r / h, u[2] * Math.cos(a) + w[2] * Math.sin(a) + d[2] * r / h]; const nl = Math.hypot(...n); return n.map((x) => x / nl); };
          const am = (a0 + a1) / 2;
          vtx(q(a0), nrm(a0)); vtx(q(a1), nrm(a1)); vtx(tip, nrm(am));
        }
      },
      // a cylinder between two points
      rod(a, b, r, seg = 8) {
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d), e = d.map((x) => x / l);
        const u0 = Math.abs(e[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        let u = [e[1] * u0[2] - e[2] * u0[1], e[2] * u0[0] - e[0] * u0[2], e[0] * u0[1] - e[1] * u0[0]]; const ul = Math.hypot(...u); u = u.map((x) => x / ul);
        const w = [e[1] * u[2] - e[2] * u[1], e[2] * u[0] - e[0] * u[2], e[0] * u[1] - e[1] * u[0]];
        for (let i = 0; i < seg; i++) {
          const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
          const n = (q) => [u[0] * Math.cos(q) + w[0] * Math.sin(q), u[1] * Math.cos(q) + w[1] * Math.sin(q), u[2] * Math.cos(q) + w[2] * Math.sin(q)];
          const at = (p, q) => { const nn = n(q); return [p[0] + nn[0] * r, p[1] + nn[1] * r, p[2] + nn[2] * r]; };
          vtx(at(a, a0), n(a0)); vtx(at(b, a0), n(a0)); vtx(at(b, a1), n(a1));
          vtx(at(a, a0), n(a0)); vtx(at(b, a1), n(a1)); vtx(at(a, a1), n(a1));
        }
      },
    };
    return api;
  }
  function toMesh(sh, material) {
    const g = new K.Geometry();
    g.setAttribute('position', new K.Attr(new Float32Array(sh.P), 3));
    g.setAttribute('normal', new K.Attr(new Float32Array(sh.N), 3));
    g.setAttribute('color', new K.Attr(new Float32Array(sh.C), 3));
    const m = new K.Mesh(g, material);
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
    return m;
  }
  const rotX = (a) => (p) => [p[0], p[1] * Math.cos(a) - p[2] * Math.sin(a), p[1] * Math.sin(a) + p[2] * Math.cos(a)];
  const rotY = (a) => (p) => [p[0] * Math.cos(a) + p[2] * Math.sin(a), p[1], -p[0] * Math.sin(a) + p[2] * Math.cos(a)];

  const GREEN = '#3fae4a', GREEN_DARK = '#2b8a46', GREEN_LIGHT = '#69c85e', TEAL = '#2f8f70';
  function buildCreature() {
    const mat = new K.Lambert({ vertexColors: true });
    const G = () => new K.Object3D();
    const root = G(), hips = G(), body = G();
    root.add(hips); hips.add(body);
    const LEG = 0.15;                                     // hip height (unit size)
    hips.position.y = LEG;

    // body: a big egg, widest low down, with darker teal patches in the lower half
    const b = shapes();
    b.colour(GREEN, 0.14, TEAL); b.ellipsoid([0, 0.36, 0], [0.38, 0.44, 0.34], 32, 0.16);   // green, darker teal towards the bottom
    b.colour(GREEN_LIGHT, 0.1); b.ellipsoid([0, 0.63, 0.07], [0.26, 0.19, 0.25], 24);     // lighter face area
    // shaggy tufts all over (cones pointing outwards and a little down), wild ones on top
    for (let k = 0; k < 110; k++) {                                  // shaggy tufts, hanging down
      const th = Math.acos(1 - Math.random() * 1.8), ph = Math.random() * Math.PI * 2;
      const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      if (n[2] > 0.45 && n[1] > -0.25 && n[1] < 0.8) continue;    // keep the face and belly front smooth
      const p = [n[0] * 0.355, 0.36 + n[1] * 0.41, n[2] * 0.315];
      const y = p[1];
      b.colour(y < 0.35 ? (k % 2 ? TEAL : GREEN_DARK) : (k % 3 ? GREEN : GREEN_DARK), 0.1);
      b.cone(p, [n[0] * 0.6, n[1] * 0.4 - 1, n[2] * 0.6], rnd(0.045, 0.07), rnd(0.06, 0.1), 7);
    }
    for (let k = 0; k < 30; k++) {                                   // wild, thin hair sticking up on top
      const ph = Math.random() * Math.PI * 2, s = Math.sqrt(Math.random()) * 0.24;
      b.colour(k % 3 ? GREEN : GREEN_DARK, 0.1);
      b.cone([Math.cos(ph) * s, 0.75 + (0.24 - s) * 0.3, Math.sin(ph) * s * 0.85 - 0.04], [Math.cos(ph) * rnd(0.3, 1.1), 1, Math.sin(ph) * rnd(0.2, 0.8)], rnd(0.014, 0.026), rnd(0.06, 0.14), 5);
    }
    // eyebrow ridges, nose, smile
    b.colour(GREEN_DARK, 0.08);
    b.ellipsoid([-0.1, 0.785, 0.245], [0.07, 0.022, 0.03], 12, 0, rotX(-0.2));
    b.ellipsoid([0.11, 0.79, 0.24], [0.07, 0.022, 0.03], 12, 0, rotX(-0.2));
    b.colour('#3d3f3c', 0.05); b.ellipsoid([0.005, 0.645, 0.305], [0.032, 0.022, 0.022], 12);
    b.colour('#1f5a2c', 0.03); b.torus([0.01, 0.65, 0.255], 0.13, 0.008, 24, 6, Math.PI * 0.55, Math.PI * 1.22, rotX(-0.35));
    body.add(toMesh(b, mat));

    // eyes: white balls with a dark iris and pupil and a little shine; the iris+pupil can turn
    const eyes = [];
    for (const [x, sz] of [[-0.09, 1.08], [0.1, 1.14]]) {
      const e = shapes(); e.colour('#f4f4ef', 0.01); e.ellipsoid([0, 0, 0], [0.064 * sz, 0.07 * sz, 0.05 * sz], 24);
      const eye = toMesh(e, mat); eye.position.set(x, 0.705, 0.27); body.add(eye);
      const i = shapes(); i.colour('#3c4a25', 0.05); i.ellipsoid([0, 0, 0.042 * sz], [0.036 * sz, 0.038 * sz, 0.012], 14);
      i.colour('#0d0d0d', 0); i.ellipsoid([0, 0, 0.05 * sz], [0.021 * sz, 0.022 * sz, 0.008], 12);
      i.colour('#ffffff', 0); i.ellipsoid([0.012 * sz, 0.014 * sz, 0.056 * sz], [0.006, 0.006, 0.003], 6);
      const iris = toMesh(i, mat); eye.add(iris);
      iris.rotation.set(-0.25, 0.3, 0);                                // looking up and to the side, like in the picture
      // an eyelid (green) for blinking: closed = scaled up over the eye
      const l = shapes(); l.colour(GREEN_LIGHT, 0.06); l.ellipsoid([0, 0, 0], [0.068 * sz, 0.074 * sz, 0.054 * sz], 16);
      const lid = toMesh(l, mat); lid.scale.set(1, 0.001, 1); lid.position.y = 0.07 * sz; eye.add(lid);
      eyes.push({ eye, iris, lid, sz });
    }
    // glasses: two big round coral rims, a bridge, hinges and arms going back into the fur
    const gl = shapes(); gl.colour('#ef6a55', 0.04);
    const rims = [[-0.1, 0.71, 0.335], [0.115, 0.715, 0.33]];
    for (const c of rims) gl.torus(c, 0.112, 0.01, 44, 8);
    gl.rod([rims[0][0] + 0.105, 0.745, 0.338], [rims[1][0] - 0.105, 0.748, 0.334], 0.009, 6);   // the bridge
    for (const s of [-1, 1]) {
      const c = rims[s < 0 ? 0 : 1], hx = c[0] + s * 0.112;
      gl.ellipsoid([hx, c[1] + 0.012, c[2] - 0.005], [0.018, 0.014, 0.014], 8);              // hinge
      gl.rod([hx + s * 0.005, c[1] + 0.015, c[2] - 0.01], [s * 0.285, c[1] + 0.03, c[2] - 0.2], 0.008, 6);   // arm
    }
    body.add(toMesh(gl, mat));

    // arms: short and furry, hanging from the shoulders
    const arms = [];
    for (const s of [-1, 1]) {
      const pivot = G(); pivot.position.set(s * 0.3, 0.46, 0.04); body.add(pivot);
      const a = shapes(); a.colour(GREEN, 0.12, TEAL);
      a.ellipsoid([s * 0.04, -0.16, 0.02], [0.1, 0.21, 0.1], 18, 0.25, rotX(0.15));
      a.colour(TEAL, 0.12); a.ellipsoid([s * 0.05, -0.3, 0.06], [0.085, 0.07, 0.09], 14);         // hand
      a.colour('#2a2f2a', 0.05);
      for (let k = 0; k < 3; k++) a.cone([s * 0.05 + (k - 1) * 0.03, -0.33, 0.12], [0, -0.4, 1], 0.012, 0.03, 5);
      for (let k = 0; k < 8; k++) { a.colour(k % 2 ? GREEN_DARK : TEAL, 0.12); a.cone([s * (0.07 + Math.random() * 0.03), -0.05 - k * 0.03, rnd(-0.05, 0.08)], [s, -0.8, rnd(-0.3, 0.3)], 0.03, rnd(0.05, 0.09), 5); }
      pivot.add(toMesh(a, mat));
      arms.push({ pivot, s });
    }
    // legs: stubby, with big feet and dark claws
    const legs = [];
    for (const s of [-1, 1]) {
      const pivot = G(); pivot.position.set(s * 0.16, 0, 0.0); hips.add(pivot);
      const l = shapes(); l.colour(TEAL, 0.14);
      l.ellipsoid([0, -0.07, 0], [0.11, 0.1, 0.11], 16);
      l.colour(GREEN, 0.12); l.ellipsoid([0, -0.125, 0.045], [0.12, 0.05, 0.16], 18);          // foot
      l.colour('#232823', 0.05);
      for (let k = 0; k < 4; k++) l.ellipsoid([(k - 1.5) * 0.05, -0.15, 0.19], [0.02, 0.016, 0.022], 8);
      pivot.add(toMesh(l, mat));
      legs.push({ pivot, s });
    }
    return { root, hips, body, eyes, arms, legs, LEG };
  }

  // ---------- buildings ----------
  // every building: its group (with userData.projectId), its facade mesh and the boxes in it
  function buildings() {
    const list = [];
    scene.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || !o.geometry || !o.geometry.index) return;
      if (!isFacade(Array.isArray(o.material) ? o.material[0] : o.material)) return;
      let grp = null; for (let p = o; p && !grp; p = p.parent) if (p.userData && p.userData.projectId !== undefined) grp = p;
      if (!grp || destroyed.has(grp.userData.projectId)) return;
      const boxes = massesOf(o);
      if (!boxes.length) return;
      const x0 = Math.min(...boxes.map((b) => b.x0)), x1 = Math.max(...boxes.map((b) => b.x1)), z0 = Math.min(...boxes.map((b) => b.z0)), z1 = Math.max(...boxes.map((b) => b.z1));
      list.push({ id: grp.userData.projectId, grp, mesh: o, boxes, x0, x1, z0, z1, top: Math.max(...boxes.map((b) => b.y1)), cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 });
    });
    // buildings the rocket launcher already turned into chunks (they have no facade mesh any more)
    const rs = window.scRocketSolids;
    if (rs) for (const b of rs.list()) if (!destroyed.has(b.id)) list.push({ ...b, external: true, grp: { parent: true }, cx: (b.x0 + b.x1) / 2, cz: (b.z0 + b.z1) / 2 });
    return list;
  }
  const massCache = new WeakMap();
  function massesOf(mesh) { if (!massCache.has(mesh)) massCache.set(mesh, readMasses(mesh)); return massCache.get(mesh); }
  const destroyed = new Map();       // projectId → footprint, to keep it gone if the app redraws the block

  // Hide the building's original triangles: in the city block meshes (everything above the lot
  // inside its footprint) and its own hidden group (so walk mode no longer bumps into it).
  function hideBuilding(bd) {
    const f = { x0: bd.x0 - 0.03, x1: bd.x1 + 0.03, z0: bd.z0 - 0.03, z1: bd.z1 + 0.03 };
    destroyed.set(bd.id, f);
    removeIn(f);
    bd.grp.traverse((o) => { if (o.isMesh && o.geometry && !o.userData.scMonster) o.geometry = new K.Geometry(); });
  }
  const cleaned = new WeakMap();     // geometry → footprints already removed from it
  function removeIn(...foot) {
    scene.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || !o.geometry || o.geometry.index || o.userData.scMonster) return;
      if (!isFacade(Array.isArray(o.material) ? o.material[0] : o.material)) return;
      const g = o.geometry, pos = g.attributes.position; if (!pos) return;
      const done = cleaned.get(g) || []; const todo = foot.filter((f) => !done.includes(f)); if (!todo.length) return;
      cleaned.set(g, done.concat(todo));
      o.updateWorldMatrix(true, false);
      const e = o.matrixWorld.elements;
      let lo = Infinity, hi = -1;
      for (let i = 0; i + 2 < pos.count; i += 3) {
        let inside = true, high = false;
        for (let v = i; v < i + 3 && inside; v++) {
          const x = e[0] * pos.getX(v) + e[4] * pos.getY(v) + e[8] * pos.getZ(v) + e[12], y = e[1] * pos.getX(v) + e[5] * pos.getY(v) + e[9] * pos.getZ(v) + e[13], z = e[2] * pos.getX(v) + e[6] * pos.getY(v) + e[10] * pos.getZ(v) + e[14];
          inside = todo.some((f) => x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1);
          if (y > 0.036) high = true;
        }
        if (!inside || !high) continue;
        for (let v = i; v < i + 3; v++) pos.setXYZ(v, pos.getX(i), pos.getY(i), pos.getZ(i));
        lo = Math.min(lo, i); hi = Math.max(hi, i + 3);
      }
      if (hi > 0) { if (pos.addUpdateRange) { pos.addUpdateRange(lo * 3, (hi - lo) * 3); } pos.needsUpdate = true; }
    });
  }

  // ---------- a building comes down ----------
  // (one the rocket launcher already cut into chunks: that script brings it down the same way)
  function smash(bd, hit, dir) {
    if (bd.external) { destroyed.set(bd.id, { x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9 }); if (window.scRocketSolids) window.scRocketSolids.collapse(bd.id, dir, PUNCH_FORCE); sound('crash'); return; }
    collapse(bd, hit, dir);
  }
  const collapses = [];
  function collapse(bd, hit, dir) {
    // casualties: everyone inside, and on the street right next to it (residents script 1.10, cops)
    setTimeout(() => {
      const res = window.scResidents;
      if (res && res.crush) res.crush(bd.x0, bd.z0, bd.x1, bd.z1);
      window.dispatchEvent(new CustomEvent('sc:crush', { detail: { x0: bd.x0, z0: bd.z0, x1: bd.x1, z1: bd.z1, margin: 0.3 } }));
    }, 700);
    const pieces = [];
    for (const b of bd.boxes) {
      const nx = Math.max(1, Math.round((b.x1 - b.x0) / RUIN_COLUMN)), nz = Math.max(1, Math.round((b.z1 - b.z0) / RUIN_COLUMN));
      const xs = [b.x0], zs = [b.z0];
      for (let i = 1; i < nx; i++) xs.push(b.x0 + (b.x1 - b.x0) * (i + rnd(-0.25, 0.25)) / nx); xs.push(b.x1);
      for (let i = 1; i < nz; i++) zs.push(b.z0 + (b.z1 - b.z0) * (i + rnd(-0.25, 0.25)) / nz); zs.push(b.z1);
      const wall = b.wallColor, concrete0 = [wall[0] * 0.55 + 0.15, wall[1] * 0.55 + 0.145, wall[2] * 0.55 + 0.14];
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const x0 = xs[i], x1 = xs[i + 1], z0 = zs[j], z1 = zs[j + 1];
        const keep = Math.min(b.y1, Math.max(b.y0, 0.03 + Math.random() * STUMP));
        const tags = (yTop) => ({
          '+x': { side: '+x', ext: Math.abs(x1 - b.x1) < 1e-6 }, '-x': { side: '-x', ext: Math.abs(x0 - b.x0) < 1e-6 },
          '+z': { side: '+z', ext: Math.abs(z1 - b.z1) < 1e-6 }, '-z': { side: '-z', ext: Math.abs(z0 - b.z0) < 1e-6 },
          '+y': { side: '+y', ext: Math.abs(yTop - b.y1) < 1e-6 }, '-y': { side: '-y', ext: false },
        });
        const shade = rnd(0.88, 1.08), concrete = concrete0.map((v) => v * shade);
        if (keep > b.y0 + 1e-4) pieces.push({ tris: pieceTriangles(boxPoly(x0, b.y0, z0, x1, keep, z1, tags(keep)), b, concrete), still: true });
        if (b.y1 > keep + 1e-4) {
          const chunks = [];
          shatter(boxPoly(x0, keep, z0, x1, b.y1, z1, tags(b.y1)), CHUNK_SIZE, chunks);
          for (const ch of chunks) {
            const s2 = rnd(0.9, 1.1);
            let big = null, area = -1;
            for (const f of ch) { const a = Math.hypot(...newell(f.v)); if (a > area) { area = a; big = f.n; } }
            pieces.push({ tris: pieceTriangles(ch, b, concrete.map((v) => v * s2)), still: false, normal: big });
          }
        }
      }
    }
    // one layer with the facade material; chunks wait in place until the break reaches them
    const total = pieces.reduce((s, p) => s + p.tris.length * 3, 0);
    const g = new K.Geometry();
    const attr = (w) => { const at = new K.Attr(new Float32Array(Math.max(3, total) * w), w); if (at.setUsage) at.setUsage(35048); return at; };
    g.setAttribute('position', attr(3)); g.setAttribute('normal', attr(3)); g.setAttribute('color', attr(3)); g.setAttribute('uv', attr(2));
    const P = g.attributes.position, N = g.attributes.normal, C = g.attributes.color, U = g.attributes.uv;
    const frs = [];
    let k = 0;
    const H = bd.top;
    for (const pc of pieces) {
      let px = 0, py = 0, pz = 0, m = 0;
      for (const t of pc.tris) for (const v of t) { px += v.p[0]; py += v.p[1]; pz += v.p[2]; m++; }
      const pivot = [px / m, py / m, pz / m];
      const fr = { start: k, count: m, pivot, normal: pc.normal || [0, -1, 0], still: pc.still, orig: new Float32Array(m * 3), n0: new Float32Array(m * 3) };
      let q = 0;
      for (const t of pc.tris) for (const v of t) {
        P.setXYZ(k, v.p[0], v.p[1], v.p[2]); N.setXYZ(k, v.n[0], v.n[1], v.n[2]); C.setXYZ(k, v.c[0], v.c[1], v.c[2]); U.setXY(k, v.uv[0], v.uv[1]);
        fr.orig.set([v.p[0] - pivot[0], v.p[1] - pivot[1], v.p[2] - pivot[2]], q * 3); fr.n0.set(v.n, q * 3);
        k++; q++;
      }
      if (!pc.still) {
        // when it breaks loose (the crack runs from the fist through the building) and how it flies
        const d = Math.hypot(pivot[0] - hit[0], (pivot[1] - hit[1]) * 0.6, pivot[2] - hit[2]);
        const up = clamp01((pivot[1] - 0.03) / Math.max(0.1, H - 0.03));
        const near = clamp01(1 - d / 0.8);
        const push = PUNCH_FORCE * (0.25 + 0.75 * up + near) * rnd(0.6, 1.2);
        const side = rnd(-0.35, 0.35);
        let ax = rnd(-1, 1), ay = rnd(-0.5, 0.5), az = rnd(-1, 1); const al = Math.hypot(ax, ay, az) || 1;
        Object.assign(fr, { delay: d / CRACK_SPEED + rnd(0, 0.15) * (1 - near), R: [1, 0, 0, 0, 1, 0, 0, 0, 1], off: [0, 0, 0],
          v: [dir[0] * push - dir[2] * side * push * 0.5, rnd(-0.2, 0.6) + near * 0.8, dir[2] * push + dir[0] * side * push * 0.5],
          axis: [ax / al, ay / al, az / al], w: rnd(1, 5) * (0.5 + up), landed: false, rest: false, active: false, age: 0 });
      }
      frs.push(fr);
    }
    const mat = Array.isArray(bd.mesh.material) ? bd.mesh.material[0] : bd.mesh.material;
    const mesh = new K.Mesh(g, mat);
    mesh.userData.scMonster = true; mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false;
    scene.add(mesh);
    hideBuilding(bd);
    collapses.push({ g, pos: P, nor: N, frs, t: 0 });
    // dust rolling out from the foot of the building, more on the far side
    for (let n = 0; n < 26; n++) {
      const a = Math.random() * Math.PI * 2, r = rnd(0, 0.6);
      puff(bd.cx + Math.cos(a) * r + dir[0] * 0.3, 0.06, bd.cz + Math.sin(a) * r + dir[2] * 0.3, { vx: Math.cos(a) * rnd(0.2, 0.6) + dir[0] * 0.5, vy: rnd(0.05, 0.25), vz: Math.sin(a) * rnd(0.2, 0.6) + dir[2] * 0.5, size: rnd(0.18, 0.35), life: rnd(3, 6), delay: rnd(0.2, 1.2) });
    }
    sound('crash');
    window.dispatchEvent(new Event('sc:geometry-changed'));    // walk mode: walls are gone
  }

  function stepCollapses(dt) {
    for (const cl of collapses) {
      if (cl.done) continue;
      cl.t += dt;
      let lo = Infinity, hi = -1, busy = false;
      for (const fr of cl.frs) {
        if (fr.still || fr.rest) continue;
        busy = true;
        if (!fr.active) { if (cl.t < fr.delay) continue; fr.active = true; }
        fr.age += dt;
        fr.v[1] -= 6 * dt;
        for (let a = 0; a < 3; a++) fr.off[a] += fr.v[a] * dt;
        if (!fr.landed) fr.R = mul(rot(...fr.axis, fr.w * dt), fr.R);
        else {
          const [x, y, z] = fr.normal, R = fr.R;
          const n = [R[0] * x + R[1] * y + R[2] * z, R[3] * x + R[4] * y + R[5] * z, R[6] * x + R[7] * y + R[8] * z];
          const tilt = Math.acos(Math.min(1, Math.max(-1, -n[1])));   // lands on its largest face
          if (tilt > 0.01) { let ax = n[2], az = -n[0]; let l = Math.hypot(ax, az); if (l < 1e-6) { ax = 1; az = 0; l = 1; } fr.R = mul(rot(ax / l, 0, az / l, Math.min(tilt, 6 * dt)), R); }
          const f = Math.exp(-5 * dt); fr.v[0] *= f; fr.v[2] *= f;
          if ((tilt <= 0.01 && Math.hypot(fr.v[0], fr.v[2]) < 0.05) || fr.age > 12) fr.rest = true;
        }
        let minY = write(cl, fr);
        if (minY < 0.04) {
          fr.off[1] += 0.04 - minY;
          if (!fr.landed) { fr.landed = true; fr.v[0] *= 0.4; fr.v[2] *= 0.4; if (Math.random() < 0.15) puff(fr.pivot[0] + fr.off[0], 0.06, fr.pivot[2] + fr.off[2], { vy: 0.08, size: rnd(0.08, 0.16), life: rnd(1.5, 3) }); }
          fr.v[1] = Math.max(0, fr.v[1]) * 0.1;
          minY = write(cl, fr);
        }
        lo = Math.min(lo, fr.start); hi = Math.max(hi, fr.start + fr.count);
      }
      if (hi > 0) for (const a of [cl.pos, cl.nor]) { if (a.addUpdateRange) { a.addUpdateRange(lo * 3, (hi - lo) * 3); } a.needsUpdate = true; }
      if (!busy) cl.done = true;
    }
  }
  function write(cl, fr) {
    const { orig, n0, R, pivot, off } = fr, pos = cl.pos, nor = cl.nor;
    let minY = Infinity;
    for (let n = 0, k = fr.start; n < fr.count; n++, k++) {
      const a = orig[n * 3], b = orig[n * 3 + 1], c = orig[n * 3 + 2];
      const py = pivot[1] + off[1] + R[3] * a + R[4] * b + R[5] * c;
      pos.setXYZ(k, pivot[0] + off[0] + R[0] * a + R[1] * b + R[2] * c, py, pivot[2] + off[2] + R[6] * a + R[7] * b + R[8] * c);
      const p = n0[n * 3], q = n0[n * 3 + 1], r = n0[n * 3 + 2];
      nor.setXYZ(k, R[0] * p + R[1] * q + R[2] * r, R[3] * p + R[4] * q + R[5] * r, R[6] * p + R[7] * q + R[8] * r);
      if (py < minY) minY = py;
    }
    return minY;
  }

  // ---------- dust ----------
  const puffs = [];
  let puffGeo = null, puffMat = null;
  function puff(x, y, z, o) {
    if (!puffGeo) {
      const sh = shapes(); sh.colour('#ffffff', 0); sh.ellipsoid([0, 0, 0], [1, 1, 1], 8);
      puffGeo = toMesh(sh, null).geometry;
      puffMat = new K.Lambert({ color: '#b9aa96', transparent: true, opacity: 0.85, depthWrite: false });
    }
    const mat = puffMat.clone();
    const m = new K.Mesh(puffGeo, mat);
    m.position.set(x, y, z); m.scale.setScalar(0.001); m.visible = false; m.userData.scMonster = true; m.frustumCulled = false;
    scene.add(m);
    puffs.push({ m, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0, size: o.size, life: o.life, age: -(o.delay || 0) });
  }
  function stepPuffs(dt) {
    for (let k = puffs.length - 1; k >= 0; k--) {
      const p = puffs[k]; p.age += dt;
      if (p.age < 0) continue;
      const f = p.age / p.life;
      if (f >= 1) { p.m.removeFromParent(); p.m.material.dispose(); puffs.splice(k, 1); continue; }
      p.m.visible = true;
      const drag = Math.exp(-1.2 * dt); p.vx *= drag; p.vz *= drag; p.vy *= drag;
      p.m.position.x += p.vx * dt; p.m.position.y += p.vy * dt; p.m.position.z += p.vz * dt;
      p.m.scale.set(p.size * (0.4 + f * 1.4), p.size * (0.3 + f * 0.9), p.size * (0.4 + f * 1.4));
      p.m.material.opacity = 0.85 * (1 - f) * Math.min(1, p.age * 4);
    }
  }

  // ---------- the monster ----------
  let mon = null;
  function release() {
    if (!scene || !classes()) { alert('De 3D-stad is nog niet geladen.'); return; }
    const c = buildCreature();
    c.root.scale.setScalar(MONSTER_HEIGHT);
    c.root.traverse((o) => { o.userData.scMonster = true; });
    // start just outside the city, on a random side, facing the middle
    const all = buildings();
    let x0 = -5, x1 = 5, z0 = -5, z1 = 5;
    if (all.length) { x0 = Math.min(...all.map((b) => b.x0)); x1 = Math.max(...all.map((b) => b.x1)); z0 = Math.min(...all.map((b) => b.z0)); z1 = Math.max(...all.map((b) => b.z1)); }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, R = Math.hypot(x1 - x0, z1 - z0) / 2 + 3, a = Math.random() * Math.PI * 2;
    mon = { c, x: cx + Math.cos(a) * R, z: cz + Math.sin(a) * R, yaw: 0, phase: 0, state: 'walk', target: null, t: 0, arm: 0, blink: 2, look: [0, 0], lastStep: 0, alarmAt: 0, shake: 0 };
    mon.yaw = Math.atan2(cx - mon.x, cz - mon.z);
    scene.add(c.root);
    sound('roar');
    if (!looping) { looping = true; last = 0; requestAnimationFrame(loop); }
    updateButton();
  }
  function sendAway() {
    if (!mon) return;
    mon.c.root.removeFromParent();
    mon = null;
    const el = renderer && renderer.domElement; if (el) el.style.transform = '';
    updateButton();
  }

  // the closest point of a building to (x, z), and how far that is
  const closest = (bd, x, z) => { const px = Math.max(bd.x0, Math.min(bd.x1, x)), pz = Math.max(bd.z0, Math.min(bd.z1, z)); return { px, pz, d: Math.hypot(px - x, pz - z) }; };
  const REACH = () => MONSTER_HEIGHT * 0.5;           // from its middle to where its fist lands

  // anything it walks into is trampled: collapses, pushed the way it walks
  let nearList = [], nearAt = -1e9;
  function trample(now) {
    if (now - nearAt > 800) { nearAt = now; nearList = buildings(); }
    const body = MONSTER_HEIGHT * 0.3;
    for (const bd of nearList) {
      if (destroyed.has(bd.id) || bd === mon.target) continue;
      const cp = closest(bd, mon.x, mon.z);
      if (cp.d > body) continue;
      const dx = bd.cx - mon.x, dz = bd.cz - mon.z, l = Math.hypot(dx, dz) || 1;
      try { smash(bd, [cp.px, 0.15, cp.pz], [(dx / l + Math.sin(mon.yaw)) / 2, 0, (dz / l + Math.cos(mon.yaw)) / 2]); } catch (e) { console.warn('[monster] trample', e); if (!bd.external) hideBuilding(bd); }
      mon.shake = Math.max(mon.shake, SHAKE * 1.5);
    }
  }

  function think(dt) {
    const m = mon;
    if (m.state === 'walk' || m.state === 'idle') {
      if (!m.target || destroyed.has(m.target.id) || !m.target.grp.parent) {
        const all = buildings();
        m.target = all.length ? all.reduce((best, b) => (closest(b, m.x, m.z).d < closest(best, m.x, m.z).d ? b : best)) : null;
        m.state = m.target ? 'walk' : 'idle';
      }
      if (m.state === 'idle') { m.speed = 0; return; }
      const cp = closest(m.target, m.x, m.z);
      const want = Math.atan2(cp.px - m.x, cp.pz - m.z);
      let dy = want - m.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      m.yaw += Math.max(-TURN_SPEED * dt, Math.min(TURN_SPEED * dt, dy));
      if (cp.d <= REACH() && Math.abs(dy) < 0.35) { m.state = 'punch'; m.t = 0; m.arm = 1 - m.arm; m.speed = 0; m.hitDone = false; return; }
      m.speed = WALK_SPEED * (Math.abs(dy) < 0.8 ? 1 : 0.3);
      // don't walk into the building: stop at arm's length
      const step = Math.min(m.speed * dt, Math.max(0, cp.d - REACH() * 0.9));
      m.x += Math.sin(m.yaw) * step; m.z += Math.cos(m.yaw) * step;
      m.phase += step / (MONSTER_HEIGHT * 0.22) * Math.PI;
    } else if (m.state === 'punch') {
      m.t += dt;
      if (!m.hitDone && m.t >= 0.62) {
        m.hitDone = true;
        const bd = m.target;
        if (bd && !destroyed.has(bd.id)) {
          const cp = closest(bd, m.x, m.z), hy = Math.min(bd.top * 0.8, MONSTER_HEIGHT * 0.5);
          const dx = bd.cx - m.x, dz = bd.cz - m.z, l = Math.hypot(dx, dz) || 1;
          try { smash(bd, [cp.px, hy, cp.pz], [dx / l, 0, dz / l]); } catch (e) { console.warn('[monster] collapse', e); if (!bd.external) hideBuilding(bd); }
          m.shake = Math.max(m.shake, SHAKE * 2.2);
        }
      }
      if (m.t > 1.4) { m.state = 'walk'; m.target = null; }
    }
  }

  function animate(dt) {
    const m = mon, c = m.c;
    c.root.position.set(m.x, 0.03, m.z);
    c.root.rotation.y = m.yaw;
    const walking = m.state === 'walk' && m.speed > 0.01;
    const s = Math.sin(m.phase), amp = walking ? 1 : 0;
    // legs swing, body bobs and rolls from foot to foot
    m.legAmp = (m.legAmp || 0) + (amp - (m.legAmp || 0)) * Math.min(1, dt * 5);
    c.legs[0].pivot.rotation.x = 0.55 * s * m.legAmp; c.legs[1].pivot.rotation.x = -0.55 * s * m.legAmp;
    c.hips.position.y = c.LEG + Math.abs(Math.cos(m.phase)) * 0.025 * m.legAmp;
    c.body.rotation.z = s * 0.07 * m.legAmp;
    let lean = 0.04 * m.legAmp;
    // arms: swing while walking; a punch: wind back, swing forward fast, recover
    const swing = 0.35 * s * m.legAmp;
    let a0 = -swing, a1 = swing, tw = 0, side0 = 0, side1 = 0;
    if (m.state === 'punch') {
      const t = m.t;
      const p = t < 0.45 ? -(t / 0.45) * 0.9 : t < 0.65 ? -0.9 + ((t - 0.45) / 0.2) * 2.6 : 1.7 * Math.max(0, 1 - (t - 0.65) / 0.75);
      const ang = -p * 1.1;                                       // forward = negative x rotation
      if (m.arm === 0) { a0 = ang; side0 = -0.35 * clamp01(p); } else { a1 = ang; side1 = 0.35 * clamp01(p); }
      tw = (m.arm === 0 ? -1 : 1) * 0.25 * (t < 0.45 ? -t / 0.45 : t < 0.65 ? -1 + (t - 0.45) / 0.2 * 2 : Math.max(0, 1 - (t - 0.65) / 0.75));
      lean = 0.1 * clamp01(p);
    }
    c.arms[0].pivot.rotation.set(a0, 0, side0); c.arms[1].pivot.rotation.set(a1, 0, side1);
    c.body.rotation.y = tw; c.body.rotation.x = lean;
    // blinking and looking at the target
    m.blink -= dt;
    const closed = m.blink < 0.12 && m.blink > 0 ? 1 : 0;
    if (m.blink <= 0) m.blink = rnd(2.5, 6);
    let lookY = 0.3, lookX = -0.25;
    if (m.target) { const a = Math.atan2(m.target.cx - m.x, m.target.cz - m.z) - m.yaw; lookY = Math.max(-0.5, Math.min(0.5, Math.atan2(Math.sin(a), Math.cos(a)))); lookX = -0.15; }
    m.look[0] += (lookX - m.look[0]) * Math.min(1, dt * 4); m.look[1] += (lookY - m.look[1]) * Math.min(1, dt * 4);
    for (const e of c.eyes) {
      e.iris.rotation.set(m.look[0], m.look[1], 0);
      e.lid.scale.y = closed ? 1 : 0.001; e.lid.position.y = closed ? 0 : 0.07 * e.sz;
    }
    // footsteps: when a foot comes down
    const footDown = Math.floor(m.phase / Math.PI);
    if (footDown !== m.lastStep) {
      m.lastStep = footDown;
      const leg = c.legs[footDown % 2 ? 0 : 1];
      leg.pivot.updateWorldMatrix(true, false);
      const e = leg.pivot.matrixWorld.elements;
      stomp(e[12] + e[8] * 0.05 * MONSTER_HEIGHT, e[14] + e[10] * 0.05 * MONSTER_HEIGHT);
    }
  }

  function stomp(x, z) {
    mon.shake = Math.max(mon.shake, SHAKE);
    sound('stomp');
    for (let k = 0; k < 6; k++) { const a = Math.random() * Math.PI * 2; puff(x + Math.cos(a) * 0.15, 0.05, z + Math.sin(a) * 0.15, { vx: Math.cos(a) * 0.4, vy: 0.05, vz: Math.sin(a) * 0.4, size: rnd(0.08, 0.14), life: rnd(1, 2) }); }
    const foot = MONSTER_HEIGHT * 0.1;
    const res = window.scResidents;
    if (res) {
      if (res.gibAround) res.gibAround(x, z, foot, 0.5);           // squashed
      if (res.blast) res.blast(x, z, foot * 2.2, 0, 0);             // knocked over
    }
    // cars underfoot: flattened
    if (trafficCars) {
      let proxies = null;
      trafficCars.forEach((car, i) => {
        if (car.scFlat || Math.hypot(car.x - x, car.z - z) > foot * 1.3) return;
        if (!proxies) { proxies = new Map(); scene.traverse((o) => { const cc = o.userData && o.userData.car; if (cc && typeof cc.index === 'number') proxies.set(cc.index, o); }); }
        car.scFlat = true; car.parked = Infinity; car.speed = 0;
        const p = proxies.get(i); if (p) p.scale.set(1.15, 0.22, 1.2);
      });
    }
  }

  function stepShake(dt) {
    const el = renderer && renderer.domElement; if (!el || !mon) return;
    mon.shake *= Math.exp(-6 * dt);
    const a = mon.shake;
    if (a < 0.3) { el.style.transform = ''; return; }
    el.style.transform = `translate(${((Math.random() * 2 - 1) * a).toFixed(1)}px, ${((Math.random() * 2 - 1) * a).toFixed(1)}px)`;
  }

  // ---------- loop ----------
  let looping = false, last = 0, lastCheck = 0;
  function loop(t) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0); last = t;
    const safe = (name, fn) => { try { fn(); } catch (e) { if (!loop.warned) loop.warned = {}; if (!loop.warned[name]) { loop.warned[name] = 1; console.warn('[monster] ' + name, e); } } };
    if (mon) {
      safe('think', () => think(dt));
      safe('trample', () => trample(t));
      safe('animate', () => animate(dt));
      safe('shake', () => stepShake(dt));
      if (t - mon.alarmAt > 2000) { mon.alarmAt = t; const r = window.scResidents; if (r && r.alarm) r.alarm(mon.x, mon.z, MONSTER_HEIGHT * 2.5, 8); }
    }
    safe('collapse', () => stepCollapses(dt));
    safe('dust', () => stepPuffs(dt));
    // the app redrew a city block: keep destroyed buildings gone
    if (destroyed.size && t - lastCheck > 1000) { lastCheck = t; safe('keep', () => removeIn(...destroyed.values())); }
  }

  // ---------- sound ----------
  let audio = null;
  function sound(kind) {
    if (!SOUND) return;
    try {
      audio = audio || new AudioContext();
      const a = audio, t = a.currentTime, g = a.createGain(); g.connect(a.destination);
      if (kind === 'stomp') {
        const o = a.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.35);
        g.gain.setValueAtTime(0.7, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4); o.connect(g); o.start(t); o.stop(t + 0.45);
      } else if (kind === 'crash') {
        const len = 2.2, buf = a.createBuffer(1, Math.floor(a.sampleRate * len), a.sampleRate), ch = buf.getChannelData(0);
        for (let i = 0; i < ch.length; i++) { const x = i / ch.length; ch[i] = (Math.random() * 2 - 1) * (1 - x) ** 1.5 * (0.6 + 0.4 * Math.sin(x * 90) ** 2); }
        const src = a.createBufferSource(), f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(1800, t); f.frequency.exponentialRampToValueAtTime(200, t + len);
        src.buffer = buf; src.connect(f); f.connect(g); g.gain.setValueAtTime(0.8, t); src.start(t);
      } else if (kind === 'roar') {
        const o = a.createOscillator(), o2 = a.createOscillator(), f = a.createBiquadFilter(); o.type = 'sawtooth'; o2.type = 'sawtooth';
        o.frequency.setValueAtTime(90, t); o.frequency.linearRampToValueAtTime(140, t + 0.5); o.frequency.linearRampToValueAtTime(70, t + 1.8);
        o2.frequency.setValueAtTime(93, t); o2.frequency.linearRampToValueAtTime(137, t + 0.5); o2.frequency.linearRampToValueAtTime(72, t + 1.8);
        f.type = 'lowpass'; f.frequency.value = 700; o.connect(f); o2.connect(f); f.connect(g);
        g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.25); g.gain.exponentialRampToValueAtTime(0.001, t + 2);
        o.start(t); o2.start(t); o.stop(t + 2); o2.stop(t + 2);
      }
    } catch {}
  }

  // ---------- button ----------
  const SVG = 'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="g-ico" aria-hidden="true"';
  const ICON = `<svg ${SVG}><path d="M12 3c4.5 0 7 3.5 7 8v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-8c0-4.5 2.5-8 7-8z"/><circle cx="9" cy="10" r="2.2"/><circle cx="15" cy="10" r="2.2"/><path d="M11.2 10h1.6"/><path d="M9.5 15.5c1.5 1 3.5 1 5 0"/></svg>`;
  function updateButton() {
    const b = document.getElementById('sc-monster'); if (!b) return;
    const label = mon ? 'Monster wegsturen' : 'Monster loslaten';
    b.title = label; b.setAttribute('aria-label', label);
    b.style.color = mon ? '#2b8a46' : '';
  }
  function ensureButton() {
    if (document.getElementById('sc-monster')) return;
    const row = document.querySelector('.hz-tr .menu-mini'); if (!row) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'icon-btn small'; b.id = 'sc-monster';
    b.innerHTML = '<b class="s-bg"></b>' + ICON;
    b.addEventListener('click', () => { try { audio = audio || new AudioContext(); } catch {} if (mon) sendAway(); else release(); });
    row.appendChild(b);
    updateButton();
  }
  const start = () => { ensureButton(); new MutationObserver(ensureButton).observe(document.body, { childList: true, subtree: true }); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
