// Test scene for the local runner's test page (http://localhost:8080/test). Not a userscript: the
// server injects it before the plugins, at document-start, only on /test. It makes the small test
// city (local/test-city.json: 3 buildings in a ring road) the same on every load:
//
// - Math.random is seeded (also inside Web Workers made from a script Blob, e.g. the buildings'
//   cutter), so the app's crowd and traffic and the scripts' effects come out the same.
// - A fixed frame step: every animation frame advances the time the page sees (the rAF timestamp
//   and performance.now) by exactly 1/fps s, however long the frame really took. A run is then
//   the same frame by frame; in slow headless Chromium the game runs in slow motion (wait with
//   scTest.wait(seconds) / scTest.frames(n), not with a wall-clock timeout). On by default only in
//   automated browsers (navigator.webdriver); in your own browser ?fps=60 turns it on.
// - A fixed clock: ?date / ?time / ?timelapse default to a summer afternoon that stands still
//   (no snow, no Christmas, daylight).
// - People: exactly `people` adults of the app's crowd stand still in rows on the sidewalks of
//   the north and south road (no children). They don't walk and nobody new comes in (the app's
//   top-ups are off); what happens to them (a shot, a blast, a panic) is left to the scripts.
// - Officers (with the cops and walk mode scripts): `cops` still officers in a row along the east
//   road, placed as soon as walk mode can make them (the first time you start walking).
// - Cars: the app's traffic (2 per building = 6) parked nose to tail on the south road.
//
// URL options (all optional): ?seed=1 &people=100 &cops=8 &fps=60 (0: real time; default 60 when
// automated, else 0) &hold=0 (people
// and cars move as usual) &date=YYYY-MM-DD &time=HH:MM &timelapse=N, plus the usual ?plugins=.
//
// window.scTest: { seed, options, ready, whenReady / whenCops (promises), people, cops, cars, buildings,
// time() (seconds of page time), frame() (frames so far), frames(n), wait(seconds), reseed(n), view }.
// For a repeatable action: await scTest.frames(1); scTest.reseed(); then act in the same frame.
// 'sc:test-ready' is sent on window when the scene is set up, 'sc:test-cops' when the officers are.
(() => {
  'use strict';
  const q = new URLSearchParams(location.search);
  const num = (k, d) => { const v = q.get(k); return v === null || v === '' || !isFinite(+v) ? d : +v; };
  const SEED = Math.floor(num('seed', 1)) >>> 0;
  const PEOPLE = Math.max(0, Math.floor(num('people', 100)));
  const COPS = Math.max(0, Math.floor(num('cops', 8)));
  // Fixed step by default only in automated browsers (Playwright sets navigator.webdriver): in your
  // own browser a fixed 1/60 s per frame would run at double speed on a 120 Hz screen.
  const FPS = Math.max(0, num('fps', navigator.webdriver ? 60 : 0));
  const HOLD = q.get('hold') !== '0';
  const options = { seed: SEED, people: PEOPLE, cops: COPS, fps: FPS, hold: HOLD };

  // Layout of the test city (grid units = world units; the ring road runs along x 0…16, y 0…8).
  const SIDEWALK = 0.205;          // the sidewalk line beside a road's centre line
  const ROW_STEP = 0.3;            // tiles between two people in a row (≈ 6 m)
  const ROWS = [                   // [z of the row, heading (figure's front: +z turned by h)]
    [0 + SIDEWALK, Math.PI],       // north road, city side (in front of the buildings), facing the road
    [0 - SIDEWALK, 0],             // north road, outside
    [8 - SIDEWALK, 0],             // south road, city side
    [8 + SIDEWALK, Math.PI],       // south road, outside
  ];
  const ROW_X0 = 0.5, ROW_LEN = 50;
  const COP_X = 16 - SIDEWALK, COP_Z0 = 1, COP_STEP = 0.8, COP_H = -Math.PI / 2;   // east road, facing west
  const CAR_Y = 8, CAR_X0 = 4.25, CAR_STEP = 0.5;                                    // south road, eastbound

  // ---------- fixed clock (the app reads these once, when the city view is made) ----------
  const CLOCK = { date: '2026-06-22', time: '14:00', timelapse: '0.000001' };
  let missing = false;
  for (const k of Object.keys(CLOCK)) if (!q.has(k)) { q.set(k, CLOCK[k]); missing = true; }
  if (missing) history.replaceState(history.state, '', location.pathname + '?' + q + location.hash);
  try { localStorage.setItem('citysaver:welcome-seen', '1'); } catch (e) { /* no storage: the dialog shows */ }

  // ---------- seeded Math.random (mulberry32) ----------
  // How many numbers were drawn while the page loaded depends on timing (three.js draws 4 for every
  // object's uuid, the app's crowd and traffic draw when the data arrives), so the generator is
  // reset to a fixed state at fixed points: before the crowd is made and when the scene is ready.
  // It is reset in place (random.reseed), because the app keeps a reference to Math.random.
  const RNG_SRC = `function (seed) {
    let s = seed >>> 0;
    const random = function random() {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    random.reseed = (n) => { s = n >>> 0; };
    return random;
  }`;
  const makeRng = (0, eval)('(' + RNG_SRC + ')');
  const rng = makeRng(SEED);
  Math.random = rng;
  const SEED_CROWD = (SEED ^ 0x5bd1e995) >>> 0, SEED_RUN = (SEED ^ 0x9e3779b9) >>> 0;

  // Workers made from a script Blob get their own seeded Math.random (seed + n for the n-th worker).
  const blobText = new Map();
  const NativeBlob = window.Blob;
  window.Blob = class Blob extends NativeBlob {
    constructor(parts, opts) {
      super(parts, opts);
      if (Array.isArray(parts) && parts.every((p) => typeof p === 'string') && /javascript/.test((opts && opts.type) || '')) this.scText = parts.join('');
    }
  };
  const createURL = URL.createObjectURL;
  URL.createObjectURL = function (b) {
    const url = createURL.apply(this, arguments);
    if (b && b.scText !== undefined) blobText.set(url, b.scText);
    return url;
  };
  const NativeWorker = window.Worker;
  let workers = 0;
  window.Worker = class Worker extends NativeWorker {
    constructor(url, opts) {
      const text = blobText.get(String(url));
      if (text !== undefined) {
        const seeded = `Math.random = (${RNG_SRC})(${(SEED + ++workers) >>> 0});\n` + text;
        url = createURL(new NativeBlob([seeded], { type: 'text/javascript' }));
      }
      super(url, opts);
    }
  };

  // ---------- fixed frame step ----------
  // All callbacks of one browser frame get the same timestamp. performance.now() moves on within a
  // frame by a fixed 0.01 ms per call (not real time: code that compares times would otherwise
  // behave differently from run to run), never past 95 % of a step; a busy-wait loop still ends,
  // and if a frame really takes longer than 250 ms the rest of the 95 % is given at once.
  let frameCount = 0;
  const realNow = performance.now.bind(performance);
  const nativeRAF = window.requestAnimationFrame.bind(window);
  const STEP = FPS > 0 ? 1000 / FPS : 0;
  const CALL_STEP = 0.01, SLOW_FRAME = 250;
  let pageTime = realNow(), frameStartReal = realNow(), frameCalls = 0, lastTs = null, lastOut = 0;
  const waiters = [];
  function newFrame(ts) {
    if (ts === lastTs) return;
    lastTs = ts; frameCount++;
    if (STEP) { pageTime += STEP; frameStartReal = realNow(); frameCalls = 0; } else pageTime = ts;
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].done()) waiters.splice(i, 1)[0].resolve();
  }
  window.requestAnimationFrame = (cb) => nativeRAF((ts) => { newFrame(ts); cb(STEP ? pageTime : ts); });
  if (STEP) {
    performance.now = () => {
      const inFrame = realNow() - frameStartReal > SLOW_FRAME ? STEP * 0.95 : Math.min(++frameCalls * CALL_STEP, STEP * 0.95);
      return (lastOut = Math.max(lastOut, pageTime + inFrame));
    };
  }
  (function tick() { nativeRAF((ts) => { newFrame(ts); tick(); }); })();   // frames count with no one else asking
  const time = () => (STEP ? pageTime : realNow()) / 1000;
  const until = (done) => new Promise((resolve) => { if (done()) resolve(); else waiters.push({ done, resolve }); });

  // ---------- the scene ----------
  let readyResolve;
  const api = window.scTest = {
    seed: SEED, options, ready: false, whenReady: new Promise((r) => { readyResolve = r; }),
    people: [], cops: [], cars: [], buildings: [], view: null,
    time, frame: () => frameCount,
    frames: (n) => { const end = frameCount + n; return until(() => frameCount >= end); },
    wait: (s) => { const end = time() + s; return until(() => time() >= end); },
    // Puts the generator in a known state (default: the state it had at 'ready'). Things draw numbers
    // every frame, so call this right before the action a test checks (after scTest.frames(1)).
    reseed: (n) => rng.reseed(n === undefined ? SEED_RUN : (Number(n) ^ 0x9e3779b9) >>> 0),
  };

  // The app's city view, through React (as the core's findView).
  function findView() {
    for (const c of document.querySelectorAll('canvas')) {
      const el = c.parentElement;
      const key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      if (!key) continue;
      for (let f = el[key]; f; f = f.return) {
        for (let h = f.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) {
          const v = h.memoizedState && h.memoizedState.current;
          if (v && typeof v === 'object' && v.pedestrians && v.traffic && 'staticLights' in v) return v;
        }
      }
    }
    return null;
  }

  function setUpPeople(crowd) {
    const proto = Object.getPrototypeOf(crowd);
    // Make the app's crowd big enough, then keep the first PEOPLE adults (no children: a child
    // only follows its parent).
    let share = Math.max(crowd.share || 0, 0.05);
    for (let tries = 0; tries < 12; tries++) {
      crowd.share = share;
      proto.populate.call(crowd);
      const adults = crowd.list.filter((p) => !p.parent).length;
      if (adults >= PEOPLE) break;
      share *= Math.max(1.5, (PEOPLE * 1.3) / Math.max(1, adults));
    }
    const people = crowd.list.filter((p) => !p.parent).slice(0, PEOPLE);
    const slots = [];
    for (const [z, h] of ROWS) for (let i = 0; i < ROW_LEN; i++) slots.push([ROW_X0 + i * ROW_STEP, z, h]);
    people.forEach((p, i) => {
      const [x, z, h] = slots[i % slots.length];
      p.child = undefined;
      p.state = 'walk';
      p.x = x; p.z = z; p.h = h;
      if (HOLD) p.scHold = true;
    });
    crowd.list = people;
    // Keep it that way: the crowd size is fixed and the app (or the residents' density setting)
    // doesn't top it up or make a new one.
    const fixedShare = share;
    Object.defineProperty(crowd, 'share', { configurable: true, get: () => fixedShare, set: () => {} });
    crowd.populate = function () {};
    // Held people don't walk or turn (residents take over whoever something happens to).
    const move = crowd.move, steer = crowd.steer;
    crowd.move = function (net, p) { if (p.scHold) return; return move.apply(this, arguments); };
    crowd.steer = function (p) { if (p.scHold) return; return steer.apply(this, arguments); };
    return people;
  }

  function setUpCars(traffic) {
    const cars = traffic.cars.slice();
    cars.forEach((car, i) => {
      const at = CAR_X0 + i * CAR_STEP, x = Math.floor(at);
      Object.assign(car, { from: `${x},${CAR_Y}`, to: `${x + 1},${CAR_Y}`, s: at - x, lane: 1, side: undefined,
        next: undefined, prev: undefined, route: undefined, dest: undefined, passing: undefined, waiting: undefined,
        boost: undefined });
      if (HOLD) { car.parked = Infinity; car.speed = 0; }
      traffic.place(car);
    });
    return cars;
  }

  // Officers need walk mode's classes, which exist once walk mode has started (its camera): placed
  // now if that works, else the first time walk mode starts ('sc:walk'). scTest.whenCops resolves then.
  let copsResolve;
  api.whenCops = new Promise((r) => { copsResolve = r; });
  function placeCops() {
    const cops = [];
    for (let i = 0; i < COPS; i++) {
      let id = -1;
      try { id = window.scCops.placeAt(COP_X, COP_Z0 + i * COP_STEP, COP_H); } catch (e) { id = -1; }
      if (id < 0) break;
      cops.push(id);
    }
    return cops;
  }
  function setUpCops() {
    if (!COPS || !window.scCops || typeof window.scCops.placeAt !== 'function') { copsResolve([]); return; }
    const done = (cops) => {
      api.cops = cops; badge(); copsResolve(cops);
      console.log(`[test] ${cops.length} officers placed`);
      window.dispatchEvent(new CustomEvent('sc:test-cops', { detail: api }));
    };
    const now = placeCops();
    if (now.length) { done(now); return; }
    const onWalk = (e) => {
      if (!e.detail || !e.detail.walking) return;
      window.removeEventListener('sc:walk', onWalk);
      done(placeCops());
    };
    window.addEventListener('sc:walk', onWalk);
  }

  function badge() {
    let el = document.getElementById('sc-test-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sc-test-badge';
      el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;padding:3px 8px;border-radius:6px;' +
        'background:#c0392b;color:#fff;font:600 12px/1.4 system-ui,sans-serif;pointer-events:none;opacity:.9';
      document.body.appendChild(el);
    }
    const cops = !COPS || !window.scCops ? '' : api.cops.length ? ` · ${api.cops.length} agenten` : ' · agenten bij het lopen';
    el.textContent = `TESTSTAD · seed ${SEED} · ${api.people.length} mensen${cops} · ${api.cars.length} auto's · ` +
      (FPS ? `${FPS} fps vast` : 'echte tijd');
  }

  const started = realNow();
  function setUp() {
    const view = findView();
    // (crowd['net']: the privacy check reads a .net property as a host name)
    const crowd = view && view.pedestrians, traffic = view && view.traffic;
    const ready = crowd && crowd['net'] && crowd.list && crowd.list.length && traffic && traffic.cars.length && view.placed && view.placed.length;
    if (!ready) {
      if (realNow() - started > 120000) { console.warn('[test] the city never came up'); return; }
      setTimeout(setUp, 200);
      return;
    }
    api.view = view;
    rng.reseed(SEED_CROWD);
    api.buildings = view.placed.map((b) => {
      const p = view.projects.find((x) => x.id === b.id) || {};
      return { id: b.id, name: p.name, gx: b.gx, gy: b.gy, w: b.fp && b.fp.w, d: b.fp && b.fp.d, facing: b.facing,
        floors: (view.entries && view.entries.get(b.id) && view.entries.get(b.id).floors) || undefined };
    });
    api.people = setUpPeople(crowd);
    api.cars = setUpCars(traffic);
    api.ready = true;
    badge();
    setUpCops();
    rng.reseed(SEED_RUN);           // from here on the same numbers in the same order, every run
    console.log(`[test] ready: seed ${SEED}, ${api.people.length} people, ${api.cops.length} officers, ${api.cars.length} cars, ` +
      `${api.buildings.length} buildings, frame ${frameCount}`);
    readyResolve(api);
    window.dispatchEvent(new CustomEvent('sc:test-ready', { detail: api }));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setUp); else setUp();
})();
