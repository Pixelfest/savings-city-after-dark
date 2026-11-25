// ==UserScript==
// @name         Savings City – residents
// @namespace    savings-city-tweaks
// @version      1.12
// @description  Simple, static little figures that slowly walk the sidewalks and now and then go into or come out of buildings.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * How it works
 * ------------
 * - The app's renderer is caught through three.js' devtools hook (window.__THREE_DEVTOOLS__),
 *   like the walk-mode script; the scene comes from the first render.
 * - The city data (roads, buildings) is read from the response the app itself reads
 *   (Response.json is watched), so it also follows the auto-layout script.
 * - Roads lie on the lines between tiles: asphalt ±0.16 from the line, sidewalk from 0.16 to
 *   0.25. Residents walk along the road lines with SIDEWALK_OFFSET to their right ("keep right"),
 *   so they're on the sidewalk and people going the other way pass on the other side.
 *   At every junction they pick a random way on (only turning back at a dead end).
 * - Front doors come from the app's own code (exact door position per building). Walking past
 *   a door on that side of the street, a resident sometimes goes in, stays inside for a while,
 *   and later comes out of some (other) door.
 * - Figures are four instanced meshes (trousers, shirt, head, hair): a few hundred people cost
 *   four draw calls. Each resident has their own colour combination.
 *   No animation: they're static shapes that glide.
 */
(function () {
  'use strict';

  // ---- settings -------------------------------------------------------------------------
  const PER_ROAD = 2;             // residents per road tile
  const MAX_PEOPLE = 2000;
  const SPEED = 0.15;             // tiles per second (cars drive about 1–2)
  const SPEED_VARIATION = 0.35;   // ±35 %
  const SIDEWALK_OFFSET = 0.205;  // distance from the road line (middle of the sidewalk)
  const SIDEWALK_HEIGHT = 0.036;  // the app's sidewalks are blocks this high: residents stand on top
  const ASPHALT = 0.16;           // the asphalt reaches this far from the road line
  const LOOK_BEFORE_CROSSING = true;   // calm residents wait at the kerb when a car is coming
  const CROSSING_MARGIN = 0.5;    // seconds of extra room they keep from cars
  const ENTER_CHANCE = 0.25;      // chance to go in when passing a front door on that side
  const INSIDE_SECONDS = [8, 45]; // how long someone stays inside
  const START_INSIDE = 0.2;       // share of people that start inside a building
  const SCALE = 1;                // size of the figures
  // Every resident gets their own combination: shirt, trousers, skin and hair are picked separately.
  const SHIRTS = ['#e25d5d', '#4f8fd8', '#f0a24a', '#7bc77b', '#f2f2f2', '#9b6fd8', '#f6e46f', '#3cb7b0',
                  '#555b66', '#d87bb0', '#2f3a56', '#a8423f', '#6f8f4e', '#c9b38a', '#1f1f24', '#8fb8de'];
  const TROUSERS = ['#2f4a7a', '#3b5d94', '#1f2a44', '#26262b', '#5a5d66', '#8b7d62', '#6b4f3a', '#3e4a3a', '#a9a196'];
  // Realistic skin tones, light to dark. Each has the hair colours that suit it, with weights.
  const SKINS = [
    { c: '#f6dcc6', hair: { '#e6c77a': 3, '#b08a4f': 3, '#6b4a2e': 3, '#a0522d': 1, '#2b1d14': 1, '#c9c6c2': 1 } },
    { c: '#eec4a2', hair: { '#b08a4f': 2, '#6b4a2e': 4, '#3d2a1c': 3, '#e6c77a': 1, '#a0522d': 1, '#c9c6c2': 1 } },
    { c: '#dba97f', hair: { '#3d2a1c': 4, '#2b1d14': 4, '#6b4a2e': 2, '#c9c6c2': 1 } },
    { c: '#c08a5e', hair: { '#2b1d14': 5, '#1a1410': 3, '#3d2a1c': 2, '#c9c6c2': 1 } },
    { c: '#9a6440', hair: { '#1a1410': 6, '#2b1d14': 3, '#c9c6c2': 1 } },
    { c: '#6e4329', hair: { '#1a1410': 7, '#2b1d14': 2, '#c9c6c2': 1 } },
    { c: '#4b2c1c', hair: { '#1a1410': 8, '#c9c6c2': 1 } },
  ];
  const BALD = 0.07;              // share of residents without hair
  const FALL_SECONDS = 0.45;      // how long falling over takes when shot (walk mode)
  const PANIC_SPEED = 5;          // running away: this many times faster than walking
  const PANIC_ENTER_CHANCE = 0.7; // while running away, chance to dive into a building passing its door
  const CAR_COLLISIONS = true;    // a moving car that touches a resident knocks them over
  const BLOOD = true;             // blood spatters when someone is knocked down, and a pool grows under them
  const BLOOD_DROPS = 22;         // drops per person knocked down
  const BLOOD_SPEED = 0.7;        // how hard the drops fly (tiles per second)
  const BLOOD_POOL_SIZE = 0.065;  // final radius of the pool (a person is 0.135 tall)
  const BLOOD_POOL_SECONDS = 10;  // how long the pool keeps growing
  const MAX_BLOOD_DROPS = 5000;   // drops + stains on the ground; the oldest stains disappear after this
  const ASPHALT_HEIGHT = 0.04;    // top of the road surface
  const HEADSHOTS = true;         // shot in the head (walk mode): the head pops off and flies on its own
  const HEAD_SPEED = 0.8;         // how hard a head is knocked away (tiles per second; 1 tile ≈ 20 m)
  const NECK_SQUIRT_SECONDS = 3.5;// blood keeps squirting from the neck in pulses this long
  const MAX_LOOSE_HEADS = 300;    // the oldest loose heads disappear after this many
  const SCREAMS = true;           // people in a panic scream (synthesised, no sound files)
  const SCREAM_CHANCE = 0.45;     // chance someone screams when they start to panic…
  const SCREAM_REPEAT = 0.12;     // …and per second while they keep running
  const MAX_SCREAMS = 6;          // at most this many at the same time
  const SCREAM_VOLUME = 0.45;
  const SCREAM_HEARING = 9;       // walk mode: tiles; further away you don't hear them
  const CRUSH_MARGIN = 0.3;       // a building coming down kills people outside this close to its walls
  // ---------------------------------------------------------------------------------------

  // ---------- catch the renderer + scene ----------
  let scene = null, built = false;
  const hook = window.__THREE_DEVTOOLS__ || (window.__THREE_DEVTOOLS__ = new EventTarget());
  hook.addEventListener('observe', (e) => {
    const r = e.detail;
    if (!r || !r.isWebGLRenderer || r.__scResidents) return;
    r.__scResidents = true;
    const orig = r.render;
    r.render = function (s, c) {
      if (!scene && s && s.isScene && c && c.isOrthographicCamera) scene = s;
      return orig.apply(this, arguments);
    };
  });

  // ---------- city data (what the app reads) ----------
  let city = null, cityVersion = 0;
  const origJson = Response.prototype.json;
  Response.prototype.json = async function () {
    const d = await origJson.call(this);
    try { if (d && Array.isArray(d.projects) && Array.isArray(d.roads)) { city = d; cityVersion++; app().catch(() => {}); } } catch {}
    return d;
  };

  let appModule = null;
  async function app() {
    if (appModule) return appModule;
    const s = [...document.querySelectorAll('script[type="module"][src]')].find((s) => /\/index-[^/]*\.js/.test(s.src));
    if (!s) throw new Error('main module not found');
    const m = findHelpers(await import(s.src));
    if (typeof m.v !== 'function' || typeof m.a !== 'function') throw new Error('app internals changed');
    return (appModule = m);
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

  // ---------- road network ----------
  const tk = (x, y) => x + ',' + y;
  const NORMALS = [[0, -1], [1, 0], [0, 1], [-1, 0]];   // door facing 0=N 1=E 2=S 3=W → outward
  let net = null;   // { adj: Map(node → [node]), nodes: [[x,y]], edges: [[a,b,key]], doors: Map(edgeKey → n), doorList }

  function buildNetwork() {
    const adj = new Map(), edges = [], xy = new Map();
    const add = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
    for (const k of city.roads) {
      const [x, y, t] = String(k).split(','); const X = +x, Y = +y;
      if (!Number.isFinite(X) || !Number.isFinite(Y)) continue;
      const a = tk(X, Y), b = t === 'h' ? tk(X + 1, Y) : tk(X, Y + 1);
      xy.set(a, [X, Y]); xy.set(b, t === 'h' ? [X + 1, Y] : [X, Y + 1]);
      add(a, b); add(b, a); edges.push([a, b, k]);
    }
    const roadSet = new Set(city.roads.map(String));
    const doors = new Map(), doorList = [];
    if (appModule) {
      try {
        for (const b of appModule.v(city.projects)) {
          const n = NORMALS[b.facing]; if (!n) continue;
          for (const k of appModule.a(b.gx, b.gy, b.fp.base ?? b.fp, b.facing)) {
            if (!roadSet.has(k)) continue;
            doors.set(k, n); doorList.push(k);
          }
        }
      } catch (e) { console.warn('[residents] no doors:', e); }
    }
    // road segments per tile, to tell quickly whether a point is on the asphalt
    const cells = new Map();
    for (const [a, b] of edges) {
      const [ax, ay] = xy.get(a), [bx, by] = xy.get(b);
      for (let x = Math.min(ax, bx) - 1; x <= Math.max(ax, bx); x++) for (let y = Math.min(ay, by) - 1; y <= Math.max(ay, by); y++) {
        const k = tk(x, y); (cells.get(k) || cells.set(k, []).get(k)).push([ax, ay, bx, by]);
      }
    }
    net = { adj, xy, edges, doors, doorList, cells };
  }

  const edgeKeyOf = (a, b) => {   // road key for the segment between two neighbouring nodes
    const [ax, ay] = net.xy.get(a), [bx, by] = net.xy.get(b);
    return ay === by ? `${Math.min(ax, bx)},${ay},h` : `${ax},${Math.min(ay, by)},v`;
  };
  // right-hand normal of walking direction (dx, dz)
  const rightOf = (dx, dz) => [-dz, dx];

  // ---------- people ----------
  let people = [];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function placeOnEdge(p, a, b, s) {
    p.a = a; p.b = b; p.s = s;
    const [ax, ay] = net.xy.get(a), [bx, by] = net.xy.get(b);
    p.dir = [bx - ax, by - ay];
    p.side = p.side || 1;                                        // 1 = keep right, −1 = keep left (when fleeing back)
    p.prevOff = sideOffset(p);
  }
  // which side of the road line someone walks on, as a direction
  const sideOffset = (p) => { const r = rightOf(p.dir[0], p.dir[1]); return [r[0] * p.side, r[1] * p.side]; };

  // Run away from (x, z): turn round if heading towards it; faster and away at junctions for a while.
  function panic(p, x, z, seconds) {
    if (!(p.panic > 0) && p.state !== 'inside' && Math.random() < SCREAM_CHANCE) scream(p, rnd(0, 0.5));
    p.panic = seconds * (0.8 + Math.random() * 0.4);
    p.fleeFrom = [x, z];
    if (p.state !== 'walk') return;
    if (p.dir[0] * (x - p.x) + p.dir[1] * (z - p.z) > 0) {
      // turn round on the spot: same sidewalk, other direction
      const off = sideOffset(p);
      p.side = -p.side;
      placeOnEdge(p, p.b, p.a, 1 - p.s);
      p.prevOff = off;
    }
  }

  function spawn() {
    people = [];
    drops.length = 0;
    loose.length = 0; for (const set of looseSets) { set.list.length = 0; set.ring = 0; }
    if (!net.edges.length) return;
    const count = Math.min(MAX_PEOPLE, Math.round(net.edges.length * PER_ROAD));
    for (let i = 0; i < count; i++) {
      const p = { speed: SPEED * (1 + rnd(-SPEED_VARIATION, SPEED_VARIATION)), state: 'walk', x: 0, z: 0, h: 0 };
      const [a, b] = pick(net.edges);
      const s0 = rnd(0.25, 0.75);                                // start on the sidewalk, not in a junction
      if (Math.random() < 0.5) placeOnEdge(p, a, b, s0); else placeOnEdge(p, b, a, s0);
      if (net.doorList.length && Math.random() < START_INSIDE) {
        p.state = 'inside'; p.timer = rnd(0, INSIDE_SECONDS[1]);
        const k = pick(net.doorList), n = net.doors.get(k), mid = midOf(k);
        p.insideAt = [mid[0] - n[0] * 0.35, mid[1] - n[1] * 0.35];
      }
      people.push(p);
    }
  }

  // Walk into the building of door edge k (building is on the −n side).
  function startEnter(p, k) {
    const n = net.doors.get(k);
    const mid = midOf(k);
    p.state = 'enter';
    p.from = [p.x, p.z];
    p.to = [mid[0] - n[0] * 0.35, mid[1] - n[1] * 0.35];
    p.insideAt = p.to;                                           // where they are while inside (for collapses)
    p.t = 0; p.dur = Math.hypot(p.to[0] - p.x, p.to[1] - p.z) / p.speed;
    p.h = Math.atan2(p.to[0] - p.x, p.to[1] - p.z);
  }

  // Come out of a random door, onto the sidewalk on the building's side, then walk on.
  function startExit(p) {
    const k = pick(net.doorList), n = net.doors.get(k), mid = midOf(k);
    const [x, y, t] = k.split(',').map((v, i) => (i < 2 ? +v : v));
    let a = tk(x, y), b = t === 'h' ? tk(x + 1, y) : tk(x, y + 1);
    // walk the direction that keeps the building on our right
    const [ax, ay] = net.xy.get(a), [bx, by] = net.xy.get(b);
    const r = rightOf(bx - ax, by - ay);
    if (r[0] * -n[0] + r[1] * -n[1] < 0) [a, b] = [b, a];
    p.state = 'exit';
    p.insideAt = null;
    p.side = 1;
    p.panic = 0;                                                 // comes out calm
    p.from = [mid[0] - n[0] * 0.35, mid[1] - n[1] * 0.35];
    p.to = [mid[0] - n[0] * SIDEWALK_OFFSET, mid[1] - n[1] * SIDEWALK_OFFSET];
    p.t = 0; p.dur = Math.hypot(p.to[0] - p.from[0], p.to[1] - p.from[1]) / p.speed;
    p.h = Math.atan2(n[0], n[1]);
    p.next = [a, b];
  }

  function midOf(k) {
    const [x, y, t] = k.split(',');
    return t === 'h' ? [+x + 0.5, +y] : [+x, +y + 0.5];
  }

  function step(p, dt) {
    if (p.state === 'gone') return;
    if (p.state === 'down') { p.fall = Math.min(1, p.fall + dt / FALL_SECONDS); return; }   // lies still
    if (p.panic > 0) p.panic -= dt;                              // calms down, indoors too
    if (p.state === 'inside') {
      p.timer -= dt;
      if (p.timer <= 0 && net.doorList.length) startExit(p);
      return;
    }
    if (p.state === 'enter' || p.state === 'exit') {
      p.t += dt;
      const f = Math.min(1, p.t / Math.max(0.01, p.dur));
      p.x = p.from[0] + (p.to[0] - p.from[0]) * f;
      p.z = p.from[1] + (p.to[1] - p.from[1]) * f;
      if (f >= 1) {
        if (p.state === 'enter') { p.state = 'inside'; p.timer = rnd(...INSIDE_SECONDS); }
        else { p.state = 'walk'; placeOnEdge(p, p.next[0], p.next[1], p.nextS ?? 0.5); p.nextS = undefined; }
      }
      return;
    }
    // walking along a road line
    const before = p.s;
    const panicking = p.panic > 0;
    if (panicking && Math.random() < SCREAM_REPEAT * dt) scream(p, 0);
    // about to step onto the road? look left and right first (people in a panic don't)
    if (!panicking && LOOK_BEFORE_CROSSING && trafficCars && mustWait(p, p.speed * dt)) { p.waiting = (p.waiting || 0) + dt; place(p); return; }
    p.waiting = 0;
    p.s += p.speed * (panicking ? PANIC_SPEED : 1) * dt;
    // passing the middle of a door on our side: maybe go in
    if (before < 0.5 && p.s >= 0.5 && net.doorList.length) {
      const k = edgeKeyOf(p.a, p.b), n = net.doors.get(k);
      const r = sideOffset(p);   // the side of the street we're on; panicking people like to hide indoors
      if (n && r[0] * -n[0] + r[1] * -n[1] > 0 && Math.random() < (panicking ? PANIC_ENTER_CHANCE : ENTER_CHANCE)) { place(p); startEnter(p, k); return; }
    }
    while (p.s >= 1) {
      const options = (net.adj.get(p.b) || []).filter((c) => c !== p.a);
      let nextNode;
      if (!options.length) nextNode = p.a;                       // dead end: turn around
      else if (!panicking) nextNode = plannedNext(p);            // the way they already looked at
      else if (panicking) {
        // fleeing: the way that leads furthest from the danger (now and then the second best)
        const far = (n) => { const [x, y] = net.xy.get(n); return Math.hypot(x - p.fleeFrom[0], y - p.fleeFrom[1]); };
        const sorted = options.slice().sort((u, v) => far(v) - far(u));
        nextNode = sorted.length > 1 && Math.random() < 0.2 ? sorted[1] : sorted[0];
      } else nextNode = pick(options);
      const off = sideOffset(p);
      if (!panicking) p.side = 1;                                // calmed down: back to keeping right
      placeOnEdge(p, p.b, nextNode, p.s - 1);
      p.prevOff = off;                                           // blend the side-offset round the corner
    }
    place(p);
  }

  // ---------- looking before crossing ----------
  function onAsphalt(x, z) {
    const list = net.cells.get(tk(Math.floor(x), Math.floor(z)));
    if (!list) return false;
    for (const [ax, ay, bx, by] of list) {
      const cx = Math.max(Math.min(ax, bx), Math.min(Math.max(ax, bx), x)), cz = Math.max(Math.min(ay, by), Math.min(Math.max(ay, by), z));
      if (Math.hypot(x - cx, z - cz) < ASPHALT + 0.015) return true;
    }
    return false;
  }

  // The next road at the coming junction, chosen in advance so we can look where we'll walk.
  function plannedNext(p) {
    const key = p.a + '>' + p.b;
    if (p.planFor !== key) {
      const options = (net.adj.get(p.b) || []).filter((c) => c !== p.a);
      p.plan = options.length ? pick(options) : p.a;
      p.planFor = key;
    }
    return p.plan;
  }

  // Where this person will be after walking `dist` further (same rules as place()).
  function positionAhead(p, dist) {
    let a = p.a, dir = p.dir, s = p.s + dist, prev = p.prevOff, side = p.side;
    if (s >= 1) {
      const nxt = plannedNext(p), r = rightOf(dir[0], dir[1]);
      prev = [r[0] * side, r[1] * side]; side = 1;
      const [bx, by] = net.xy.get(p.b), [nx, ny] = net.xy.get(nxt);
      a = p.b; dir = [nx - bx, ny - by]; s = Math.min(s - 1, 0.999);
    }
    const [ax, ay] = net.xy.get(a), r = rightOf(dir[0], dir[1]);
    const w = Math.min(1, s / 0.3), ox = prev[0] + (r[0] * side - prev[0]) * w, oz = prev[1] + (r[1] * side - prev[1]) * w, ol = Math.hypot(ox, oz) || 1;
    return [ax + dir[0] * s + (ox / ol) * SIDEWALK_OFFSET, ay + dir[1] * s + (oz / ol) * SIDEWALK_OFFSET];
  }

  // Standing on the sidewalk with the next step on the asphalt: wait if a moving car would come
  // near any point of the crossing while we're there (with CROSSING_MARGIN to spare).
  function mustWait(p, stepLen) {
    if (onAsphalt(p.x, p.z)) return false;                     // already crossing: keep going
    const first = positionAhead(p, Math.max(stepLen, 0.01) + 0.01);
    if (!onAsphalt(first[0], first[1])) return false;          // not about to cross
    const path = [];
    for (let d = 0.02; d < 1.2; d += 0.04) {
      const q = positionAhead(p, d), on = onAsphalt(q[0], q[1]);
      if (on) path.push([q[0], q[1], d / p.speed]);
      else if (path.length) { path.push([q[0], q[1], d / p.speed]); break; }   // back on the kerb
    }
    for (const c of trafficCars) {
      if (!(c.speed > 0.08) || !Number.isFinite(c.x)) continue;
      if (Math.hypot(c.x - path[0][0], c.z - path[0][1]) > 8) continue;
      const fx = Math.cos(c.heading), fz = Math.sin(c.heading);
      for (const [x, z, t] of path) {
        // does the car's line pass this point, and when is it there?
        const along = (x - c.x) * fx + (z - c.z) * fz, side = Math.abs(-(x - c.x) * fz + (z - c.z) * fx);
        if (side > 0.16 || along < -0.2) continue;                // not in its way, or already past
        const when = along / c.speed, busy = 0.2 / c.speed;      // the car covers the point for ±busy seconds
        if (Math.abs(when - t) < busy + CROSSING_MARGIN) return true;
      }
    }
    return false;
  }

  function place(p) {
    const [ax, ay] = net.xy.get(p.a);
    const r = sideOffset(p);
    const w = Math.min(1, p.s / 0.3);                            // smooth shift to the new side after a turn
    const ox = p.prevOff[0] + (r[0] - p.prevOff[0]) * w, oz = p.prevOff[1] + (r[1] - p.prevOff[1]) * w;
    const ol = Math.hypot(ox, oz) || 1;
    p.x = ax + p.dir[0] * p.s + (ox / ol) * SIDEWALK_OFFSET;
    p.z = ay + p.dir[1] * p.s + (oz / ol) * SIDEWALK_OFFSET;
    p.h = Math.atan2(p.dir[0], p.dir[1]);
  }

  // ---------- traffic: cars can run people over ----------
  // The app moves its cars every frame with traffic.cars.forEach(...): that call reveals the list
  // of car objects (x, z, heading, speed …). Same trick as the walk-mode script, done here too so
  // this works without it.
  let trafficCars = null;
  const origForEach = Array.prototype.forEach;
  Array.prototype.forEach = function () {
    if (this !== trafficCars && this.length) {
      const c = this[0];
      if (c && typeof c === 'object' && typeof c.base === 'number' && typeof c.heading === 'number' && 'from' in c && 'to' in c) trafficCars = this;
    }
    return origForEach.apply(this, arguments);
  };

  // Moving cars, grouped per tile so each person only checks the cars close by.
  function movingCars() {
    if (!trafficCars) return null;
    const map = new Map();
    for (const c of trafficCars) {
      if (!(c.speed > 0.08) || !Number.isFinite(c.x)) continue;
      const k = tk(Math.floor(c.x), Math.floor(c.z));
      (map.get(k) || map.set(k, []).get(k)).push(c);
    }
    return map;
  }

  // Is this person inside a car's box (in the car's own coordinates)? Then they're knocked over in
  // the car's driving direction.
  function hitByCar(i, p, byTile) {
    const tx = Math.floor(p.x), tz = Math.floor(p.z), R = 0.02 * SCALE;
    for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
      const list = byTile.get(tk(tx + ox, tz + oz)); if (!list) continue;
      for (const c of list) {
        const fx = Math.cos(c.heading), fz = Math.sin(c.heading);   // car forward (the app turns cars by −heading)
        const dx = p.x - c.x, dz = p.z - c.z;
        const lx = dx * fx + dz * fz, lz = -dx * fz + dz * fx;
        // calm people don't walk in front of cars; only panicking people, or a car that suddenly
        // speeds up (fleeing, police with siren), can still hit someone
        const faster = (c.boost || 1) > 1.01 || c.speed > c.base * 1.15;
        if (!(p.panic > 0) && !faster) continue;
        if (Math.abs(lx) < 0.115 + R && Math.abs(lz) < 0.0575 + R) {
          window.scResidents.knockDown(i, { x: fx, y: 0, z: fz }, 'car');
          return;
        }
      }
    }
  }

  // ---------- 3D figures ----------
  let legs = null, torsos = null, heads = null, hairs = null, parts = [], bald = null, M = null, V = null, group = null;

  // ---------- blood ----------
  // Knocked down → a spray of drops (mostly away from the shot, some back towards it) that fall
  // with gravity and become flat stains where they land, and a pool that slowly spreads under the
  // upper body. Drops and stains share one ring buffer of MAX_BLOOD_DROPS.
  // body sizes (before SCALE): legs, torso, head; the head starts just above the neck
  const LEG = 0.048, TORSO = 0.055, HEAD = 0.022, HEAD_Y = LEG + TORSO + 0.002;
  let pools = null, dropMesh = null, dropHead = 0;
  const drops = [];
  const GRAVITY = 3;   // tiles/s²: the figures are miniatures, so a snappy fall reads better than real g

  function groundAt(x, z) { return onAsphalt(x, z) ? ASPHALT_HEIGHT : SIDEWALK_HEIGHT; }

  function addDrop(x, y, z, vx, vy, vz, size) {
    const d = { x, y, z, vx, vy, vz, size, landed: false, rot: rnd(0, Math.PI) };
    if (drops.length < MAX_BLOOD_DROPS) drops.push(d); else { drops[dropHead] = d; dropHead = (dropHead + 1) % MAX_BLOOD_DROPS; }
  }

  function bleed(p, dx, dy, dz) {
    const y0 = SIDEWALK_HEIGHT + 0.08 * SCALE;                      // chest height
    for (let k = 0; k < BLOOD_DROPS; k++) {
      const back = Math.random() < 0.25 ? -0.5 : 1;                 // a quarter sprays back towards the shooter
      const sp = BLOOD_SPEED * rnd(0.25, 1) * back;
      const d = { x: p.x + rnd(-0.008, 0.008), y: y0 + rnd(-0.015, 0.015), z: p.z + rnd(-0.008, 0.008),
        vx: dx * sp + rnd(-0.25, 0.25) * BLOOD_SPEED, vy: Math.max(0, dy) * sp + rnd(0.05, 0.6) * BLOOD_SPEED,
        vz: dz * sp + rnd(-0.25, 0.25) * BLOOD_SPEED, size: rnd(0.0025, 0.0055) * SCALE, landed: false, rot: rnd(0, Math.PI) };
      if (drops.length < MAX_BLOOD_DROPS) drops.push(d); else { drops[dropHead] = d; dropHead = (dropHead + 1) % MAX_BLOOD_DROPS; }
    }
    // the pool: under the chest/head, which lands about 0.07 away from the feet in the fall direction
    p.blood = { t: -rnd(0.4, 1.2), x: p.x + dx * 0.07 * SCALE, z: p.z + dz * 0.07 * SCALE,
      a: rnd(0, Math.PI * 2), sx: rnd(0.8, 1.25), sz: rnd(0.8, 1.25), size: BLOOD_POOL_SIZE * SCALE * rnd(0.75, 1.2) };
    p.blood.y = groundAt(p.blood.x, p.blood.z) + 0.0008;
  }

  function stepBlood(dt, n, m) {
    if (!pools) return;
    const hidden = new M().makeScale(0, 0, 0);
    for (let i = 0; i < n; i++) {
      const b = people[i].blood;
      if (!b || (people[i].state !== 'down' && people[i].state !== 'gone')) { pools.setMatrixAt(i, hidden); continue; }
      b.t += dt;
      const g = b.t <= 0 ? 0 : 1 - Math.pow(1 - Math.min(1, b.t / BLOOD_POOL_SECONDS), 2.2);   // fast at first, then slower
      const r = b.size * Math.max(0.001, g);
      m.makeRotationY(b.a);
      m.scale(new V(r * b.sx, 1, r * b.sz));
      m.setPosition(b.x, b.y, b.z);
      pools.setMatrixAt(i, m);
    }
    pools.count = n; pools.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      if (!d.landed) {
        d.vy -= GRAVITY * dt;
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        const gy = groundAt(d.x, d.z);
        if (d.y <= gy + 0.0006) { d.landed = true; d.y = gy + 0.0006 + (i % 7) * 0.00005; }   // tiny offsets: no flicker between stains
        m.makeRotationY(d.rot);
        m.scale(new V(d.size, d.size, d.size * (1 + Math.min(2, Math.hypot(d.vx, d.vy, d.vz) * 2))));   // stretched while flying
        if (!d.landed) m.premultiply(new M().makeRotationY(Math.atan2(d.vx, d.vz) - d.rot));
      }
      if (d.landed) {
        if (!d.flat) { d.flat = true; d.mat = new M().makeRotationY(d.rot).scale(new V(d.size * 1.8, 0.0004, d.size * rnd(1.8, 3.2))).setPosition(d.x, d.y, d.z); }
        dropMesh.setMatrixAt(i, d.mat);
      } else { m.setPosition(d.x, d.y, d.z); dropMesh.setMatrixAt(i, m); }
    }
    dropMesh.count = drops.length; dropMesh.instanceMatrix.needsUpdate = true;
  }

  // ---------- headshots ----------
  // The resident's own head (and hair) is hidden; a copy in their colours flies off with physics:
  // knocked along the shot and up, tumbling, bouncing and rolling to a stop on one of its faces.
  // From the neck of the falling body blood squirts in heartbeat pulses for a few seconds.
  let looseHeads = null, looseHair = null, looseLegs = null, looseTorsos = null;
  const loose = [];
  function behead(i, d) {
    const p = people[i];
    if (!p || p.state === 'down' || p.state === 'gone' || !V || !looseHeads) return false;
    const l = Math.hypot(d.x, d.z) || 1, dx = d.x / l, dz = d.z / l;
    const neckY = SIDEWALK_HEIGHT + (HEAD_Y + HEAD / 2) * SCALE;
    const h = { x: p.x, y: neckY, z: p.z, vx: dx * HEAD_SPEED * rnd(0.6, 1.2) + rnd(-0.2, 0.2), vy: HEAD_SPEED * rnd(0.4, 0.9) + Math.max(0, d.y || 0),
      vz: dz * HEAD_SPEED * rnd(0.6, 1.2) + rnd(-0.2, 0.2), rx: 0, ry: p.h, rz: 0, wx: rnd(-25, 25), wy: rnd(-10, 10), wz: rnd(-25, 25),
      rest: false, trail: 0.8, person: i, bald: bald[i] };
    heads.getColorAt(i, tmpC); const skin = tmpC.clone(); hairs.getColorAt(i, tmpC);
    addLoose(looseSets[0], h, skin, tmpC.clone());
    window.scResidents.knockDown(i, d);
    p.headless = true; p.squirt = BLOOD ? NECK_SQUIRT_SECONDS : 0;
    if (BLOOD) {   // a burst where the head was
      for (let k = 0; k < 18; k++) addDrop(p.x, neckY, p.z, dx * rnd(0, 1) * BLOOD_SPEED + rnd(-0.3, 0.3) * BLOOD_SPEED, rnd(0.1, 0.8) * BLOOD_SPEED, dz * rnd(0, 1) * BLOOD_SPEED + rnd(-0.3, 0.3) * BLOOD_SPEED, rnd(0.002, 0.005) * SCALE);
      if (p.blood) p.blood.size *= 1.4;                            // more blood: a bigger pool
    }
    return true;
  }
  let tmpC = null;

  // heartbeat squirts from the neck of a body, along the body's axis (m = the body's matrix)
  function squirt(p, m, dt, t) {
    p.squirt -= dt;
    const e = m.elements, k = HEAD_Y * SCALE;
    const nx = e[4] * k + e[12], ny = e[5] * k + e[13], nz = e[6] * k + e[14];
    const left = p.squirt / NECK_SQUIRT_SECONDS, beat = Math.max(0, Math.sin(t * 0.0001 * 2 * Math.PI * 25 + (p.x * 7)));   // ~2.5 beats per second
    const rate = 150 * left * (0.15 + beat * beat);
    p.squirtAcc = (p.squirtAcc || 0) + rate * dt;
    while (p.squirtAcc >= 1) {
      p.squirtAcc -= 1;
      const sp = BLOOD_SPEED * (0.35 + 0.9 * beat) * (0.4 + 0.6 * left) * rnd(0.7, 1.1);
      addDrop(nx, ny, nz, e[4] * sp + rnd(-0.08, 0.08), e[5] * sp + rnd(-0.08, 0.08) + 0.15, e[6] * sp + rnd(-0.08, 0.08), rnd(0.0018, 0.004) * SCALE);
    }
  }

  // loose parts (heads, and legs and torsos of residents blown apart): fall, tumble, bounce, roll
  // to a stop on one of their faces. set = { list, a: mesh, b: second mesh (hair) or null, half: [x, y, z] }
  const looseSets = [];
  function stepHeads(dt) {
    if (!looseHeads) return;
    for (const set of looseSets) stepLooseSet(set, dt);
  }
  function stepLooseSet(set, dt) {
    const m = new M(), q = new M(), [hx, hy, hz] = set.half, hidden = new M().makeScale(0, 0, 0);
    for (const h of set.list) {
      if (!h.rest && dt > 0) {
        h.vy -= GRAVITY * dt;
        h.x += h.vx * dt; h.y += h.vy * dt; h.z += h.vz * dt;
        h.rx += h.wx * dt; h.ry += h.wy * dt; h.rz += h.wz * dt;
        // lowest corner of the turned box
        q.makeRotationFromEuler(eul.set(h.rx, h.ry, h.rz));
        const e = q.elements, low = hx * Math.abs(e[1]) + hy * Math.abs(e[5]) + hz * Math.abs(e[9]);
        const g = groundAt(h.x, h.z);
        if (h.y - low < g) {
          h.y = g + low;
          if (h.vy < -0.15) { h.vy = -h.vy * 0.35; h.vx *= 0.55; h.vz *= 0.55; h.wx *= 0.6; h.wz *= 0.6; h.wy *= 0.6; }   // bounce
          else {                                                    // rolling: settle onto a face
            h.vy = 0;
            const f = Math.exp(-14 * dt); h.vx *= f; h.vz *= f; h.wx *= f; h.wy *= f; h.wz *= f;
            const snap = (a) => { const t = Math.round(a / (Math.PI / 2)) * (Math.PI / 2); return a + (t - a) * Math.min(1, dt * 8); };
            h.rx = snap(h.rx); h.rz = snap(h.rz);
            if (Math.hypot(h.vx, h.vz) < 0.01 && Math.abs(h.wx) + Math.abs(h.wz) < 0.3) {
              h.rx = Math.round(h.rx / (Math.PI / 2)) * (Math.PI / 2); h.rz = Math.round(h.rz / (Math.PI / 2)) * (Math.PI / 2);
              q.makeRotationFromEuler(eul.set(h.rx, h.ry, h.rz));
              const f2 = q.elements; h.y = g + hx * Math.abs(f2[1]) + hy * Math.abs(f2[5]) + hz * Math.abs(f2[9]); h.rest = true;
            }
          }
        }
        if (BLOOD && h.trail > 0) {                                 // a few drops trail behind it
          h.trail -= dt;
          if (Math.random() < dt * 30) addDrop(h.x, h.y - hy, h.z, h.vx * 0.3, h.vy * 0.3, h.vz * 0.3, rnd(0.0015, 0.003) * SCALE);
        }
      }
      m.makeRotationFromEuler(eul.set(h.rx, h.ry, h.rz)).setPosition(h.x, h.y, h.z);
      set.a.setMatrixAt(h.slot, m);
      if (set.b) set.b.setMatrixAt(h.slot, h.bald ? hidden : m);
    }
    for (const mesh of set.b ? [set.a, set.b] : [set.a]) { mesh.count = set.list.length; mesh.instanceMatrix.needsUpdate = true; }
  }
  // a new loose part in a set; colours [a, b]
  function addLoose(set, h, colA, colB) {
    const slot = set.list.length < MAX_LOOSE_HEADS ? set.list.length : (set.ring = ((set.ring || 0) + 1) % MAX_LOOSE_HEADS);
    set.list[slot] = h; h.slot = slot;
    set.a.setColorAt(slot, colA); set.a.instanceColor.needsUpdate = true;
    if (set.b && colB) { set.b.setColorAt(slot, colB); set.b.instanceColor.needsUpdate = true; }
  }

  // Blown apart (rocket): the resident is gone; legs, torso and head (with hair) fly off on their
  // own, away from the blast at (x, z), with a lot of blood. power ≈ how hard (tiles per second).
  function gib(i, x, z, power = 1.2) {
    const p = people[i];
    if (!p || p.state === 'inside' || p.state === 'gone' || !looseHeads || !looseLegs) return false;
    const dx0 = p.x - x, dz0 = p.z - z, l = Math.hypot(dx0, dz0) || 1, dx = dx0 / l, dz = dz0 / l;
    const base = SIDEWALK_HEIGHT;
    if (p.state !== 'down') died(p, 'blast');                      // (a body blown apart again doesn't count twice)
    const kick = (y) => ({ x: p.x + rnd(-0.01, 0.01), y, z: p.z + rnd(-0.01, 0.01), vx: dx * power * rnd(0.4, 1.1) + rnd(-0.4, 0.4), vy: power * rnd(0.4, 1.0),
      vz: dz * power * rnd(0.4, 1.1) + rnd(-0.4, 0.4), rx: 0, ry: p.h, rz: 0, wx: rnd(-30, 30), wy: rnd(-15, 15), wz: rnd(-30, 30), rest: false, trail: 1.2 });
    const c1 = new tmpC.constructor(), c2 = new tmpC.constructor();
    legs.getColorAt(i, c1); addLoose(looseSets[1], kick(base + (LEG / 2) * SCALE), c1.clone());
    torsos.getColorAt(i, c1); addLoose(looseSets[2], kick(base + (LEG + TORSO / 2) * SCALE), c1.clone());
    if (!p.headless) {
      heads.getColorAt(i, c1); hairs.getColorAt(i, c2);
      const h = kick(base + (HEAD_Y + HEAD / 2) * SCALE); h.bald = bald[i];
      addLoose(looseSets[0], h, c1.clone(), c2.clone());
    }
    p.state = 'gone'; p.squirt = 0;
    if (BLOOD) {
      const y0 = base + 0.06 * SCALE;
      for (let k = 0; k < 60; k++) addDrop(p.x, y0, p.z, dx * rnd(-0.3, 1) * BLOOD_SPEED * 1.5 + rnd(-0.6, 0.6) * BLOOD_SPEED, rnd(0.1, 1.2) * BLOOD_SPEED, dz * rnd(-0.3, 1) * BLOOD_SPEED * 1.5 + rnd(-0.6, 0.6) * BLOOD_SPEED, rnd(0.002, 0.006) * SCALE);
      p.blood = { t: -0.2, x: p.x, z: p.z, a: rnd(0, Math.PI * 2), sx: rnd(0.8, 1.25), sz: rnd(0.8, 1.25), size: BLOOD_POOL_SIZE * SCALE * 1.3, y: groundAt(p.x, p.z) + 0.0008 };
    }
    return true;
  }
  let eul = null;

  function findBase(proto, name) {
    while (proto && !Object.prototype.hasOwnProperty.call(proto, name)) proto = Object.getPrototypeOf(proto);
    return proto && proto.constructor;
  }

  // Box (min corner x0,y0,z0, size w,h,d) as plain triangles, with one vertex colour.
  function box(pos, nor, col, x0, y0, z0, w, h, d, c) {
    const x1 = x0 + w, y1 = y0 + h, z1 = z0 + d;
    const quad = (a, b, cc, dd, n) => { for (const v of [a, b, cc, a, cc, dd]) { pos.push(...v); nor.push(...n); col.push(...c); } };
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]);
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]);
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]);
    quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0]);
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
  }

  function buildMeshes() {
    // Borrow three.js classes from objects already in the scene (no second copy of three.js).
    let inst = null, lambert = null, anyGeo = null, color = null;
    scene.traverse((o) => {
      if (o.isInstancedMesh && !inst) inst = o;
      if (o.isMesh && o.geometry && !anyGeo) anyGeo = o.geometry;
      const m = o.material;
      if (m && !Array.isArray(m) && m.isMeshLambertMaterial && !lambert) lambert = m;
      if (m && !Array.isArray(m) && m.color && m.color.isColor && !color) color = m.color;
    });
    if (!inst || !lambert || !anyGeo || !color) return false;
    const InstancedMesh = inst.constructor;
    const Geometry = findBase(Object.getPrototypeOf(anyGeo), 'translate');
    const Attr = anyGeo.attributes.position.constructor;
    const Material = lambert.constructor, Color = color.constructor;
    M = inst.matrix.constructor;
    V = inst.position.constructor;

    const geo = (build) => {
      const pos = [], nor = [], col = []; build(pos, nor, col);
      const g = new Geometry();
      g.setAttribute('position', new Attr(new Float32Array(pos), 3));
      g.setAttribute('normal', new Attr(new Float32Array(nor), 3));
      g.setAttribute('color', new Attr(new Float32Array(col), 3));
      return g;
    };
    const s = SCALE, W = [1, 1, 1];
    // Same slim width as before, taller: about 0.135 high, cars are about 0.115. Faces +z.
    const legsGeo = geo((p, n, c) => box(p, n, c, -0.013 * s, 0, -0.008 * s, 0.026 * s, LEG * s, 0.016 * s, W));
    const torsoGeo = geo((p, n, c) => box(p, n, c, -0.016 * s, LEG * s, -0.01 * s, 0.032 * s, TORSO * s, 0.02 * s, W));
    const hy = HEAD_Y;                                 // small neck gap
    const headGeo = geo((p, n, c) => box(p, n, c, -0.011 * s, hy * s, -0.011 * s, HEAD * s, HEAD * s, HEAD * s, W));
    const hairGeo = geo((p, n, c) => {
      box(p, n, c, -0.012 * s, (hy + HEAD - 0.003) * s, -0.012 * s, 0.024 * s, 0.009 * s, 0.024 * s, W);   // top
      box(p, n, c, -0.012 * s, (hy + 0.006) * s, -0.012 * s, 0.024 * s, (HEAD - 0.006) * s, 0.006 * s, W); // back
    });
    const mat = new Material({ vertexColors: true });

    const n = MAX_PEOPLE;
    legs = new InstancedMesh(legsGeo, mat, n);
    torsos = new InstancedMesh(torsoGeo, mat, n);
    heads = new InstancedMesh(headGeo, mat, n);
    hairs = new InstancedMesh(hairGeo, mat, n);
    parts = [legs, torsos, heads, hairs];
    for (const m of parts) { m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true; m.count = 0; }

    // a fixed, varied look per resident (seeded, so it's the same after every reload)
    let seed = 12345;
    const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const choose = (arr) => arr[Math.floor(r() * arr.length)];
    const weighted = (obj) => { const e = Object.entries(obj), tot = e.reduce((a, [, w]) => a + w, 0); let x = r() * tot;
      for (const [k, w] of e) { if ((x -= w) < 0) return k; } return e[0][0]; };
    const c = new Color();
    bald = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const skin = choose(SKINS);
      torsos.setColorAt(i, c.set(choose(SHIRTS)));
      legs.setColorAt(i, c.set(choose(TROUSERS)));
      heads.setColorAt(i, c.set(skin.c));
      hairs.setColorAt(i, c.set(weighted(skin.hair)));
      bald[i] = r() < BALD ? 1 : 0;
    }
    group = new (findBase(Object.getPrototypeOf(scene), 'add'))();   // plain Object3D container
    group.name = 'sc-residents';
    group.add(...parts);
    if (HEADSHOTS) {
      // loose heads: the same head and hair, centred on the head's middle
      const cy = (hy + HEAD / 2) * s;
      const freeHead = geo((p, n, c) => box(p, n, c, -0.011 * s, hy * s - cy, -0.011 * s, HEAD * s, HEAD * s, HEAD * s, W));
      const freeHair = geo((p, n, c) => {
        box(p, n, c, -0.012 * s, (hy + HEAD - 0.003) * s - cy, -0.012 * s, 0.024 * s, 0.009 * s, 0.024 * s, W);
        box(p, n, c, -0.012 * s, (hy + 0.006) * s - cy, -0.012 * s, 0.024 * s, (HEAD - 0.006) * s, 0.006 * s, W);
      });
      looseHeads = new InstancedMesh(freeHead, mat, MAX_LOOSE_HEADS);
      looseHair = new InstancedMesh(freeHair, mat, MAX_LOOSE_HEADS);
      // legs and torso centred on their middles (for residents blown apart)
      const freeLegs = geo((p, n, c) => box(p, n, c, -0.013 * s, -LEG / 2 * s, -0.008 * s, 0.026 * s, LEG * s, 0.016 * s, W));
      const freeTorso = geo((p, n, c) => box(p, n, c, -0.016 * s, -TORSO / 2 * s, -0.01 * s, 0.032 * s, TORSO * s, 0.02 * s, W));
      looseLegs = new InstancedMesh(freeLegs, mat, MAX_LOOSE_HEADS);
      looseTorsos = new InstancedMesh(freeTorso, mat, MAX_LOOSE_HEADS);
      for (const lm of [looseHeads, looseHair, looseLegs, looseTorsos]) { lm.frustumCulled = false; lm.castShadow = true; lm.receiveShadow = true; lm.count = 0; lm.setColorAt(0, c.set('#ffffff')); }
      group.add(looseHeads, looseHair, looseLegs, looseTorsos);
      const hh = (HEAD / 2) * s;
      looseSets.push({ list: loose, a: looseHeads, b: looseHair, half: [hh, hh, hh] },
        { list: [], a: looseLegs, b: null, half: [0.013 * s, (LEG / 2) * s, 0.008 * s] },
        { list: [], a: looseTorsos, b: null, half: [0.016 * s, (TORSO / 2) * s, 0.01 * s] });
      tmpC = new Color();
      eul = new (scene.rotation.constructor)();
    }
    if (BLOOD) {
      // pools: a flat, slightly irregular disc of radius 1 (scaled per person); drops: tiny cubes
      const poolGeo = geo((pp, nn, cc) => {
        const k = 14, rad = (j) => 1 + 0.18 * Math.sin(j * 2.1) + 0.12 * Math.cos(j * 3.7);
        for (let j = 0; j < k; j++) {
          const a0 = (j / k) * Math.PI * 2, a1 = ((j + 1) / k) * Math.PI * 2, r0 = rad(j), r1 = rad((j + 1) % k);
          pp.push(0, 0, 0, Math.sin(a0) * r0, 0, Math.cos(a0) * r0, Math.sin(a1) * r1, 0, Math.cos(a1) * r1);   // counter-clockwise from above: faces up
          for (let v = 0; v < 3; v++) { nn.push(0, 1, 0); cc.push(1, 1, 1); }
        }
      });
      const dropGeo = geo((pp, nn, cc) => box(pp, nn, cc, -0.5, -0.5, -0.5, 1, 1, 1, W));
      const bloodMat = new Material({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      pools = new InstancedMesh(poolGeo, bloodMat, n);
      dropMesh = new InstancedMesh(dropGeo, bloodMat, MAX_BLOOD_DROPS);
      for (const b of [pools, dropMesh]) { b.frustumCulled = false; b.receiveShadow = true; b.count = 0; }
      for (let i = 0; i < n; i++) pools.setColorAt(i, c.set(i % 3 ? '#5c0707' : '#4a0505'));
      for (let i = 0; i < MAX_BLOOD_DROPS; i++) dropMesh.setColorAt(i, c.set(['#8a0d0d', '#6d0909', '#a31414', '#5a0606'][i % 4]));
      group.add(pools, dropMesh);
    }
    scene.add(group);
    return true;
  }

  // ---------- loop ----------
  let seenVersion = 0, last = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    if (!scene || !city) return;
    if (!built) { built = buildMeshes(); if (!built) return; }
    if (!group.parent) scene.add(group);                       // in case the app rebuilt its scene
    if (seenVersion !== cityVersion || (appModule && net && !net.doorList.length && city.projects.length && !net.triedDoors)) {
      seenVersion = cityVersion;
      buildNetwork();
      if (appModule) net.triedDoors = true;
      spawn();
    }
    const dt = Math.min(0.1, last ? (t - last) / 1000 : 0);
    last = t;
    const hidden = new M().makeScale(0, 0, 0);
    if (!tip) tip = new M();
    const m = new M();
    const n = Math.min(people.length, MAX_PEOPLE);
    const carsByTile = CAR_COLLISIONS ? movingCars() : null;
    for (let i = 0; i < n; i++) {
      const p = people[i];
      step(p, dt);
      if (carsByTile && p.state !== 'inside' && p.state !== 'down' && p.state !== 'gone') hitByCar(i, p, carsByTile);
      if (p.state === 'inside' || p.state === 'gone') { for (const part of parts) part.setMatrixAt(i, hidden); continue; }
      m.makeRotationY(p.h);
      let y = SIDEWALK_HEIGHT;
      if (p.state === 'down') {
        // tip over around the feet, away from the shot, speeding up like a real fall
        const f = p.fall * p.fall;
        tip.makeRotationAxis(p.axis, (Math.PI / 2) * f);
        m.premultiply(tip);
        y += 0.011 * SCALE * f;                                 // lying on its back, not half in the sidewalk
      }
      m.setPosition(p.x, y, p.z);
      legs.setMatrixAt(i, m); torsos.setMatrixAt(i, m); heads.setMatrixAt(i, p.headless ? hidden : m);
      hairs.setMatrixAt(i, bald[i] || p.headless ? hidden : m);
      if (p.squirt > 0 && dt > 0) squirt(p, m, dt, t);
    }
    for (const part of parts) { part.count = n; part.instanceMatrix.needsUpdate = true; }
    if (HEADSHOTS) stepHeads(dt);
    if (BLOOD) stepBlood(dt, n, m);
  }
  let tip = null;
  requestAnimationFrame(frame);

  // ---------- deaths ----------
  // Every death is announced (the bodycount script counts them): sc:kill { x, z, cause }.
  let deaths = 0;
  function died(p, cause) {
    deaths++;
    window.dispatchEvent(new CustomEvent('sc:kill', { detail: { x: p.x, z: p.z, cause, who: 'resident' } }));
  }

  // ---------- screams ----------
  // A sawtooth voice through vowel formants ("aaah"), with a pitch that shoots up and sags, a
  // shaky vibrato and some breath noise. Each person keeps their own voice. In walk mode the
  // loudness and left/right follow where they are; seen from above everyone is fairly quiet.
  let audio = null, screaming = 0, lastScream = 0, noiseBuf = null;
  function scream(p, delay = 0, short = false) {
    if (!SCREAMS) return;
    const now = performance.now();
    if (screaming >= MAX_SCREAMS || now - lastScream < 90) return;
    let vol = SCREAM_VOLUME * 0.3, pan = 0;
    const w = window.scWalk;
    if (w && w.walking && w.player) {
      const pl = w.player, dx = p.x - pl.x, dz = p.z - pl.z, d = Math.hypot(dx, dz);
      if (d > SCREAM_HEARING) return;
      vol = SCREAM_VOLUME / (1 + d * d * 0.5);
      pan = Math.max(-1, Math.min(1, (dx * Math.cos(pl.yaw) - dz * Math.sin(pl.yaw)) / (d || 1))) * Math.min(1, d * 2);
    }
    if (vol < 0.01) return;
    lastScream = now;
    try {
      audio = audio || new AudioContext();
      if (audio.state === 'suspended') audio.resume();
      const a = audio, t = a.currentTime + delay;
      const f0 = p.voice || (p.voice = Math.random() < 0.55 ? rnd(780, 1150) : rnd(430, 680));
      const len = short ? rnd(0.25, 0.45) : rnd(0.6, 1.4);
      const osc = a.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0 * 0.75, t);
      osc.frequency.exponentialRampToValueAtTime(f0 * rnd(1.05, 1.2), t + Math.min(0.15, len * 0.3));
      osc.frequency.exponentialRampToValueAtTime(f0 * rnd(0.9, 1.0), t + len * 0.7);
      osc.frequency.exponentialRampToValueAtTime(f0 * rnd(0.55, 0.7), t + len);
      const lfo = a.createOscillator(), lfoGain = a.createGain();   // the shaky voice
      lfo.frequency.value = rnd(5, 9); lfoGain.gain.value = f0 * rnd(0.02, 0.05);
      lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
      const shaper = a.createWaveShaper(), curve = new Float32Array(256);   // a bit of rasp
      for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(x * 2.5); }
      shaper.curve = curve;
      const out = a.createGain(), pn = a.createStereoPanner ? a.createStereoPanner() : null;
      osc.connect(shaper);
      for (const [fr, q, g] of [[rnd(800, 1000), 5, 1], [rnd(1150, 1450), 6, 0.7], [rnd(2600, 3000), 8, 0.35]]) {   // "aaah"
        const bp = a.createBiquadFilter(), bg = a.createGain();
        bp.type = 'bandpass'; bp.frequency.value = fr; bp.Q.value = q; bg.gain.value = g;
        shaper.connect(bp); bp.connect(bg); bg.connect(out);
      }
      if (!noiseBuf) { noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate); const ch = noiseBuf.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1; }
      const noise = a.createBufferSource(), nf = a.createBiquadFilter(), ng = a.createGain();
      noise.buffer = noiseBuf; nf.type = 'bandpass'; nf.frequency.value = 2500; nf.Q.value = 1; ng.gain.value = 0.25;
      noise.connect(nf); nf.connect(ng); ng.connect(out);
      const env = a.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(vol, t + 0.04);
      env.gain.setValueAtTime(vol, t + len * 0.6);
      env.gain.exponentialRampToValueAtTime(0.0001, t + len);
      out.connect(env);
      if (pn) { pn.pan.value = pan; env.connect(pn); pn.connect(a.destination); } else env.connect(a.destination);
      screaming++;
      osc.onended = () => { screaming--; };
      for (const s of [osc, lfo, noise]) { s.start(t); s.stop(t + len + 0.05); }
    } catch (e) { /* no audio */ }
  }

  // ---------- for other scripts (walk mode shoots with this) ----------
  // hit(origin, direction, maxDistance) → { index, t } of the nearest standing resident on that line.
  // knockDown(index, direction) → makes them fall over (away from the shot) and stay down.
  window.scResidents = {
    hit(o, d, max = 30) {
      const H = 0.135 * SCALE, R = 0.02 * SCALE, HR = 0.0125 * SCALE, neck = SIDEWALK_HEIGHT + (HEAD_Y - 0.002) * SCALE;
      const a = d.x * d.x + d.z * d.z;
      let best = null;
      people.forEach((p, i) => {
        if (i >= MAX_PEOPLE || p.state === 'inside' || p.state === 'down' || p.state === 'gone') return;
        const ex = o.x - p.x, ez = o.z - p.z;
        const ts = [];
        if (a > 1e-9) {
          // standing person = upright cylinder; where does the line enter it?
          const b = 2 * (ex * d.x + ez * d.z), c = ex * ex + ez * ez - R * R, disc = b * b - 4 * a * c;
          if (disc >= 0) { const sq = Math.sqrt(disc); ts.push((-b - sq) / (2 * a), (-b + sq) / (2 * a)); }
        }
        if (Math.abs(d.y) > 1e-9) ts.push((SIDEWALK_HEIGHT + H - o.y) / d.y);   // the top of the head
        for (const t of ts) {
          if (!(t > 0 && t < max)) continue;
          const y = o.y + d.y * t, x = o.x + d.x * t - p.x, z = o.z + d.z * t - p.z;
          if (y >= SIDEWALK_HEIGHT && y < neck && x * x + z * z <= R * R * 1.0001 && (!best || t < best.t)) best = { index: i, t, head: false };
        }
        // the head: narrower than the body, from the neck up (side or top)
        const hts = [];
        if (a > 1e-9) {
          const b = 2 * (ex * d.x + ez * d.z), c = ex * ex + ez * ez - HR * HR, disc = b * b - 4 * a * c;
          if (disc >= 0) hts.push((-b - Math.sqrt(disc)) / (2 * a));
        }
        if (Math.abs(d.y) > 1e-9) hts.push((SIDEWALK_HEIGHT + H - o.y) / d.y);
        for (const t of hts) {
          if (!(t > 0 && t < max)) continue;
          const y = o.y + d.y * t, x = o.x + d.x * t - p.x, z = o.z + d.z * t - p.z;
          if (y >= neck && y <= SIDEWALK_HEIGHT + H + 1e-6 && x * x + z * z <= HR * HR * 1.0001 && (!best || t < best.t)) best = { index: i, t, head: true };
        }
      });
      return best;
    },
    // An explosion at (x, z): everyone within knockRadius falls over (away from it), everyone
    // within panicRadius runs away for about panicSeconds. People indoors notice nothing.
    // Something scary (a gunshot) at (x, z): everyone outside within radius runs away from it.
    alarm(x, z, radius, seconds) {
      let fled = 0;
      people.forEach((p, i) => {
        if (i >= MAX_PEOPLE || p.state === 'inside' || p.state === 'down' || p.state === 'gone') return;
        if (Math.hypot(p.x - x, p.z - z) <= radius) { panic(p, x, z, seconds); fled++; }
      });
      return fled;
    },
    blast(x, z, knockRadius, panicRadius, panicSeconds) {
      let down = 0, fled = 0;
      people.forEach((p, i) => {
        if (i >= MAX_PEOPLE || p.state === 'inside' || p.state === 'down' || p.state === 'gone') return;
        const dx = p.x - x, dz = p.z - z, dist = Math.hypot(dx, dz);
        if (dist <= knockRadius) { if (this.knockDown(i, { x: dx || 1e-3, y: 0, z: dz }, 'blast')) down++; }
        else if (dist <= panicRadius) { panic(p, x, z, panicSeconds); fled++; }
      });
      return { down, fled };
    },
    // people indoors within radius of (x, z) die (the nuke); returns how many
    killInside(x, z, radius) {
      let n = 0;
      people.forEach((p, i) => {
        if (i >= MAX_PEOPLE || p.state !== 'inside' || !p.insideAt) return;
        if (Math.hypot(p.insideAt[0] - x, p.insideAt[1] - z) <= radius) { p.state = 'gone'; died({ x: p.insideAt[0], z: p.insideAt[1] }, 'inside'); n++; }
      });
      return n;
    },
    // a building with footprint x0..x1 × z0..z1 comes down: everyone inside dies, people on the
    // street close to it are buried (knocked down), people further away run. Returns how many died.
    crush(x0, z0, x1, z1, margin = CRUSH_MARGIN, panicRadius = 3) {
      let n = 0;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      people.forEach((p, i) => {
        if (i >= MAX_PEOPLE || p.state === 'down' || p.state === 'gone') return;
        if (p.state === 'inside') {
          const q = p.insideAt;
          if (q && q[0] >= x0 - 0.1 && q[0] <= x1 + 0.1 && q[1] >= z0 - 0.1 && q[1] <= z1 + 0.1) { p.state = 'gone'; died({ x: q[0], z: q[1] }, 'collapse'); n++; }
          return;
        }
        const ox = Math.max(x0 - p.x, 0, p.x - x1), oz = Math.max(z0 - p.z, 0, p.z - z1), d = Math.hypot(ox, oz);
        if (d <= margin) { if (this.knockDown(i, { x: p.x - cx || 1e-3, y: -0.5, z: p.z - cz }, 'collapse')) n++; }
        else if (d <= panicRadius) panic(p, cx, cz, 10);
      });
      return n;
    },
    get deaths() { return deaths; },
    // someone jumps out of a car at (x, z) and runs away from (fromX, fromZ), screaming; returns their index
    addRunner(x, z, fromX, fromZ, seconds = 15) {
      if (!net || !net.edges.length || !V) return -1;
      // the nearest road line
      let best = null;
      for (const [a, b] of net.edges) {
        const [ax, ay] = net.xy.get(a), [bx, by] = net.xy.get(b), ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1;
        const s0 = Math.max(0, Math.min(1, ((x - ax) * ex + (z - ay) * ey) / l2)), d = Math.hypot(ax + ex * s0 - x, ay + ey * s0 - z);
        if (!best || d < best.d) best = { a, b, s: s0, d };
      }
      if (!best) return -1;
      // run the way that leads away from the danger
      const [ax, ay] = net.xy.get(best.a), [bx, by] = net.xy.get(best.b);
      const away = Math.hypot(bx - fromX, by - fromZ) > Math.hypot(ax - fromX, ay - fromZ);
      const p = { speed: SPEED * (1 + rnd(-SPEED_VARIATION, SPEED_VARIATION)), state: 'walk', x, z, h: 0, side: 1 };
      if (away) placeOnEdge(p, best.a, best.b, best.s); else placeOnEdge(p, best.b, best.a, 1 - best.s);
      // on the sidewalk on the car's side of the road
      const r = rightOf(p.dir[0], p.dir[1]), lx = ax + (bx - ax) * best.s, lz = ay + (by - ay) * best.s;
      p.side = r[0] * (x - lx) + r[1] * (z - lz) >= 0 ? 1 : -1;
      p.prevOff = sideOffset(p);
      const off = sideOffset(p);
      p.state = 'exit'; p.from = [x, z]; p.to = [lx + off[0] * SIDEWALK_OFFSET, lz + off[1] * SIDEWALK_OFFSET];
      p.t = 0; p.dur = Math.hypot(p.to[0] - x, p.to[1] - z) / (p.speed * PANIC_SPEED) + 0.05;
      p.h = Math.atan2(p.to[0] - x, p.to[1] - z);
      p.next = [p.a, p.b]; p.nextS = p.s;
      p.panic = seconds; p.fleeFrom = [fromX, fromZ];
      // a free figure: a new one, or one that's gone
      let i = people.length < MAX_PEOPLE ? people.length : people.findIndex((q) => q.state === 'gone');
      if (i < 0) i = people.findIndex((q) => q.state === 'inside');
      if (i < 0) return -1;
      people[i] = p;
      scream(p, 0.1);
      return i;
    },
    behead(i, d) { return HEADSHOTS ? behead(i, d) : this.knockDown(i, d); },
    gib(i, x, z, power) { return gib(i, x, z, power); },
    // everyone within radius of (x, z) blown apart; returns how many
    gibAround(x, z, radius, power) {
      let n = 0;
      people.forEach((p, i) => { if (i < MAX_PEOPLE && p.state !== 'inside' && p.state !== 'gone' && Math.hypot(p.x - x, p.z - z) <= radius && gib(i, x, z, power)) n++; });
      return n;
    },
    knockDown(i, d, cause) {
      const p = people[i];
      if (!p || p.state === 'down' || p.state === 'gone' || !V) return false;
      const l = Math.hypot(d.x, d.z) || 1;
      p.state = 'down'; p.fall = 0;
      p.axis = new V(d.z / l, 0, -d.x / l);                    // horizontal axis ⟂ to the shot
      died(p, cause || 'shot');
      if (Math.random() < 0.3) scream(p, 0, true);
      if (BLOOD) bleed(p, d.x / l, d.y || 0, d.z / l);
      return true;
    },
  };
})();
