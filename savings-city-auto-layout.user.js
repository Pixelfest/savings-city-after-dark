// ==UserScript==
// @name         Savings City – auto layout (tall in the centre)
// @namespace    savings-city-tweaks
// @version      2.3
// @description  Shows the city rearranged: tallest buildings in the centre, smaller ones outward, with organically grown streets. View only – nothing is saved to the server.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * How it works
 * ------------
 * The app loads the whole city with one request, GET /api/city → {projects, roads, revision}.
 *   project.gx / gy / facing   – grid position + which side the front door is on (0=N 1=E 2=S 3=W)
 *   roads                      – keys "x,y,h" / "x,y,v": road on the grid line from point (x,y)
 *                                to (x+1,y) (h) or (x,y+1) (v). A front door must touch a road.
 * This script intercepts that response and replaces positions and roads with a generated layout.
 * Building shapes and heights come from the app's own code (imported from its main module),
 * so the layout uses exactly the footprints the app will draw.
 *
 * Algorithm ("ranked organic growth")
 *   Buildings are placed one at a time, tallest first, so the city grows outward from its centre
 *   like a real town: the tallest end up downtown, the smallest on the edges.
 *   For each building:
 *     1. Try every free spot and all 4 rotations around what's already built. A spot is free when
 *        it keeps GAP tiles from other buildings, stays clear of the welcome sign, and no existing
 *        road would run through it. Score = distance from the centre, with a gentle wobble
 *        (ORGANIC) so the outline isn't a perfect circle.
 *     2. For the best spots, find the cheapest road from the front door to the existing road
 *        network (Dijkstra; existing roads are nearly free, bends cost extra). Pick the spot with
 *        the best score + new-road length. Buildings therefore cluster along streets, and streets
 *        branch off each other like a tree instead of forming a grid.
 *     3. Place it and lay its road. Later buildings may never cut through existing roads, so
 *        every door stays connected.
 *   Then (RING_ROAD):
 *     4. A ring road is drawn around the city, RING_MARGIN tiles outside the outer buildings. The
 *        outline is smoothed (dents filled, spikes trimmed) and goes around the welcome sign's zone.
 *     5. Every dead end is extended with new road (at most CONNECT_MAX tiles) until it meets the
 *        ring or a part of the network that is far away along the roads, which creates loops.
 *     6. Whatever is still separate is joined to the main network.
 *
 * While the layout is on, requests that would save positions or roads are blocked, so the
 * real (server) city is never changed. Turn the layout off to place buildings or roads.
 */
(function () {
  'use strict';

  // ---- settings -------------------------------------------------------------------------
  const GAP = 1;            // empty tiles between buildings (0 = may touch; roads need 1 to pass between)
  const ORGANIC = 0.35;     // 0 = round, tidy blob; higher = more irregular outline and placement
  const ROAD_WEIGHT = 0.6;  // how strongly buildings prefer spots that need little new road
  const TURN_COST = 0.6;    // higher = straighter roads with fewer bends
  const CANDIDATES = 14;    // best spots per building that get a road check
  const SIGN_MARGIN = 5;    // tiles to keep free around the welcome sign (app rule)
  const RING_ROAD = false;  // road around the whole city, with the loose ends connected to it
  const RING_MARGIN = 2;    // tiles between the outermost buildings and the ring road
  const CONNECT_MAX = 12;   // longest new road (tiles) used to connect a dead end
  const MIN_LOOP = 8;       // a dead end only connects to road at least this far away along the roads
  // ---------------------------------------------------------------------------------------

  const KEY = 'sc-tweaks:layout';
  const isOn = () => { try { return localStorage.getItem(KEY) === 'on'; } catch { return false; } };
  const setOn = (v) => { try { localStorage.setItem(KEY, v ? 'on' : 'off'); } catch {} };

  // ---------- access the app's own helpers ----------
  let appModule;
  async function app() {
    if (appModule) return appModule;
    const s = [...document.querySelectorAll('script[type="module"][src]')].find((s) => /\/index-[^/]*\.js/.test(s.src));
    if (!s) throw new Error('main module not found');
    const m = findHelpers(await import(s.src));   // same URL → the already-loaded module instance
    const ok = typeof m.v === 'function' && typeof m.A === 'function' && typeof m.a === 'function';
    if (!ok) throw new Error('app internals changed (new build?)');
    appModule = m;
    return m;
  }
  // The app's minified export names change with every build, so its helpers are recognised by
  // what their code looks like (checked against the builds of 24 and 25 Nov 2026):
  //   v = placed projects → [{id, fp, gx, gy, facing}]   A = rotate a footprint (fp, facing)
  //   a = front-door road keys (gx, gy, fp, facing)      w = floors of a project
  //   S = cells of a footprint                           n = tiles of the welcome sign
  function findHelpers(m) {
    const fns = Object.values(m).filter((f) => typeof f === 'function');
    const code = (f) => { try { return Function.prototype.toString.call(f); } catch { return ''; } };
    const find = (re) => fns.find((f) => re.test(code(f)));
    const isSign = (a) => Array.isArray(a) && a.length >= 4 && a.length <= 64 && a.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isInteger));
    return {
      v: find(/\.filter\(\w+\)\.map\(\w+=>\(\{id:\w+\.id,fp:/),
      A: find(/^function\s*\w*\(\w+,\w+\)\{let \w+=\w+\.base\?\?\w+/),
      a: find(/^function\s*\w*\(\w+,\w+,\w+,\w+\)\{\w+=\w+\(\w+,\w+\);let \w+=\[\];for\(let\[\w+,\w+\]of /),
      w: find(/^function\s*\w*\(\w+,\w+=\w+\)\{return \w+\(\w+\)\?Math\.min\(/),
      S: find(/\{let (\w+)=\[\];for\(let (\w+)=0;\2<\w+\.w;\2\+\+\)for\(let (\w+)=0;\3<\w+\.d;\3\+\+\)\w+\(\w+,\2,\3\)&&\1\.push/),
      n: Object.values(m).find(isSign),
    };
  }

  // ---------- layout ----------
  // Facing = side of the front door: 0=N 1=E 2=S 3=W.
  const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];          // moves between grid points: E S W N

  // Small deterministic pseudo-random number in [0,1) per string, so the layout is stable.
  function rand(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 100000) / 100000;
  }

  // Min-heap for Dijkstra.
  class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(x) { const a = this.a; a.push(x); let i = a.length - 1;
      while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
    pop() { const a = this.a, top = a[0], last = a.pop();
      if (a.length) { a[0] = last; let i = 0;
        for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
      return top; }
  }

  function layout(m, projects) {
    const placed = m.v(projects);                       // only projects that are on the map
    if (!placed.length || !placed[0].fp || typeof placed[0].fp.w !== 'number') throw new Error('unexpected footprint data');
    const byId = new Map(projects.map((p) => [p.id, p]));
    const floors = (p) => { try { const f = m.w(p); if (typeof f === 'number') return f; } catch {} return 1; };
    const hours = (p) => (p.time_spent_ai == null ? 0 : (p.time_estimated_no_ai || 0) - p.time_spent_ai);
    const cellsOf = (fp) => {
      try { const c = m.S(fp); if (Array.isArray(c) && c.length) return c; } catch {}
      const c = []; for (let x = 0; x < fp.w; x++) for (let y = 0; y < fp.d; y++) c.push([x, y]); return c;
    };

    const items = placed.map((b) => {
      const p = byId.get(b.id);
      return { id: String(b.id), base: b.fp.base ?? b.fp, floors: floors(p), hours: hours(p), oldX: b.gx, oldY: b.gy };
    });
    items.sort((a, b) => b.floors - a.floors || b.hours - a.hours || a.id.localeCompare(b.id));   // tallest first

    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const cx = Math.round(mean(items.map((i) => i.oldX))), cy = Math.round(mean(items.map((i) => i.oldY)));

    // Area around the welcome sign where nothing may go.
    const sign = Array.isArray(m.n) ? m.n : [];
    const nearSign = sign.length ? (() => {
      const x0 = Math.min(...sign.map((t) => t[0])) - SIGN_MARGIN, x1 = Math.max(...sign.map((t) => t[0])) + SIGN_MARGIN;
      const y0 = Math.min(...sign.map((t) => t[1])) - SIGN_MARGIN, y1 = Math.max(...sign.map((t) => t[1])) + SIGN_MARGIN;
      return (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    })() : () => false;

    const occ = new Map();        // tile "x,y" → building id
    const keepOut = new Set();    // tiles within GAP of a building (no other building there)
    const roads = new Set();      // road keys "x,y,h|v"
    const nodes = new Set();      // grid points that are on a road
    let bx0 = cx, bx1 = cx, by0 = cy, by1 = cy;   // bounding box of everything so far
    const tk = (x, y) => x + ',' + y;

    // The two tiles on either side of a road edge.
    const sides = (k) => { const [x, y, t] = k.split(','); const a = +x, b = +y;
      return t === 'h' ? [tk(a, b - 1), tk(a, b)] : [tk(a - 1, b), tk(a, b)]; };
    const edgeKey = (x, y, d) => d === 0 ? `${x},${y},h` : d === 1 ? `${x},${y},v` : d === 2 ? `${x - 1},${y},h` : `${x},${y - 1},v`;
    const edgeOk = (k) => { const [p, q] = sides(k);
      if (occ.has(p) && occ.has(q)) return false;                       // would run between/through buildings
      const [x, y] = k.split(',').map(Number); return !nearSign(x, y); };
    const addRoad = (k) => { roads.add(k); const [x, y, t] = k.split(','); const a = +x, b = +y;
      nodes.add(tk(a, b)); nodes.add(t === 'h' ? tk(a + 1, b) : tk(a, b + 1)); };

    // Cheapest road from the door to the existing network (Dijkstra with a turn penalty,
    // existing roads are almost free, so new roads branch off old ones like real streets).
    function route(doorKeys, limit) {
      if (!nodes.size) return [];
      const src = new Set(); for (const k of doorKeys) { const [x, y, t] = k.split(',').map((v, i) => i < 2 ? +v : v);
        src.add(tk(x, y)); src.add(t === 'h' ? tk(x + 1, y) : tk(x, y + 1)); }
      for (const s of src) if (nodes.has(s)) return [];
      const X0 = bx0 - 6, X1 = bx1 + 6, Y0 = by0 - 6, Y1 = by1 + 6;
      const dist = new Map(), prev = new Map(), h = new Heap();
      for (const s of src) { const [x, y] = s.split(',').map(Number); const st = `${x},${y},-1`; dist.set(st, 0); h.push([0, x, y, -1]); }
      while (h.size) {
        const [c, x, y, d] = h.pop(); const st = `${x},${y},${d}`;
        if (c > dist.get(st) || c > limit) continue;
        if (nodes.has(tk(x, y)) && d !== -1) {               // reached the network: walk back
          const path = []; let cur = st;
          while (prev.has(cur)) { const [k, p] = prev.get(cur); path.push(k); cur = p; }
          return path;
        }
        for (let nd = 0; nd < 4; nd++) {
          const nx = x + DIRS[nd][0], ny = y + DIRS[nd][1];
          if (nx < X0 || nx > X1 || ny < Y0 || ny > Y1) continue;
          const k = edgeKey(x, y, nd); if (!edgeOk(k)) continue;
          const nc = c + (roads.has(k) ? 0.05 : 1) + (d !== -1 && d !== nd ? TURN_COST : 0);
          const ns = `${nx},${ny},${nd}`;
          if (nc < (dist.get(ns) ?? Infinity)) { dist.set(ns, nc); prev.set(ns, [k, st]); h.push([nc, nx, ny, nd]); }
        }
      }
      return null;   // no connection possible
    }

    for (const it of items) {
      // 1. collect free spots near the centre, for all 4 rotations
      const cands = [];
      for (let f = 0; f < 4; f++) {
        const fp = m.A(it.base, f), cells = cellsOf(fp);
        for (let gx = bx0 - fp.w - GAP - 2; gx <= bx1 + GAP + 2; gx++) {
          for (let gy = by0 - fp.d - GAP - 2; gy <= by1 + GAP + 2; gy++) {
            let ok = true;
            const mine = new Set();
            for (const [a, b] of cells) { const x = gx + a, y = gy + b, k = tk(x, y);
              if (occ.has(k) || keepOut.has(k) || nearSign(x, y)) { ok = false; break; } mine.add(k); }
            if (!ok) continue;
            const doors = m.a(gx, gy, it.base, f);
            if (!doors.length || doors.some((k) => { const [p, q] = sides(k); return occ.has(p) || occ.has(q) || nearSign(+k.split(',')[0], +k.split(',')[1]); })) continue;
            // existing roads may run along the building, never through it
            let through = false;
            for (const [a, b] of cells) { const x = gx + a, y = gy + b;
              if ((roads.has(`${x},${y + 1},h`) && mine.has(tk(x, y + 1))) || (roads.has(`${x + 1},${y},v`) && mine.has(tk(x + 1, y)))) { through = true; break; } }
            if (through) continue;
            const mx = gx + fp.w / 2 - 0.5 - cx, my = gy + fp.d / 2 - 0.5 - cy;
            // distance from the centre, slightly stretched and wobbled so the outline isn't a perfect circle
            const ang = Math.atan2(my, mx);
            const wobble = 1 + ORGANIC * (0.6 * Math.sin(3 * ang + 1.3) + 0.4 * Math.sin(5 * ang + 0.4));
            const score = Math.hypot(mx, my) / wobble + ORGANIC * 1.5 * rand(`${it.id}:${gx}:${gy}:${f}`);
            cands.push({ score, gx, gy, f, fp, cells, doors });
          }
        }
      }
      cands.sort((a, b) => a.score - b.score);

      // 2. among the best spots, prefer one close to an existing road
      let best = null;
      for (const c of cands.slice(0, CANDIDATES)) {
        const path = route(c.doors, best ? (best.total - c.score) / ROAD_WEIGHT : Infinity);
        if (path === null) continue;
        const total = c.score + ROAD_WEIGHT * path.filter((k) => !roads.has(k)).length;
        if (!best || total < best.total) best = { ...c, path, total };
      }
      if (!best) throw new Error('no room for ' + it.id);

      // 3. commit
      Object.assign(it, { gx: best.gx, gy: best.gy, facing: best.f });
      for (const [a, b] of best.cells) {
        const x = best.gx + a, y = best.gy + b; occ.set(tk(x, y), it.id);
        for (let dx = -GAP; dx <= GAP; dx++) for (let dy = -GAP; dy <= GAP; dy++) keepOut.add(tk(x + dx, y + dy));
      }
      for (const k of [...best.doors, ...best.path]) addRoad(k);
      bx0 = Math.min(bx0, best.gx); by0 = Math.min(by0, best.gy);
      bx1 = Math.max(bx1, best.gx + best.fp.w); by1 = Math.max(by1, best.gy + best.fp.d);
    }

    if (RING_ROAD) ringRoad();

    // ---------- ring road around the city + connecting the loose ends ----------
    function ringRoad() {
      const doorSet = new Set();
      for (const it of items) for (const k of m.a(it.gx, it.gy, it.base, it.facing)) doorSet.add(k);

      // 1. the area the ring encloses: everything within RING_MARGIN tiles of a building,
      //    rounded off and with holes and notches filled
      const pad = RING_MARGIN + 8;
      const X0 = bx0 - pad, Y0 = by0 - pad, W = bx1 - bx0 + 2 * pad, H = by1 - by0 + 2 * pad;
      const idx = (x, y) => (y - Y0) * W + (x - X0);
      const inGrid = (x, y) => x >= X0 && y >= Y0 && x < X0 + W && y < Y0 + H;
      const dilate = (src, r) => {
        const out = new Uint8Array(W * H), rr = (r + 0.5) ** 2, R = Math.ceil(r);
        for (let y = Y0; y < Y0 + H; y++) for (let x = X0; x < X0 + W; x++) {
          if (!src[idx(x, y)]) continue;
          for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++)
            if (dx * dx + dy * dy <= rr && inGrid(x + dx, y + dy)) out[idx(x + dx, y + dy)] = 1;
        }
        return out;
      };
      const invert = (a) => a.map((v) => 1 - v);
      const core = new Uint8Array(W * H);
      for (const k of occ.keys()) { const [x, y] = k.split(',').map(Number); core[idx(x, y)] = 1; }
      // dilate by margin + 3, then erode by 3 ("closing"): smooths dents in the outline
      let area = invert(dilate(invert(dilate(core, RING_MARGIN + 3)), 3));
      const keep = dilate(core, RING_MARGIN);
      for (let i = 0; i < area.length; i++) area[i] |= keep[i];
      // the welcome-sign zone (+1) is pulled inside if the ring would get close to it
      const zone = [];
      for (let y = Y0; y < Y0 + H; y++) for (let x = X0; x < X0 + W; x++)
        if (nearSign(x, y) || nearSign(x + 1, y) || nearSign(x, y + 1) || nearSign(x + 1, y + 1)) zone.push(idx(x, y));
      if (zone.length) {
        const zoneSet = new Set(zone), near = dilate(area, 2);
        if (zone.some((i) => near[i])) for (let y = Y0; y < Y0 + H; y++) for (let x = X0; x < X0 + W; x++) {
          if ([[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].some(([dx, dy]) => inGrid(x + dx, y + dy) && zoneSet.has(idx(x + dx, y + dy)))) area[idx(x, y)] = 1;
        }
      }
      // fill notches (outside tiles mostly surrounded) and trim spikes, so the ring has few zigzags
      const n4 = (a, x, y) => [[1, 0], [-1, 0], [0, 1], [0, -1]].reduce((s, [dx, dy]) => s + (inGrid(x + dx, y + dy) ? a[idx(x + dx, y + dy)] : 0), 0);
      for (let pass = 0, changed = true; changed && pass < 30; pass++) {
        changed = false;
        for (let y = Y0 + 1; y < Y0 + H - 1; y++) for (let x = X0 + 1; x < X0 + W - 1; x++) {
          const i = idx(x, y), c = n4(area, x, y);
          if (!area[i] && c >= 3) { area[i] = 1; changed = true; }
          else if (area[i] && !keep[i] && c <= 1) { area[i] = 0; changed = true; }
        }
      }
      // fill holes: whatever can't be reached from the edge of the grid is inside
      const outside = new Uint8Array(W * H), stack = [];
      for (let x = X0; x < X0 + W; x++) stack.push([x, Y0], [x, Y0 + H - 1]);
      for (let y = Y0; y < Y0 + H; y++) stack.push([X0, y], [X0 + W - 1, y]);
      while (stack.length) {
        const [x, y] = stack.pop(); if (!inGrid(x, y)) continue;
        const i = idx(x, y); if (outside[i] || area[i]) continue;
        outside[i] = 1; stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
      }
      const inside = (x, y) => inGrid(x, y) && !outside[idx(x, y)];

      // 2. the ring = every grid line between an inside and an outside tile
      for (let y = Y0; y < Y0 + H; y++) for (let x = X0; x < X0 + W; x++) {
        if (!inside(x, y)) continue;
        const edges = [];
        if (!inside(x, y - 1)) edges.push(`${x},${y},h`);
        if (!inside(x, y + 1)) edges.push(`${x},${y + 1},h`);
        if (!inside(x - 1, y)) edges.push(`${x},${y},v`);
        if (!inside(x + 1, y)) edges.push(`${x + 1},${y},v`);
        for (const k of edges) if (edgeOk(k)) addRoad(k);
      }

      // road graph helpers
      const graph = () => {
        const adj = new Map();
        const add = (a, b, k) => { (adj.get(a) || adj.set(a, []).get(a)).push([b, k]); };
        for (const k of roads) { const [x, y, t] = k.split(','); const a = tk(+x, +y), b = t === 'h' ? tk(+x + 1, +y) : tk(+x, +y + 1); add(a, b, k); add(b, a, k); }
        return adj;
      };
      const bounds = [X0, Y0, X0 + W, Y0 + H];
      // Dijkstra over grid points; edgeCost(k) → number, or null when not allowed
      function search(srcs, isTarget, edgeCost, limit) {
        const dist = new Map(), prev = new Map(), h = new Heap();
        for (const s of srcs) { const [x, y] = s.split(',').map(Number); dist.set(`${x},${y},-1`, 0); h.push([0, x, y, -1]); }
        while (h.size) {
          const [c, x, y, d] = h.pop(); const st = `${x},${y},${d}`;
          if (c > dist.get(st) || c > limit) continue;
          if (d !== -1 && isTarget(tk(x, y))) {
            const path = []; let cur = st;
            while (prev.has(cur)) { const [k, p] = prev.get(cur); path.push(k); cur = p; }
            return path;
          }
          for (let nd = 0; nd < 4; nd++) {
            const nx = x + DIRS[nd][0], ny = y + DIRS[nd][1];
            if (nx < bounds[0] || nx > bounds[2] || ny < bounds[1] || ny > bounds[3]) continue;
            const k = edgeKey(x, y, nd); if (!edgeOk(k)) continue;
            const ec = edgeCost(k); if (ec == null) continue;
            const nc = c + ec + (d !== -1 && d !== nd ? TURN_COST : 0), ns = `${nx},${ny},${nd}`;
            if (nc < (dist.get(ns) ?? Infinity)) { dist.set(ns, nc); prev.set(ns, [k, st]); h.push([nc, nx, ny, nd]); }
          }
        }
        return null;
      }

      // 3. loose ends: extend each dead end with new road until it meets the ring or a part of
      //    the network that is far away along the roads (so it makes a real loop, not a U-turn)
      const leaves = () => { const adj = graph(); return [[...adj].filter(([, e]) => e.length === 1).map(([n]) => n).sort(), adj]; };
      const [first] = leaves();
      for (const leaf of first) {
        const adj = graph();
        const e = adj.get(leaf); if (!e || e.length !== 1) continue;      // already fixed by an earlier link
        const [nb, k] = e[0];
        if (doorSet.has(k) && adj.get(nb).length >= 3) continue;         // little stub of a door next to a junction
        const hops = new Map([[leaf, 0]]), q = [leaf];                    // road distance from this dead end
        while (q.length) { const a = q.shift(), hd = hops.get(a); if (hd >= MIN_LOOP) continue;
          for (const [b] of adj.get(a) || []) if (!hops.has(b)) { hops.set(b, hd + 1); q.push(b); } }
        const path = search([leaf], (n) => n !== leaf && nodes.has(n) && !(hops.get(n) < MIN_LOOP),
          (k2) => (roads.has(k2) ? null : 1), CONNECT_MAX);
        if (path) for (const k2 of path) addRoad(k2);
      }

      // 4. make sure everything is one network (the ring may still be separate)
      for (let guard = 0; guard < 20; guard++) {
        const adj = graph(), comp = new Map(); let id = 0;
        for (const n of adj.keys()) {
          if (comp.has(n)) continue;
          const st = [n]; comp.set(n, id);
          while (st.length) for (const [b] of adj.get(st.pop())) if (!comp.has(b)) { comp.set(b, id); st.push(b); }
          id++;
        }
        if (id <= 1) break;
        const size = Array(id).fill(0); for (const c of comp.values()) size[c]++;
        const main = size.indexOf(Math.max(...size));
        const other = [...comp].filter(([, c]) => c !== main).map(([n]) => n);
        const path = search(other, (n) => comp.get(n) === main, (k2) => (roads.has(k2) ? 0.05 : 1), Infinity);
        if (!path) break;
        for (const k2 of path) addRoad(k2);
      }
    }

    const pos = new Map(items.map((it) => [it.id, it]));
    const newProjects = projects.map((p) => {
      const it = pos.get(String(p.id));
      return it ? { ...p, gx: it.gx, gy: it.gy, facing: it.facing } : p;
    });
    return { projects: newProjects, roads: [...roads] };
  }

  // ---------- fetch interception ----------
  const realFetch = window.fetch.bind(window);
  const apiPath = (input) => {
    try { return new URL(typeof input === 'string' ? input : input.url, location.href).pathname; } catch { return ''; }
  };

  window.fetch = async function (input, init) {
    if (!isOn()) return realFetch(input, init);
    const path = apiPath(input);
    const method = ((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase();

    // Block saving positions/roads while showing the generated layout.
    if (/\/api\/(roads$|projects\/[^/]+\/placement$)/.test(path) && method !== 'GET') {
      alert('Automatische indeling staat aan: verplaatsen en wegen bouwen worden niet opgeslagen.\nZet de indeling uit om de stad te bewerken.');
      throw new TypeError('blocked by auto-layout userscript');
    }

    const res = await realFetch(input, init);
    if (path !== '/api/city' || method !== 'GET' || !res.ok) return res;
    try {
      const data = await res.clone().json();
      if (!Array.isArray(data.projects) || !Array.isArray(data.roads)) return res;
      const out = layout(await app(), data.projects);
      const body = JSON.stringify({ ...data, projects: out.projects, roads: out.roads });
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) {
      console.warn('[auto-layout] left the city as is:', e);
      return res;
    }
  };

  // ---------- toolbar button ----------
  const SVG = 'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="g-ico" aria-hidden="true"';
  const ICON_GRID = `<svg ${SVG}><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>`;
  const ICON_HAND = `<svg ${SVG}><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>`;

  function makeButton() {
    const on = isOn();
    const label = on ? 'Eigen indeling tonen' : 'Automatische indeling';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn small';
    btn.id = 'sc-layout-toggle';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = '<b class="s-bg"></b>' + (on ? ICON_HAND : ICON_GRID);
    btn.addEventListener('click', () => { setOn(!on); location.reload(); });
    return btn;
  }
  function ensureButton() {
    if (document.getElementById('sc-layout-toggle')) return;
    const row = document.querySelector('.hz-tr .menu-mini');
    if (row) row.appendChild(makeButton());
  }
  const start = () => {
    ensureButton();
    new MutationObserver(ensureButton).observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
