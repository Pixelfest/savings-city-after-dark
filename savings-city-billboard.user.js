// ==UserScript==
// @name         Savings City – destructible billboard (walk mode)
// @namespace    savings-city-tweaks
// @version      1.0
// @description  In walk mode the big "Savings City" billboard can be destroyed: every shot knocks a piece out of it, rockets blow holes in it and can take out its posts, and whatever is no longer held up falls down.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Needs the walk-mode script (1.22 or newer): window.scWalk.addTarget makes the board shootable,
 * sc:blast events (rockets, exploding cars – rocket launcher 1.5+ tells the height) reach it.
 *
 * - The app builds the billboard once: a group with userData.kind === 'billboard' holding the
 *   panel (a 3.4 × 1.7 × 0.1 box: plain sides, the logo canvas on front and back) and two posts
 *   (0.12 × 1.3 × 0.12). Nothing changes until it's first hit.
 * - First hit: the panel is hidden for good (its `visible` pinned to false) and redrawn as a grid
 *   of COLS × ROWS tiles in one mesh, with the panel's own two materials; each tile carries its
 *   part of the logo (front and back), so it looks the same until pieces come off.
 * - A shot knocks out the tile it hits (it flies off along the shot, tumbles, and lies on the
 *   ground); a blast blows out every tile within reach and can break a post.
 * - After every change the tiles still held up are worked out: those connected (side by side)
 *   to a bottom tile resting on an intact post. With one post left it can't carry the whole
 *   width: only tiles within ONE_POST_REACH columns of it. Everything else falls down.
 * - Removed tiles are collapsed to a point in the big mesh; flying ones are small meshes of their
 *   own (at most COLS × ROWS of them).
 */
(function () {
  'use strict';

  // ---- settings (tiles; 1 tile ≈ 20 m) ----
  const COLS = 20, ROWS = 10;      // pieces the panel breaks into (each ≈ 3.4 m)
  const SHOT_PIECES = 1;           // tiles a bullet knocks out (the one it hits, plus neighbours beyond 1)
  const BLAST_REACH = 0.35;        // a blast blows out tiles this close (plus a third of its knock radius)
  const POST_REACH = 0.25;         // …and breaks a post this close
  const ONE_POST_REACH = 3;        // with one post left, it only holds tiles up to this many columns away from it
  const GRAVITY = 3;               // tiles/s²
  const GROUND = 0.02;             // where pieces come to rest
  // -----------------------------------------

  const rnd = (a, b) => a + Math.random() * (b - a);
  const W = () => window.scWalk;
  let K = null;
  let board = null;                // { group, panel, posts: [{ mesh, x, broken }], mesh, geo, tiles: [...], w, h, d }
  const flying = [];               // { m, vx, vy, vz, wx, wy, wz, rest }

  function hideForever(o) {
    try { Object.defineProperty(o, 'visible', { get() { return false; }, set() {}, configurable: true }); } catch { o.visible = false; }
  }

  // ---------- finding it ----------
  function find() {
    const w = W(); if (!w || !w.scene) return null;
    let g = null;
    w.scene.traverse((o) => { if (!g && o.userData && o.userData.kind === 'billboard') g = o; });
    if (!g) return null;
    const box = (o, a, b, c) => { const p = o.geometry && o.geometry.parameters; return p && Math.abs(p.width - a) < 1e-6 && Math.abs(p.height - b) < 1e-6 && Math.abs(p.depth - c) < 1e-6; };
    const panel = g.children.find((o) => o.isMesh && box(o, 3.4, 1.7, 0.1));
    const posts = g.children.filter((o) => o.isMesh && box(o, 0.12, 1.3, 0.12));
    if (!panel) return null;
    return { group: g, panel, posts: posts.map((m) => ({ mesh: m, x: m.position.x - panel.position.x, broken: false })), w: 3.4, h: 1.7, d: 0.1, tiles: null };
  }
  function ready() {
    if (!K && !(K = W() && W().classes())) return false;
    if (!board) board = find();
    return !!board;
  }

  // ---------- the panel as tiles ----------
  // One tile as triangles: its four sides (material 0) and front/back (material 1, the logo).
  // UVs as three.js' BoxGeometry: front u = left → right, back mirrored (reads right from behind).
  function tileTris(i, j, cx, cy, cz) {
    const { w, h, d } = board, tw = w / COLS, th = h / ROWS;
    // neighbours' shared edges come from the same formula, so they match exactly (no hairline cracks)
    const x0 = -w / 2 + i * tw, x1 = -w / 2 + (i + 1) * tw, y0 = -h / 2 + j * th, y1 = -h / 2 + (j + 1) * th, z0 = -d / 2, z1 = d / 2;
    const side = { p: [], n: [], uv: [] }, face = { p: [], n: [], uv: [] };
    const quad = (t, a, b, c, e, n, uvs) => {
      for (const [v, uv] of [[a, uvs[0]], [b, uvs[1]], [c, uvs[2]], [a, uvs[0]], [c, uvs[2]], [e, uvs[3]]]) {
        t.p.push(v[0] - cx, v[1] - cy, v[2] - cz); t.n.push(...n); t.uv.push(...uv);
      }
    };
    const U = (x) => (x + w / 2) / w, Ub = (x) => (w / 2 - x) / w, V = (y) => (y + h / 2) / h, plain = [[0, 0], [0, 0], [0, 0], [0, 0]];
    quad(face, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], [[U(x0), V(y0)], [U(x1), V(y0)], [U(x1), V(y1)], [U(x0), V(y1)]]);
    quad(face, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], [[Ub(x1), V(y0)], [Ub(x0), V(y0)], [Ub(x0), V(y1)], [Ub(x1), V(y1)]]);
    quad(side, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], plain);
    quad(side, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], plain);
    quad(side, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], plain);
    quad(side, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], plain);
    return { side, face, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }
  function makeGeo(parts) {
    const P = [], N = [], UV = [];
    for (const t of parts) { P.push(...t.side.p); N.push(...t.side.n); UV.push(...t.side.uv); }
    const sideCount = P.length / 3;
    for (const t of parts) { P.push(...t.face.p); N.push(...t.face.n); UV.push(...t.face.uv); }
    const g = new K.Geometry();
    g.setAttribute('position', new K.Attr(new Float32Array(P), 3));
    g.setAttribute('normal', new K.Attr(new Float32Array(N), 3));
    g.setAttribute('uv', new K.Attr(new Float32Array(UV), 2));
    g.addGroup(0, sideCount, 0);
    g.addGroup(sideCount, P.length / 3 - sideCount, 1);
    return g;
  }
  function materials() {
    const m = board.panel.material;
    return Array.isArray(m) ? [m[0], m[4] || m[m.length - 1]] : [m, m];
  }
  // replace the panel by tiles (once)
  function shatter() {
    if (board.tiles) return true;
    const tiles = [], parts = [];
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
      const t = tileTris(i, j, 0, 0, 0);
      tiles.push({ i, j, cx: t.cx, cy: t.cy, there: true });
      parts.push(t);
    }
    board.geo = makeGeo(parts);
    board.mesh = new K.Mesh(board.geo, materials());
    board.mesh.castShadow = true; board.mesh.receiveShadow = true;
    board.mesh.position.copy(board.panel.position); board.mesh.quaternion.copy(board.panel.quaternion);
    board.mesh.userData.scBillboard = true;
    board.group.add(board.mesh);
    hideForever(board.panel);
    board.tiles = tiles;
    board.sideVerts = 24; board.faceVerts = 12; board.faceStart = COLS * ROWS * 24;
    board.orig = board.geo.attributes.position.array.slice();
    for (const t of tiles) sides(t);
    board.geo.attributes.position.needsUpdate = true;
    return true;
  }
  const tileAt = (i, j) => (i >= 0 && j >= 0 && i < COLS && j < ROWS ? board.tiles[j * COLS + i] : null);
  // A tile's side faces (+x, −x, +y, −y, 6 vertices each) only show where nothing is next to it:
  // inside the board they'd flicker against the front at the shared edges.
  function sides(t) {
    const pos = board.geo.attributes.position, k = t.j * COLS + t.i;
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([di, dj], q) => {
      const n = tileAt(t.i + di, t.j + dj), show = t.there && !(n && n.there);
      for (let v = k * 24 + q * 6; v < k * 24 + q * 6 + 6; v++) {
        if (show) pos.setXYZ(v, board.orig[v * 3], board.orig[v * 3 + 1], board.orig[v * 3 + 2]); else pos.setXYZ(v, t.cx, t.cy, 0);
      }
    });
  }

  // the tile leaves the panel: collapsed in the big mesh, a loose copy flies off with velocity v
  function knockOut(t, v) {
    if (!t || !t.there) return;
    t.there = false;
    const pos = board.geo.attributes.position, k = t.j * COLS + t.i;
    for (const [start, n] of [[k * board.sideVerts, board.sideVerts], [board.faceStart + k * board.faceVerts, board.faceVerts]]) {
      for (let q = start; q < start + n; q++) pos.setXYZ(q, t.cx, t.cy, 0);
    }
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = tileAt(t.i + di, t.j + dj); if (n && n.there) sides(n); }
    pos.needsUpdate = true;
    board.geo.computeBoundingSphere();
    // the loose piece, in world space
    const piece = tileTris(t.i, t.j, t.cx, t.cy, 0);
    const m = new K.Mesh(makeGeo([piece]), materials());
    m.castShadow = true;
    board.mesh.updateWorldMatrix(true, false);
    const wp = new K.V3(t.cx, t.cy, 0).applyMatrix4(board.mesh.matrixWorld);
    m.position.copy(wp);
    board.mesh.getWorldQuaternion(m.quaternion);
    W().scene.add(m);
    flying.push({ m, vx: v.x, vy: v.y, vz: v.z, wx: rnd(-8, 8), wy: rnd(-4, 4), wz: rnd(-8, 8), rest: false });
    loop();
  }

  // Which tiles are still held up: flood fill from the bottom tiles on intact posts.
  function settle() {
    const held = new Set(), stack = [];
    const tw = board.w / COLS, standing = board.posts.filter((p) => !p.broken);
    const postCol = (p) => Math.floor((p.x + board.w / 2) / tw);
    const allowed = (t) => standing.length !== 1 || Math.abs(t.i - postCol(standing[0])) <= ONE_POST_REACH;
    for (const p of board.posts) {
      if (p.broken) continue;
      for (let i = 0; i < COLS; i++) {
        const x0 = -board.w / 2 + i * tw;
        if (x0 < p.x + 0.06 && x0 + tw > p.x - 0.06) { const t = tileAt(i, 0); if (t && t.there && allowed(t)) stack.push(t); }
      }
    }
    while (stack.length) {
      const t = stack.pop(), key = t.j * COLS + t.i;
      if (held.has(key)) continue;
      held.add(key);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = tileAt(t.i + di, t.j + dj); if (n && n.there && allowed(n) && !held.has(n.j * COLS + n.i)) stack.push(n); }
    }
    let fell = 0;
    for (const t of board.tiles) if (t.there && !held.has(t.j * COLS + t.i)) { knockOut(t, { x: rnd(-0.08, 0.08), y: rnd(-0.1, 0.05), z: rnd(-0.08, 0.08) }); fell++; }
    if (fell > 6) W().sound('crack');
  }

  // a post snaps: a copy tips over from its foot, away from (dx, dz)
  function breakPost(p, dx, dz) {
    if (p.broken) return;
    p.broken = true;
    p.mesh.updateWorldMatrix(true, false);
    const copy = new K.Mesh(p.mesh.geometry, p.mesh.material);
    copy.castShadow = true;
    const wp = new K.V3(); p.mesh.getWorldPosition(wp);
    copy.position.copy(wp); p.mesh.getWorldQuaternion(copy.quaternion);
    W().scene.add(copy);
    hideForever(p.mesh);
    const l = Math.hypot(dx, dz) || 1;
    flying.push({ m: copy, vx: dx / l * 0.4, vy: 0.3, vz: dz / l * 0.4, wx: dz / l * 3, wy: 0, wz: -dx / l * 3, rest: false, half: 0.06 });
    W().sound('crack');
    loop();
  }

  // ---------- falling pieces ----------
  let loopOn = false, last = 0;
  function loop() {
    if (loopOn) return;
    loopOn = true; last = 0;
    requestAnimationFrame(step);
  }
  function step(t) {
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0); last = t;
    const w = W();
    let moving = 0;
    for (const f of flying) {
      if (f.rest) continue;
      moving++;
      f.vy -= GRAVITY * dt;
      f.m.position.x += f.vx * dt; f.m.position.y += f.vy * dt; f.m.position.z += f.vz * dt;
      f.m.rotation.x += f.wx * dt; f.m.rotation.y += f.wy * dt; f.m.rotation.z += f.wz * dt;
      const low = f.half || 0.05;                                  // about half its thinnest side
      if (f.m.position.y - low < GROUND) {
        f.m.position.y = GROUND + low;
        if (f.vy < -0.4) {                                         // bounce
          f.vy = -f.vy * 0.25; f.vx *= 0.5; f.vz *= 0.5; f.wx *= 0.5; f.wz *= 0.5;
          if (w && Math.random() < 0.3) w.spawn('dust', f.m.position.x, GROUND + 0.02, f.m.position.z, { fade: true, alpha: 0.5, grow: 3, rise: 0.05, drag: 2, size: 0.06, life: 1.5 });
        } else {                                                   // settle flat
          const snap = (a) => Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
          f.m.rotation.x = snap(f.m.rotation.x); f.m.rotation.z = snap(f.m.rotation.z);
          f.m.position.y = GROUND + (Math.abs(Math.cos(f.m.rotation.x) * Math.cos(f.m.rotation.z)) > 0.5 && !f.half ? 0.05 : low);
          f.rest = true;
        }
      }
    }
    if (w && moving) w.startEffects();
    if (moving) requestAnimationFrame(step); else loopOn = false;
  }

  // ---------- shooting it ----------
  // the ray in the panel's own coordinates; inside the board, the first tile that's still there
  function hitPanel(o, d, maxT) {
    const m = board.tiles ? board.mesh : board.panel;
    m.updateWorldMatrix(true, false);
    const inv = new K.M4().copy(m.matrixWorld).invert();
    const O = new K.V3(o.x, o.y, o.z).applyMatrix4(inv), D = new K.V3(o.x + d.x, o.y + d.y, o.z + d.z).applyMatrix4(inv).sub(O);
    const lo = [-board.w / 2, -board.h / 2, -board.d / 2], hi = [board.w / 2, board.h / 2, board.d / 2], OO = [O.x, O.y, O.z], DD = [D.x, D.y, D.z];
    let t0 = 0, t1 = maxT;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(DD[k]) < 1e-12) { if (OO[k] < lo[k] || OO[k] > hi[k]) return null; continue; }
      let a = (lo[k] - OO[k]) / DD[k], b = (hi[k] - OO[k]) / DD[k]; if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) return null;
    }
    if (!board.tiles) return { t: t0, i: Math.floor((OO[0] + DD[0] * t0 + board.w / 2) / (board.w / COLS)), j: Math.floor((OO[1] + DD[1] * t0 + board.h / 2) / (board.h / ROWS)) };
    // march through the board's thickness: holes let the bullet through
    for (let s = 0; s <= 6; s++) {
      const t = t0 + (t1 - t0) * (s / 6), x = OO[0] + DD[0] * t, y = OO[1] + DD[1] * t;
      const i = Math.min(COLS - 1, Math.max(0, Math.floor((x + board.w / 2) / (board.w / COLS)))), j = Math.min(ROWS - 1, Math.max(0, Math.floor((y + board.h / 2) / (board.h / ROWS))));
      const tile = tileAt(i, j);
      if (tile && tile.there) return { t, i, j };
    }
    return null;
  }
  function hitPost(o, d, maxT) {
    let best = null;
    for (const p of board.posts) {
      if (p.broken) continue;
      const m = p.mesh; m.updateWorldMatrix(true, false);
      const inv = new K.M4().copy(m.matrixWorld).invert();
      const O = new K.V3(o.x, o.y, o.z).applyMatrix4(inv), D = new K.V3(o.x + d.x, o.y + d.y, o.z + d.z).applyMatrix4(inv).sub(O);
      const OO = [O.x, O.y, O.z], DD = [D.x, D.y, D.z], hs = [0.06, 0.65, 0.06];
      let t0 = 0, t1 = best ? best.t : maxT, ok = true;
      for (let k = 0; k < 3 && ok; k++) {
        if (Math.abs(DD[k]) < 1e-12) { if (Math.abs(OO[k]) > hs[k]) ok = false; continue; }
        let a = (-hs[k] - OO[k]) / DD[k], b = (hs[k] - OO[k]) / DD[k]; if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) ok = false;
      }
      if (ok && t0 > 0) best = { t: t0, post: p };
    }
    return best;
  }
  function register() {
    const w = W();
    if (register.done || !w || !w.addTarget) return;
    register.done = true;
    w.addTarget({
      hit(o, d, maxT) {
        if (!ready()) return null;
        let best = hitPanel(o, d, maxT);
        const post = hitPost(o, d, best ? best.t : maxT);
        if (post) best = post;
        if (best) best.at = { x: o.x + d.x * best.t, y: o.y + d.y * best.t, z: o.z + d.z * best.t };
        return best;
      },
      onHit(h, d) {
        const w = W();
        for (let k = 0; k < 6; k++) w.spawn(h.post ? 'spark' : 'debris', h.at.x, h.at.y, h.at.z, { vx: rnd(-0.4, 0.4) - d.x * 0.3, vy: rnd(0, 0.5), vz: rnd(-0.4, 0.4) - d.z * 0.3, g: 3, size: h.post ? 0.004 : rnd(0.004, 0.009), life: rnd(0.4, 1), land: !h.post, spin: true });
        w.startEffects();
        if (h.post) { w.sound('glass'); return; }                 // steel: sparks, it holds
        if (!shatter()) return;
        w.sound('thud');
        const v = () => ({ x: d.x * rnd(0.5, 1) + rnd(-0.15, 0.15), y: d.y * 0.5 + rnd(0, 0.3), z: d.z * rnd(0.5, 1) + rnd(-0.15, 0.15) });
        knockOut(tileAt(h.i, h.j), v());
        for (let n = 1; n < SHOT_PIECES; n++) knockOut(tileAt(h.i + Math.round(rnd(-1, 1)), h.j + Math.round(rnd(-1, 1))), v());
        settle();
      },
    });
  }

  // ---------- explosions ----------
  window.addEventListener('sc:blast', (e) => {
    const { x, y = 0.08, z, knock = 0.6 } = e.detail || {};
    if (!ready()) return;
    const reach = BLAST_REACH + knock / 3;
    // the board's tiles in world space
    const m = board.tiles ? board.mesh : board.panel;
    m.updateWorldMatrix(true, false);
    const e2 = m.matrixWorld.elements, world = (lx, ly) => [e2[0] * lx + e2[4] * ly + e2[12], e2[1] * lx + e2[5] * ly + e2[13], e2[2] * lx + e2[6] * ly + e2[14]];
    const [cx, cy, cz] = world(0, 0);
    if (Math.hypot(cx - x, cy - y, cz - z) > reach + 2) return;  // nowhere near
    let any = false;
    const hits = [];
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
      const tw = board.w / COLS, th = board.h / ROWS, [tx, ty, tz] = world(-board.w / 2 + (i + 0.5) * tw, -board.h / 2 + (j + 0.5) * th);
      const dist = Math.hypot(tx - x, ty - y, tz - z);
      if (dist <= reach * rnd(0.75, 1.1)) hits.push([i, j, tx - x, ty - y, tz - z, dist]);
    }
    if (hits.length) {
      shatter(); any = true;
      for (const [i, j, dx, dy, dz, dist] of hits) {
        const p = 2.2 * (1 - dist / (reach * 1.1)) + 0.3, l = dist || 1;
        knockOut(tileAt(i, j), { x: dx / l * p + rnd(-0.2, 0.2), y: dy / l * p + rnd(0.2, 0.8), z: dz / l * p + rnd(-0.2, 0.2) });
      }
    }
    for (const p of board.posts) {
      if (p.broken) continue;
      const wp = new K.V3(); p.mesh.getWorldPosition(wp);
      const dy = Math.max(0, Math.abs(y - wp.y) - 0.65);
      if (Math.hypot(wp.x - x, dy, wp.z - z) <= POST_REACH + knock / 4) { shatter(); breakPost(p, wp.x - x, wp.z - z); any = true; }
    }
    if (any) settle();
  });

  // walk mode starts: make the board a target
  window.addEventListener('sc:walk', () => register());
  let tries = 0;
  const poll = setInterval(() => { if (W() && W().addTarget) { register(); clearInterval(poll); } else if (++tries > 120) clearInterval(poll); }, 1000);

  window.scBillboard = { get tilesLeft() { return board && board.tiles ? board.tiles.filter((t) => t.there).length : COLS * ROWS; },
    get postsLeft() { return board ? board.posts.filter((p) => !p.broken).length : 2; },
    get center() { if (!ready()) return null; const v = new K.V3(); board.panel.getWorldPosition(v); return { x: v.x, y: v.y, z: v.z }; } };
})();
