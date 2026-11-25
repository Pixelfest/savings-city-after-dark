// ==UserScript==
// @name         Savings City – walk mode (first person)
// @namespace    savings-city-tweaks
// @version      1.20
// @description  Adds a "Lopen" button: walk through the city in first person. Mouse to look, WASD to walk, Shift to run, Esc to stop.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * How it works
 * ------------
 * - three.js (the app's 3D library) reports every renderer it creates to window.__THREE_DEVTOOLS__,
 *   if that exists, for its browser devtools. This script creates it at page start, so it gets the
 *   app's renderer without touching the app's code.
 * - The renderer's render() is wrapped: in walk mode the scene is drawn with our own perspective
 *   camera instead of the app's top-down one. The app keeps animating cars, lights and snow.
 * - The PerspectiveCamera class is taken from the renderer's VR camera (it is a subclass), so we
 *   use the app's own three.js copy and need no download.
 * - Collisions: every building is a group tagged with userData.projectId. The script measures the
 *   boxes of their parts, so it always matches what's drawn (also with the auto-layout script).
 * - While walking, the app's own mouse/keyboard handling is switched off, its HUD is hidden, and
 *   the sun's shadows and the snowfall are re-centred on you.
 */
(function () {
  'use strict';

  // ---- settings (all in tiles; one tile = 1 unit) --------------------------------------------
  const FOV = 70;                 // field of view in degrees
  const WALK_SPEED = 0.8;         // tiles per second (mouse wheel changes it while walking)
  const RUN_FACTOR = 2.5;         // Shift multiplies the speed
  const EYE_HEIGHT = 0.155;       // eye level of the residents: sidewalk 0.036 + eyes 0.118 (null = automatic)
  const RADIUS = 0.04;            // how close you can get to walls
  const MIN_COLLIDE_HEIGHT = 0.2; // parts lower than this are ignored when picking the start spot
  const STEP_FACTOR = 0.35;       // things lower than this × eye height (curbs, paving, low hedges) can be walked over
  const CELL = 0.04;              // collision grid resolution in tiles (smaller = more precise, slower to build)
  const LOOK_SENSITIVITY = 0.0022;
  const FOG = true;               // light haze in the distance
  const SKY = '#cde7f7';          // sky colour while walking (fog fades into the same colour)
  const SHADOW_RANGE = 25;        // tiles around you that get sun shadows
  const SHOOTING = true;          // left click while walking shoots (needs the residents script)
  const SHOOT_RANGE = 25;         // tiles
  const BULLET_SPEED = 40;        // tiles per second: very fast, but you can still see it fly
  const BULLET_SIZE = 0.007;      // thickness of the bullet
  const BULLET_LENGTH = 0.06;     // stretched along its flight, so it reads as a streak
  const BULLET_HOLES = true;      // leave a hole where a bullet hits a building
  const HOLE_SIZE = 0.012;        // diameter of a bullet hole
  const MAX_HOLES = 500;          // the oldest disappear after this many
  const SHOOT_CARS = true;        // cars can be hit
  const DESTRUCTIBLE_PROPS = true;// trees and street lamps can be shot down
  const PROP_HITS = 2;            // hits it takes before a tree or lamp snaps and falls over
  const CAR_FLEE_BOOST = 2.2;     // a hit car drives this many times its normal speed…
  const CAR_FLEE_SECONDS = 8;     // …for this long, to get away from you
  const CAR_HITS_TO_EXPLODE = 3;  // on this hit it explodes, burns out and stays put as a wreck
  const CAR_BURN_SECONDS = 25;    // how long the wreck keeps burning
  const CAR_BLAST_GIB_RADIUS = 0.3;   // ≈ 6 m: residents this close to an exploding car are blown apart
  const CAR_BLAST_KNOCK_RADIUS = 1.3; // ≈ 26 m: …this close they're knocked down (dead)
  const CAR_BLAST_PANIC_RADIUS = 5;   // ≈ 100 m: …this close they run away screaming
  const CAR_BLAST_PROP_RADIUS = 0.6;  // trees and lamps this close fall over
  const CAR_BLAST_CAR_RADIUS = 0.5;   // other cars this close take a hit (enough of them: a chain reaction)
  const BLACK_SMOKE = 1;          // amount of black smoke from burning wrecks (0 = the old grey puffs)
  const SMOKE_HEIGHT = 3.5;       // tiles: about how high the black smoke column rises before it's gone
  // Distances in tiles. A car is 0.22 long (≈ 4.5 m), so 1 tile ≈ 20 m.
  const BLAST_KNOCK_RADIUS = 0.6; // ≈ 12 m: residents this close fall over
  const BLAST_PANIC_RADIUS = 3;   // ≈ 60 m: residents this close run away
  const PANIC_SECONDS = 12;       // how long they keep running
  const SHOT_PANIC_RADIUS = 1.5;  // ≈ 30 m: residents who hear a gunshot run away from you
  const SHOT_PANIC_SECONDS = 8;
  const SOUND = true;
  const SHOW_GUN = true;          // the weapon in view, with recoil and muzzle flash when you shoot
  const FIRE_INTERVAL = 0.14;     // pistol: seconds between shots (time for the recoil animation)
  const MINIGUN_RATE = 20;        // minigun: shots per second while the button is held
  const MINIGUN_SPINUP = 0.5;     // seconds the barrels need to spin up before it fires
  const MINIGUN_SPINDOWN = 1.5;   // seconds to spin down after letting go
  const MINIGUN_SPIN_SPEED = 45;  // barrel rotation at full speed (radians per second)
  const MINIGUN_SPREAD = 1.5;     // degrees: bullets spray a little around the crosshair
  const GUN_BOB = 1;              // how much the gun bobs while walking and lags behind when you look (0 = still)
  const START_FACING = 'street';  // starting at a building: 'street' = back to the door, looking away; 'building' = look at it
  // ---------------------------------------------------------------------------------------------

  let renderer = null;
  let appCamera = null, appScene = null;
  let cam = null;                 // our first-person camera
  let walking = false;

  // ---------- 0. parked cars on parking lots ----------
  // Cars standing on parking lots are not traffic: the app copies its car shape into the parking
  // lot's ground mesh (clone → rotateY → translate(x, 0.03, z)). To make them shootable we note
  // where those copies go. BufferGeometry's prototype is found with a one-time setter on the
  // "isBufferGeometry" flag three.js sets in its constructor; if another script (car tyres) already
  // set such a trap, it is chained so both run.
  const parkedCars = new Map();   // "x,z" → { x, z, heading, isStatic: true }
  function looksLikeCar(g) {
    const p = g.attributes && g.attributes.position;
    if (!p || p.count < 60 || p.count > 4000) return false;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    // the app's cars: 0.22 long (x), 0.105 wide plus tyres (z), up to ~0.13 high, centred, standing on y = 0
    return Math.abs(x0 + 0.11) < 0.015 && Math.abs(x1 - 0.112) < 0.015 && z1 - z0 > 0.095 && z1 - z0 < 0.135 &&
      Math.abs(z0 + z1) < 0.02 && y0 > -0.002 && y0 < 0.01 && y1 > 0.1 && y1 < 0.145;
  }
  function patchGeometry(proto) {
    const rotateY = proto.rotateY, translate = proto.translate;
    proto.rotateY = function (a) {
      if (this.__scCarTurn !== undefined || looksLikeCar(this)) this.__scCarTurn = (this.__scCarTurn || 0) + a;
      return rotateY.apply(this, arguments);
    };
    proto.translate = function (x, y, z) {
      if (this.__scCarTurn !== undefined && Math.abs(y - 0.03) < 1e-6) {
        const key = `${x.toFixed(3)},${z.toFixed(3)}`;
        if (!parkedCars.has(key)) parkedCars.set(key, { x, z, heading: -this.__scCarTurn, isStatic: true });
      }
      return translate.apply(this, arguments);
    };
  }
  (function trapGeometry() {
    const KEY = 'isBufferGeometry';
    const prev = Object.getOwnPropertyDescriptor(Object.prototype, KEY);
    if (prev && !prev.set) return;
    Object.defineProperty(Object.prototype, KEY, {
      configurable: true,
      set(v) {
        if (prev) prev.set.call(this, v); else delete Object.prototype[KEY];
        delete Object.prototype[KEY];
        if (!Object.prototype.hasOwnProperty.call(this, KEY)) Object.defineProperty(this, KEY, { value: v, writable: true, enumerable: true, configurable: true });
        let p = Object.getPrototypeOf(this);
        while (p && !Object.prototype.hasOwnProperty.call(p, 'translate')) p = Object.getPrototypeOf(p);
        if (p) patchGeometry(p);
      },
    });
  })();

  // ---------- 1. catch the renderer through three.js' devtools hook ----------
  const hook = window.__THREE_DEVTOOLS__ || (window.__THREE_DEVTOOLS__ = new EventTarget());
  hook.addEventListener('observe', (e) => {
    const o = e.detail;
    if (o && o.isWebGLRenderer && !renderer) patchRenderer(o);
    if (o && o.isScene && !o.__scWalkAdd) watchSceneAdds(o);
  });

  // The app adds all its layers in one call: scene.add(greenery, …, carBatchGroup, overlayGroup).
  // The last one, the overlay, holds the selection and hover highlights; it's hidden while walking.
  let overlay = null;
  function watchSceneAdds(sc) {
    sc.__scWalkAdd = true;
    const add = sc.add;
    sc.add = function () {
      if (arguments.length >= 6 && !overlay) overlay = arguments[arguments.length - 1];
      return add.apply(this, arguments);
    };
  }
  // Fallback: a layer holding the selection haze (white, see-through, no depth writing).
  function findOverlay(sc) {
    for (const g of sc.children) {
      let hit = false;
      g.traverse((o) => { const m = o.material; if (!hit && m && !Array.isArray(m) && m.transparent && m.depthWrite === false && m.polygonOffset && m.opacity > 0.2 && m.opacity < 0.35) hit = true; });
      if (hit) return g;
    }
    return null;
  }

  function patchRenderer(r) {
    renderer = r;
    const orig = r.render.bind(r);
    r.render = function (scene, camera) {
      if (scene && scene.isScene && camera && camera.isOrthographicCamera) { appScene = scene; appCamera = camera; }
      if (walking && scene === appScene && cam) {
        stepWalk(scene);
        const ov = overlay || findOverlay(scene);
        const vis = ov ? ov.visible : null;
        if (ov) ov.visible = false;                    // no selection/hover highlight while walking
        try { return orig(scene, cam); } finally { if (ov) ov.visible = vis; drawGun(orig); }
      }
      return orig(scene, camera);
    };
  }

  function makeCamera() {
    // ArrayCamera (used for VR) extends PerspectiveCamera – take its parent class.
    const arrayCam = renderer.xr && renderer.xr.getCamera && renderer.xr.getCamera();
    const Perspective = arrayCam && Object.getPrototypeOf(arrayCam.constructor.prototype).constructor;
    if (!Perspective || !new Perspective().isPerspectiveCamera) throw new Error('PerspectiveCamera not found');
    const c = new Perspective(FOV, 1, 0.01, 400);
    c.rotation.order = 'YXZ';
    return c;
  }

  // ---------- 2. colliders from the drawn buildings ----------
  // A fine grid (CELL tiles per cell) marks where walls actually stand. It is made from the
  // buildings' triangles: only wall-like parts between knee and eye height block you, so plots,
  // paving, lawns and sidewalks stay walkable right up to the facade.
  let boxes = [];              // [x0, z0, x1, z1, top] per part – for the start spot and tallest building
  let grid = null;             // { x0, z0, w, h, cells: Uint8Array }
  let gridSig = '';
  let checkedAt = 0;

  // another script (nuke) changed the buildings' shapes: rebuild the walls at the next check
  window.addEventListener('sc:geometry-changed', () => { gridSig = ''; checkedAt = 0; propSig = ''; propsAt = 0; });

  function buildingGroups() {
    const gs = [];
    appScene.traverse((g) => { if (g.userData && g.userData.projectId !== undefined) gs.push(g); });
    return gs;
  }
  const signature = (gs) => gs.map((g) => `${g.userData.projectId}@${g.position.x},${g.position.z}:${g.children.length}`).join('|');

  // Calls fn(meshLike, worldMatrix) for every mesh (and every instance of an instanced mesh).
  function eachMesh(groups, fn) {
    const M = appCamera.matrixWorld.constructor;
    const m = new M();
    for (const g of groups) {
      g.updateWorldMatrix(true, true);
      g.traverse((o) => {
        if (!(o.isMesh || o.isInstancedMesh) || !o.geometry || !o.geometry.attributes.position) return;
        if (o.isInstancedMesh) {
          for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); m.premultiply(o.matrixWorld); fn(o, m); }
        } else fn(o, o.matrixWorld);
      });
    }
  }

  function buildColliders(force) {
    const groups = buildingGroups();
    const sig = signature(groups);
    if (!force && sig === gridSig) return;
    gridSig = sig;
    const V = appCamera.position.constructor;      // three's Vector3
    const v = new V(), A = new V(), B = new V(), C = new V();

    // pass 1: part boxes
    const out = [];
    eachMesh(groups, (o, mw) => {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(mw);
        x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y); z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z);
      }
      if (y1 < MIN_COLLIDE_HEIGHT || x1 - x0 > 30 || z1 - z0 > 30) return;
      out.push([x0, z0, x1, z1, y1]);
    });
    boxes = out;
    if (!boxes.length) { grid = null; return; }
    if (!eyeSet) { const tops = boxes.map((b) => b[4]).sort((a, b) => a - b); eye = EYE_HEIGHT ?? Math.min(0.5, Math.max(0.05, tops[0] * 0.5)); eyeSet = true; }

    // pass 2: rasterise wall triangles into the grid
    const gx0 = Math.floor(Math.min(...boxes.map((b) => b[0]))) - 2, gz0 = Math.floor(Math.min(...boxes.map((b) => b[1]))) - 2;
    const gx1 = Math.ceil(Math.max(...boxes.map((b) => b[2]))) + 2, gz1 = Math.ceil(Math.max(...boxes.map((b) => b[3]))) + 2;
    const w = Math.ceil((gx1 - gx0) / CELL), h = Math.ceil((gz1 - gz0) / CELL);
    if (w * h > 16e6) { grid = null; return; }
    const cells = new Uint8Array(w * h);
    const knee = eye * STEP_FACTOR, head = eye;
    const mark = (x, z) => {
      const i = Math.floor((x - gx0) / CELL), j = Math.floor((z - gz0) / CELL);
      if (i >= 0 && j >= 0 && i < w && j < h) cells[j * w + i] = 1;
    };
    const line = (p, q) => {
      const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / (CELL * 0.5)));
      for (let k = 0; k <= n; k++) { const t = k / n; mark(p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t); }
    };
    eachMesh(groups, (o, mw) => {
      const pos = o.geometry.attributes.position, idx = o.geometry.index;
      const nTri = (idx ? idx.count : pos.count) / 3;
      for (let t = 0; t < nTri; t++) {
        const ia = idx ? idx.getX(3 * t) : 3 * t, ib = idx ? idx.getX(3 * t + 1) : 3 * t + 1, ic = idx ? idx.getX(3 * t + 2) : 3 * t + 2;
        A.fromBufferAttribute(pos, ia).applyMatrix4(mw);
        B.fromBufferAttribute(pos, ib).applyMatrix4(mw);
        C.fromBufferAttribute(pos, ic).applyMatrix4(mw);
        const lo = Math.min(A.y, B.y, C.y), hi = Math.max(A.y, B.y, C.y);
        if (hi < knee || lo > head) continue;            // below the knee (paving, lawn) or above your head
        if (hi - lo < 0.01) continue;                    // flat: floors and roofs don't block, walls do
        line(A, B); line(B, C); line(C, A);
      }
    });
    grid = { x0: gx0, z0: gz0, w, h, cells };
  }

  function blocked(x, z) {
    if (!grid) return false;
    const r = Math.ceil(RADIUS / CELL);
    const ci = Math.floor((x - grid.x0) / CELL), cj = Math.floor((z - grid.z0) / CELL);
    for (let j = cj - r; j <= cj + r; j++) {
      if (j < 0 || j >= grid.h) continue;
      for (let i = ci - r; i <= ci + r; i++) {
        if (i < 0 || i >= grid.w) continue;
        if (grid.cells[j * grid.w + i] && Math.hypot((i + 0.5) * CELL + grid.x0 - x, (j + 0.5) * CELL + grid.z0 - z) < RADIUS + CELL * 0.71) return true;
      }
    }
    return false;
  }

  // ---------- 3. walking ----------
  const keys = new Set();
  let yaw = 0, pitch = 0, speed = WALK_SPEED, eye = 0.15, eyeSet = false, lastT = 0;
  const pos = { x: 0, z: 0 };
  const stick = { x: 0, y: 0 };       // touch joystick (-1..1)

  const inBox = (x, z, m) => boxes.some((b) => x > b[0] - m && x < b[2] + m && z > b[1] - m && z < b[3] + m);

  function startPosition() {
    if (!boxes.length) return;
    // city centre = middle of all buildings; tallest building = what we look at
    let sx = 0, sz = 0, tall = boxes[0];
    for (const b of boxes) { sx += (b[0] + b[2]) / 2; sz += (b[1] + b[3]) / 2; if (b[4] > tall[4]) tall = b; }
    const cx = sx / boxes.length, cz = sz / boxes.length;
    // nearest free spot to the centre (spiral outward)
    let best = null;
    for (let r = 0; r < 40 && !best; r += 0.25) {
      for (let a = 0; a < 16; a++) {
        const x = cx + r * Math.cos(a * Math.PI / 8), z = cz + r * Math.sin(a * Math.PI / 8);
        if (!inBox(x, z, 0.3)) { best = [x, z]; break; }
      }
    }
    if (best) [pos.x, pos.z] = best; else { pos.x = cx; pos.z = cz + 20; }
    const tx = (tall[0] + tall[2]) / 2 - pos.x, tz = (tall[1] + tall[3]) / 2 - pos.z;
    yaw = Math.atan2(-tx, -tz);   // camera looks down -Z at yaw 0
    pitch = 0.08;
  }

  function stepWalk(scene) {
    const now = performance.now();
    const dt = Math.min(0.1, lastT ? (now - lastT) / 1000 : 0);
    lastT = now;
    if (now - checkedAt > 2000) { checkedAt = now; buildColliders(false); }   // rebuilt only when buildings change
    if (DESTRUCTIBLE_PROPS && now - propsAt > 3000) { propsAt = now; try { scanProps(); } catch (e) { console.warn('[walk] trees/lamps', e); } }
    stepBullets(dt);
    if (SHOOTING) stepWeapons(dt);

    // movement relative to where you look
    let f = 0, s = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) s += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) s -= 1;
    f += -stick.y; s += stick.x;
    const len = Math.hypot(f, s);
    if (len > 1) { f /= len; s /= len; }
    const sp = speed * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? RUN_FACTOR : 1) * dt;
    const dx = (-Math.sin(yaw) * f + Math.cos(yaw) * s) * sp;
    const dz = (-Math.cos(yaw) * f - Math.sin(yaw) * s) * sp;
    // slide along walls: try each axis separately
    const px = pos.x, pz = pos.z;
    if (!blocked(pos.x + dx, pos.z)) pos.x += dx;
    if (!blocked(pos.x, pos.z + dz)) pos.z += dz;
    gunMotion.dt = dt; gunMotion.moved = Math.hypot(pos.x - px, pos.z - pz);
    if (keys.has('KeyR')) eye = Math.min(5, eye + 0.4 * dt);
    if (keys.has('KeyF')) eye = Math.max(0.03, eye - 0.4 * dt);

    const el = renderer.domElement;
    cam.aspect = (el.clientWidth || 1) / (el.clientHeight || 1);
    cam.updateProjectionMatrix();
    cam.position.set(pos.x, eye, pos.z);
    cam.rotation.set(pitch, yaw, 0);
    cam.updateMatrixWorld();

    // sun shadows around you instead of around the app's view
    if (sun) {
      sun.position.set(pos.x - 18, 40, pos.z + 26);
      sun.target.position.set(pos.x, 0, pos.z);
      sun.target.updateMatrixWorld();
      const sc = sun.shadow.camera;
      sc.left = sc.bottom = -SHADOW_RANGE; sc.right = sc.top = SHADOW_RANGE;
      sc.updateProjectionMatrix();
    }
    // snowfall around you (the app re-centres it on its own view every frame)
    for (const u of snowUniforms) {
      u.uCenter.value.set(pos.x, 0, pos.z);
      u.uBox.value.set(14, 5, 14);
      u.uSize.value = 2.5 * renderer.getPixelRatio();
    }
  }

  // ---------- 4. entering / leaving ----------
  let sun = null, sunSaved = null, snowUniforms = [], fogSaved, bgSaved, hud = [];

  function enter(e, startAt) {
    // Mouse or touch? Decided by what you clicked the button with, not by the device type
    // (laptops with a touchscreen report themselves as "touch" otherwise).
    usingMouse = !(e && (e.pointerType === 'touch' || e.pointerType === 'pen'));
    if (walking) return;
    if (!renderer || !appScene) { alert('De 3D-stad is nog niet geladen.'); return; }
    try { cam = cam || makeCamera(); } catch (e) { alert('Lopen werkt niet in deze versie van de app.'); console.warn('[walk]', e); return; }
    eyeSet = false;
    buildColliders(true);
    if (!boxes.length) { alert('Geen gebouwen gevonden om tussen te lopen.'); return; }
    if (startAt) applyStart(startAt); else startPosition();

    sun = null; snowUniforms = [];
    appScene.traverse((o) => {
      if (o.isDirectionalLight && o.castShadow && !sun) sun = o;
      const u = o.material && o.material.uniforms;
      if (u && u.uCenter && u.uBox && u.uSize) snowUniforms.push(u);
    });
    if (sun) {
      const c = sun.shadow.camera;
      sunSaved = { p: sun.position.clone(), t: sun.target.position.clone(), b: [c.left, c.right, c.top, c.bottom] };
    }
    // The app's canvas is transparent: the sky is a CSS gradient behind it. Glowing things such as
    // the Christmas-light halos are drawn by *adding* light, which turns black against a transparent
    // background. Seen from above there's always ground behind them; while walking there's sky.
    // So: give the scene a real, opaque sky while walking.
    const Color = findColorClass();
    if (Color) { bgSaved = appScene.background; appScene.background = new Color(SKY); }
    if (FOG && !appScene.fog) {
      // three's Fog class isn't in this build; the renderer only needs these fields.
      if (Color) { fogSaved = appScene.fog; appScene.fog = { isFog: true, name: '', color: new Color(SKY), near: 12, far: 55 }; }
    }

    hud = [...document.querySelectorAll('.hud, .city-overlay')];
    hud.forEach((h) => { h.dataset.scWalkDisplay = h.style.display; h.style.display = 'none'; });
    keys.clear(); lastT = 0; speed = WALK_SPEED;
    walking = true;
    window.dispatchEvent(new CustomEvent('sc:walk', { detail: { walking: true } }));
    showUi(true);
    if (usingMouse) lockMouse();
  }

  function leave() {
    if (!walking) return;
    walking = false;
    window.dispatchEvent(new CustomEvent('sc:walk', { detail: { walking: false } }));
    clearBullets();
    trigger = false; spin = 0; whir(0);
    hadLock = false;
    if (document.pointerLockElement) document.exitPointerLock();
    if (sun && sunSaved) {
      sun.position.copy(sunSaved.p); sun.target.position.copy(sunSaved.t); sun.target.updateMatrixWorld();
      const c = sun.shadow.camera; [c.left, c.right, c.top, c.bottom] = sunSaved.b; c.updateProjectionMatrix();
    }
    if (fogSaved !== undefined || (appScene && appScene.fog && appScene.fog.isFog)) { appScene.fog = fogSaved ?? null; fogSaved = undefined; }
    if (bgSaved !== undefined) { appScene.background = bgSaved; bgSaved = undefined; }
    hud.forEach((h) => { h.style.display = h.dataset.scWalkDisplay || ''; });
    keys.clear(); stick.x = stick.y = 0;
    showUi(false);
  }

  function findColorClass() {
    let C = null;
    appScene.traverse((o) => { if (!C && o.material && o.material.color && o.material.color.isColor) C = o.material.color.constructor; });
    return C;
  }

  // ---------- 5. input (captured before the app sees it) ----------
  let usingMouse = true;
  let drag = null;   // touch: look by dragging
  let hadLock = false;

  // Click once: the mouse pointer is captured and moving the mouse looks around (no button held).
  function lockMouse() {
    const el = renderer.domElement;
    if (!el.requestPointerLock || document.pointerLockElement === el) return;
    const failed = () => flash('Klik in het beeld om met de muis rond te kijken', 2500);
    try {
      let p;
      try { p = el.requestPointerLock({ unadjustedMovement: true }); } catch { p = el.requestPointerLock(); }
      if (p && p.catch) p.catch(() => { try { const q = el.requestPointerLock(); if (q && q.catch) q.catch(failed); } catch { failed(); } });
    } catch { failed(); }
  }

  const onCanvas = (e) => renderer && (e.target === renderer.domElement || document.pointerLockElement === renderer.domElement);

  window.addEventListener('keydown', (e) => {
    if (!walking) return;
    if (e.code === 'Escape') leave();
    else if (SHOOTING && WEAPON_KEYS[e.code]) selectWeapon(WEAPON_KEYS[e.code]);
    else if (SHOOTING && e.code === 'KeyQ' && !e.repeat) { const ids = Object.keys(WEAPONS); selectWeapon(ids[(ids.indexOf(weapon) + 1) % ids.length]); }
    else keys.add(e.code);
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  window.addEventListener('keyup', (e) => {
    if (!walking) return;
    keys.delete(e.code);
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  window.addEventListener('blur', () => { keys.clear(); trigger = false; });

  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointerleave', 'pointercancel', 'click', 'dblclick', 'contextmenu', 'wheel']) {
    window.addEventListener(type, (e) => {
      if (!walking || !onCanvas(e)) return;
      if (type === 'pointermove') {
        if (document.pointerLockElement) look(e.movementX, e.movementY);
        else if (drag && e.pointerId === drag.id) { look(e.clientX - drag.x, e.clientY - drag.y); drag.x = e.clientX; drag.y = e.clientY; }
      } else if (type === 'pointerdown') {
        if (e.pointerType === 'mouse') {
          usingMouse = true;
          if (!document.pointerLockElement) lockMouse();
          else if (e.button === 0 && SHOOTING) { trigger = true; if (WEAPONS[weapon].plugin) firePlugin(weapon); else if (weapon === 'pistol') shoot('pistol'); }
        }
        else drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      } else if (type === 'pointerup' || type === 'pointercancel') {
        if (e.pointerType === 'mouse' && (e.button === 0 || type === 'pointercancel')) trigger = false;
        if (drag && e.pointerId === drag.id) drag = null;
      } else if (type === 'wheel') {
        speed = Math.min(8, Math.max(0.1, speed * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        flash(`Snelheid ${speed.toFixed(1)}`);
      }
      e.preventDefault(); e.stopImmediatePropagation();
    }, { capture: true, passive: false });
  }

  // Esc releases the mouse (the browser does that itself) – and then ends walk mode.
  document.addEventListener('pointerlockchange', () => {
    const locked = renderer && document.pointerLockElement === renderer.domElement;
    if (locked) { hadLock = true; return; }
    if (walking && hadLock) leave();
  });

  // ---------- shooting ----------
  // Aim = the crosshair (centre of the view). The residents script answers who's in the line of
  // fire (window.scResidents); a wall in between stops the shot.
  function wallAt(x, z) {
    if (!grid) return false;
    const i = Math.floor((x - grid.x0) / CELL), j = Math.floor((z - grid.z0) / CELL);
    return i >= 0 && j >= 0 && i < grid.w && j < grid.h && !!grid.cells[j * grid.w + i];
  }
  let lastShot = 0;
  function shoot(kind = 'pistol') {
    if (swap > 0.3 || shown !== kind) return;              // still switching weapons
    if (kind === 'pistol') {
      const now = performance.now();
      if (now - lastShot < FIRE_INTERVAL * 1000) return;
      lastShot = now;
    }
    const o = { x: pos.x, y: eye, z: pos.z };
    let ay = yaw, ap = pitch;
    if (kind === 'minigun') {                               // spray: a random point in a small cone
      const r = Math.sqrt(Math.random()) * MINIGUN_SPREAD * Math.PI / 180, a = Math.random() * Math.PI * 2;
      ay += Math.cos(a) * r; ap += Math.sin(a) * r;
    }
    const d = { x: -Math.sin(ay) * Math.cos(ap), y: Math.sin(ap), z: -Math.cos(ay) * Math.cos(ap) };
    sound(kind === 'minigun' ? 'mg' : 'shot');
    gunFired();
    if (ui) { ui.classList.remove('fire'); void ui.offsetWidth; ui.classList.add('fire'); }
    // whoever hears it runs away from you (and the police come)
    if (window.scResidents && typeof window.scResidents.alarm === 'function') window.scResidents.alarm(o.x, o.z, SHOT_PANIC_RADIUS, SHOT_PANIC_SECONDS);
    shotEvent(o, kind);

    // how far the shot gets: the ground, a wall, or the range
    let tEnd = SHOOT_RANGE;
    if (d.y < -1e-6) tEnd = Math.min(tEnd, o.y / -d.y);
    // exact hit on a building's surface (its triangles); the coarse wall grid as a fallback
    const wall = rayBuildings(o, d, tEnd);
    if (wall) tEnd = wall.t;
    else for (let t = 0; t < tEnd; t += CELL / 2) {
      if (wallAt(o.x + d.x * t, o.z + d.z * t) && o.y + d.y * t < 3) { tEnd = t; break; }
    }
    // a tree or lamp before that? (a little slack: trees on lots also exist as hidden building parts)
    const propHit = DESTRUCTIBLE_PROPS ? hitProp(o, d, tEnd + 0.03) : null;
    if (propHit) tEnd = propHit.t;
    // a car before that?
    const carHit = SHOOT_CARS ? hitCar(o, d, tEnd) : null;
    if (carHit) tEnd = carHit.t;
    // the nearest resident before that
    const res = window.scResidents;
    let target = null;
    if (res && typeof res.hit === 'function') {
      const h = res.hit(o, d, tEnd);
      if (h) { target = h; tEnd = h.t; }
    }
    // or someone from another script (cops) even closer
    const other = hitTargets(o, d, tEnd);
    if (other) { target = null; tEnd = other.t; }
    // the bullet leaves "the gun" a little right of and below your eye, and flies to that point
    const end = { x: o.x + d.x * tEnd, y: o.y + d.y * tEnd, z: o.z + d.z * tEnd };
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const start = muzzleWorld(o) || { x: o.x + rx * 0.025 + d.x * 0.04, y: o.y - 0.02 + d.y * 0.04, z: o.z + rz * 0.025 + d.z * 0.04 };
    fire(start, end, () => {
      if (other) other.target.onHit(other.h, d, kind);
      else if (target) { if (target.head && typeof res.behead === 'function' ? res.behead(target.index, d) : res.knockDown(target.index, d)) sound('hit'); }
      else if (carHit) damageCar(carHit.car);
      else if (propHit) damageProp(propHit.prop, d, end);
      else if (wall && BULLET_HOLES) addHole(end, wall.n);
    });
  }

  // ---------- cars ----------
  // The app moves its cars from a list in its traffic simulation, every frame with
  // traffic.cars.forEach(...). That call reveals the list: car objects with x, z, heading,
  // base (normal speed), boost (speed factor), parked (stands still while set) …
  // Car i of that list is the 3D car whose userData.car.index is i.
  let trafficCars = null;
  const origForEach = Array.prototype.forEach;
  Array.prototype.forEach = function () {
    if (this !== trafficCars && this.length) {
      const c = this[0];
      if (c && typeof c === 'object' && typeof c.base === 'number' && typeof c.heading === 'number' && 'from' in c && 'to' in c) trafficCars = this;
    }
    return origForEach.apply(this, arguments);
  };

  function carObjects() {   // index → 3D car
    const out = new Map();
    appScene.traverse((o) => { const c = o.userData && o.userData.car; if (c && typeof c.index === 'number') out.set(c.index, o); });
    return out;
  }

  // Nearest car along the ray: the car's box in its own coordinates (length along x, body up to ~0.12).
  function hitCar(o, d, maxT) {
    if (!appScene) return null;
    let best = null;
    // parked cars on lots: their box, turned by their heading, bottom at the lot surface (0.03)
    for (const car of parkedCars.values()) {
      const rx = o.x - car.x, rz = o.z - car.z;
      if (rx * rx + rz * rz > maxT * maxT + 1) continue;
      const c = Math.cos(car.heading), s = Math.sin(car.heading);   // world → car: rotate by +heading around y
      const OO = [rx * c - rz * s, o.y, rx * s + rz * c], DD = [d.x * c - d.z * s, d.y, d.x * s + d.z * c];
      const lo = [-0.115, 0.03, -0.06], hi = [0.115, 0.15, 0.06];
      let t0 = 0, t1 = best ? best.t : maxT, ok = true;
      for (let k = 0; k < 3 && ok; k++) {
        if (Math.abs(DD[k]) < 1e-12) { if (OO[k] < lo[k] || OO[k] > hi[k]) ok = false; continue; }
        let a = (lo[k] - OO[k]) / DD[k], b = (hi[k] - OO[k]) / DD[k]; if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) ok = false;
      }
      if (ok && t0 > 0) best = { t: t0, car };
    }
    if (!trafficCars) return best;
    for (const [i, mesh] of carObjects()) {
      const car = trafficCars[i]; if (!car) continue;
      const inv = mesh.matrixWorld.clone().invert();
      const V = mesh.position.constructor;
      const O = new V(o.x, o.y, o.z).applyMatrix4(inv), D = new V(o.x + d.x, o.y + d.y, o.z + d.z).applyMatrix4(inv).sub(O);
      const lo = [-0.115, 0, -0.06], hi = [0.115, 0.12, 0.06], OO = [O.x, O.y, O.z], DD = [D.x, D.y, D.z];
      let t0 = 0, t1 = best ? best.t : maxT, ok = true;
      for (let k = 0; k < 3 && ok; k++) {
        if (Math.abs(DD[k]) < 1e-12) { if (OO[k] < lo[k] || OO[k] > hi[k]) ok = false; continue; }
        let a = (lo[k] - OO[k]) / DD[k], b = (hi[k] - OO[k]) / DD[k]; if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) ok = false;
      }
      if (ok && t0 > 0) best = { t: t0, car, index: i };
    }
    return best;
  }

  const damage = new Map();   // car object → { hits, fleeUntil, prevBoost, wreck, t0, fireAt, smokeAt }
  function damageCar(car) {
    let st = damage.get(car);
    if (!st) damage.set(car, (st = { hits: 0 }));
    if (st.wreck) return;
    st.hits++;
    if (st.hits >= CAR_HITS_TO_EXPLODE) { explode(car, st); return; }
    if (car.isStatic) return;                                   // nobody inside: it just takes the hits
    // flee: drive off much faster for a while
    if (!st.fleeUntil) st.prevBoost = car.boost;
    car.boost = CAR_FLEE_BOOST;
    st.fleeUntil = performance.now() + CAR_FLEE_SECONDS * 1000;
    startEffects();
  }

  function explode(car, st) {
    st.wreck = true; st.t0 = performance.now(); st.fireAt = st.smokeAt = 0;
    car.boost = st.prevBoost; car.parked = Infinity; car.speed = 0;   // stops for good; others drive round it
    sound('boom');
    const x = car.x, z = car.z, y = 0.08;
    carExploded(car, x, z);
    // the blast: close by blown apart, further knocked down, further still running away
    const res = window.scResidents;
    if (res && typeof res.gibAround === 'function') res.gibAround(x, z, CAR_BLAST_GIB_RADIUS, 1.1);
    if (res && typeof res.blast === 'function') {
      const r = res.blast(x, z, CAR_BLAST_KNOCK_RADIUS, CAR_BLAST_PANIC_RADIUS, PANIC_SECONDS);
      if (r && r.down) setTimeout(() => sound('hit'), 250);
    }
    blastEvent(x, z, CAR_BLAST_GIB_RADIUS, CAR_BLAST_KNOCK_RADIUS, CAR_BLAST_PANIC_RADIUS);
    if (DESTRUCTIBLE_PROPS) for (const p of props.values()) {
      if (p.state !== 'up') continue;
      const dx = p.x - x, dz = p.z - z, l = Math.hypot(dx, dz);
      if (l <= CAR_BLAST_PROP_RADIUS) { p.hits = Math.max(p.hits, PROP_HITS - 1); damageProp(p, { x: dx / (l || 1), y: 0, z: dz / (l || 1) }, { x: p.x, y: p.y0 + 0.05, z: p.z }); }
    }
    // other cars close by take a hit, a moment later (a row of parked cars can go up one by one)
    const near = [...(trafficCars || []), ...parkedCars.values()].filter((c) => c !== car && Math.hypot(c.x - x, c.z - z) <= CAR_BLAST_CAR_RADIUS);
    if (near.length) setTimeout(() => near.forEach((c) => damageCar(c)), 300 + Math.random() * 400);
    // fireball: a big flash, a ball of fire rising, burning bits flying out
    spawn('flash', x, y, z, { size: 0.5, life: 0.3, grow: 2.2 });
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2, up = Math.random(), sp = 0.6 + Math.random() * 1.6;
      spawn('fire', x, y, z, { vx: Math.cos(a) * sp * (1 - up * 0.5), vy: 0.5 + up * 1.8, vz: Math.sin(a) * sp * (1 - up * 0.5), g: 1.6, size: 0.04 + Math.random() * 0.04, life: 0.5 + Math.random() * 0.6 });
    }
    for (let i = 0; i < 14; i++) spawn('fire', x + (Math.random() - 0.5) * 0.2, y + 0.05, z + (Math.random() - 0.5) * 0.2, { vy: 0.6 + Math.random() * 0.5, size: 0.08 + Math.random() * 0.06, grow: 1.6, life: 0.6 + Math.random() * 0.4 });
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2, sp = 0.5 + Math.random() * 1.1;
      spawn('debris', x, y, z, { vx: Math.cos(a) * sp, vy: 0.8 + Math.random() * 1.4, vz: Math.sin(a) * sp, g: 3, size: 0.012 + Math.random() * 0.016, life: 2.5 + Math.random(), land: true, spin: true });
    }
    // a thick black cloud boiling up out of the fireball
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 0.12;
      blackSmoke(x + Math.cos(a) * r, y + 0.05 + Math.random() * 0.25, z + Math.sin(a) * r, { vx: Math.cos(a) * (0.1 + Math.random() * 0.3), rise: 0.35 + Math.random() * 0.5, vy: 0.6 + Math.random() * 0.8, size: 0.08 + Math.random() * 0.08, life: 4 + Math.random() * 4, vz: Math.sin(a) * (0.1 + Math.random() * 0.3) });
    }
    startEffects();
  }
  function carExploded(car, x, z) {
    window.dispatchEvent(new CustomEvent('sc:car-exploded', { detail: { x, z, police: isPolice(car) } }));
  }
  function isPolice(car) {
    if (!trafficCars || !appScene) return false;
    const i = trafficCars.indexOf(car); if (i < 0) return false;
    const m = carObjects().get(i);
    return !!(m && m.userData.car && m.userData.car.kind === 'police');
  }
  // tells other scripts (cops, …) about an explosion: gib / knock / panic radius
  function blastEvent(x, z, gib, knock, panic) {
    window.dispatchEvent(new CustomEvent('sc:blast', { detail: { x, z, gib, knock, panic } }));
  }
  // black smoke: rises (slowing to `rise`), drifts with the wind, grows big and fades as it goes up
  function blackSmoke(x, y, z, o) {
    spawn('blacksmoke', x, y, z, { fade: true, alpha: 0.9, grow: 7, rise: 0.3, drag: 1.2, ...o });
  }

  // Burnt look: darken the car's own instance (multiplies its colours).
  function tintCar(index, f) {
    let batch = null;
    appScene.traverse((o) => { if (!batch && o.isInstancedMesh && Array.isArray(o.userData.cars) && o.userData.cars.includes(index)) batch = o; });
    if (!batch) return;
    const slot = batch.userData.cars.indexOf(index);
    const C = findColor();
    if (!C) return;
    const c = new C(1, 1, 1).lerp(new C('#26211f'), f);
    batch.setColorAt(slot, c);
    batch.instanceColor.needsUpdate = true;
  }
  // Burnt look for a parked car: darken its vertices in the parking lot's mesh (vertex colours).
  function tintParked(car, f) {
    if (!car.verts) {
      car.verts = [];
      const c = Math.cos(car.heading), s = Math.sin(car.heading);
      appScene.traverse((m) => {
        if (!m.isMesh || m.isInstancedMesh || !m.geometry) return;
        const g = m.geometry, pos = g.attributes.position, col = g.attributes.color;
        if (!pos || !col) return;
        m.updateWorldMatrix(true, false);
        const e = m.matrixWorld.elements, idx = [];
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          const wx = e[0] * x + e[4] * y + e[8] * z + e[12] - car.x, wy = e[1] * x + e[5] * y + e[9] * z + e[13], wz = e[2] * x + e[6] * y + e[10] * z + e[14] - car.z;
          const lx = wx * c - wz * s, lz = wx * s + wz * c;
          if (Math.abs(lx) < 0.12 && Math.abs(lz) < 0.065 && wy > 0.031 && wy < 0.17) idx.push(i);
        }
        if (idx.length) car.verts.push({ col, idx, orig: idx.map((i) => [col.getX(i), col.getY(i), col.getZ(i)]) });
      });
    }
    const k = 1 - 0.85 * f;
    for (const v of car.verts) {
      v.idx.forEach((i, n) => v.col.setXYZ(i, v.orig[n][0] * k + 0.02 * f, v.orig[n][1] * k + 0.015 * f, v.orig[n][2] * k + 0.012 * f));
      v.col.needsUpdate = true;
    }
  }

  let ColorClass = null;
  function findColor() {
    if (ColorClass) return ColorClass;
    appScene.traverse((o) => { if (!ColorClass && o.material && !Array.isArray(o.material) && o.material.color && o.material.color.isColor) ColorClass = o.material.color.constructor; });
    return ColorClass;
  }

  // ---------- fire, smoke and debris (small cubes; they shrink instead of fading) ----------
  const particles = [];
  let cubeGeo = null; const partMats = {};
  const PALETTE = { spark: ['#fff3b0', '#ffd24a'], leaf: ['#7cbf3a', '#a6d84a', '#5e9d2e'], wood: ['#8a5a3b', '#a8754f', '#6e4529'], glass: ['#f3e3a6', '#ffffff', '#dfe8ee'], flash: ['#fff6c8'], fire: ['#fff3b0', '#ffd24a', '#ff9a2a', '#f0531f'], smoke: ['#3b3b3e', '#55565a', '#6e6f74'], debris: ['#2a2624', '#3a3532', '#5b5f66'],
    blacksmoke: ['#141416', '#1c1c1f', '#252528', '#2e2e31'], dust: ['#a89c8a', '#b9ad9b', '#9a8f80', '#c4b8a6', '#8f857a'] };
  // Puffs (o.fade): see-through low-poly balls that keep growing and fade out instead of shrinking.
  // Their opacity steps through FADE_LEVELS shared materials per colour (no material per puff).
  const FADE_LEVELS = 12, WIND = [0.09, 0.035];     // wind: tiles per second, stronger higher up
  let puffGeo = null, LambertClass = null; const fadeMats = {};
  function fadeMat(col, level) {
    const key = col + '|' + level;
    return fadeMats[key] || (fadeMats[key] = new (LambertClass || FlatMaterial)({ color: col, transparent: true, opacity: level / FADE_LEVELS, depthWrite: false }));
  }
  function makePuffGeo() {
    // icosahedron, radius 0.5, flat shaded
    const t = (1 + Math.sqrt(5)) / 2, V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
      .map((v) => { const l = Math.hypot(...v) * 2; return v.map((c) => c / l); });
    const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const P = [], N = [];
    for (const [a, b, c] of F) {
      const A = V[a], B = V[b], C = V[c];
      const n = [(B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]), (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]), (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])];
      const l = Math.hypot(...n) || 1;
      for (const v of [A, B, C]) { P.push(...v); N.push(n[0] / l, n[1] / l, n[2] / l); }
    }
    const g = new Geometry();
    g.setAttribute('position', new Attr(new Float32Array(P), 3));
    g.setAttribute('normal', new Attr(new Float32Array(N), 3));
    return g;
  }
  function spawn(kind, x, y, z, o) {
    if (!bulletParts()) return;
    if (!cubeGeo) {
      const P = [], N = [], h = 0.5;
      const quad = (a, b, c, e, n) => { for (const v of [a, b, c, a, c, e]) { P.push(...v); N.push(...n); } };
      quad([-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h], [0, 0, 1]); quad([h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h], [0, 0, -1]);
      quad([h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h], [1, 0, 0]); quad([-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h], [-1, 0, 0]);
      quad([-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h], [0, 1, 0]); quad([-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h], [0, -1, 0]);
      cubeGeo = new Geometry();
      cubeGeo.setAttribute('position', new Attr(new Float32Array(P), 3));
      cubeGeo.setAttribute('normal', new Attr(new Float32Array(N), 3));
    }
    const col = o.color || PALETTE[kind][Math.floor(Math.random() * PALETTE[kind].length)];
    if (o.fade && !puffGeo) puffGeo = makePuffGeo();
    const mat = o.fade ? fadeMat(col, 0) : partMats[col] || (partMats[col] = new FlatMaterial({ color: col }));
    const m = new MeshClass(o.fade ? puffGeo : cubeGeo, mat);
    m.position.set(x, y, z);
    m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    m.scale.setScalar(o.size);
    m.frustumCulled = false;
    appScene.add(m);
    if (o.fade) { m.castShadow = false; m.renderOrder = 2; }
    particles.push({ m, kind, col, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0, g: o.g || 0, size: o.size, grow: o.grow || 1, life: o.life, age: 0, land: o.land, spin: o.spin,
      fade: !!o.fade, alpha: o.alpha ?? 0.8, rise: o.rise ?? 0, drag: o.drag ?? 1, flat: o.flat || 1, turn: (Math.random() - 0.5) * 0.6, level: 0 });
  }

  let effectsOn = false, lastFx = 0;
  function startEffects() { if (!effectsOn) { effectsOn = true; lastFx = 0; requestAnimationFrame(effects); } }
  function effects(t) {
    const dt = Math.min(0.1, lastFx ? (t - lastFx) / 1000 : 0); lastFx = t;
    const now = performance.now();
    let busy = particles.length > 0;
    const index = trafficCars ? new Map(trafficCars.map((c, i) => [c, i])) : new Map();
    for (const [car, st] of damage) {
      if (!st.wreck) {
        if (st.fleeUntil && now > st.fleeUntil) {             // calmed down
          if (car.boost === CAR_FLEE_BOOST) car.boost = st.prevBoost;
          st.fleeUntil = 0;
        }
        if (st.fleeUntil) busy = true;
        continue;
      }
      busy = true;
      car.parked = Infinity; car.speed = 0;
      const i = index.get(car);
      const age = (now - st.t0) / 1000;
      // darken while it burns; afterwards only re-check once a second (the app may rebuild its car batches)
      if (i !== undefined && (age < 3 || now - (st.tintedAt || 0) > 1000)) { tintCar(i, Math.min(1, age / 2.5)); st.tintedAt = now; }
      if (car.isStatic && age < 3) tintParked(car, Math.min(1, age / 2.5));
      const heat = Math.max(0, 1 - age / CAR_BURN_SECONDS);   // fire dies down
      if (heat > 0 && dt > 0) {
        const c = Math.cos(-car.heading), s = Math.sin(-car.heading);
        const at = () => { const lx = (Math.random() - 0.5) * 0.18, lz = (Math.random() - 0.5) * 0.08; return [car.x + lx * c + lz * s, car.z - lx * s + lz * c]; };
        st.fireAt -= dt; st.smokeAt -= dt;
        while (st.fireAt <= 0) {
          st.fireAt += 0.05 / heat;
          const [x, z] = at();
          spawn('fire', x, 0.1 + Math.random() * 0.03, z, { vy: 0.2 + Math.random() * 0.25, vx: (Math.random() - 0.5) * 0.06, vz: (Math.random() - 0.5) * 0.06, size: (0.025 + Math.random() * 0.025) * (0.5 + heat / 2), life: 0.5 + Math.random() * 0.5 });
        }
        while (st.smokeAt <= 0) {
          const [x, z] = at();
          if (BLACK_SMOKE > 0) {
            // a column of black smoke: puffs rise at about `rise`, so their life sets the height
            st.smokeAt += 0.09 / (heat * BLACK_SMOKE);
            const rise = 0.35 + Math.random() * 0.2, life = SMOKE_HEIGHT / rise * (0.7 + Math.random() * 0.4) * (0.4 + 0.6 * heat);
            blackSmoke(x, 0.13, z, { vy: 0.3 + Math.random() * 0.2, rise, vx: (Math.random() - 0.5) * 0.06, vz: (Math.random() - 0.5) * 0.06, size: (0.04 + Math.random() * 0.03) * (0.6 + 0.4 * heat), life, alpha: 0.85 * (0.5 + 0.5 * heat) });
          } else {
            st.smokeAt += 0.16 / heat;
            spawn('smoke', x, 0.14, z, { vy: 0.12 + Math.random() * 0.12, vx: 0.03 + (Math.random() - 0.5) * 0.05, vz: (Math.random() - 0.5) * 0.05, size: 0.035, grow: 3, life: 3 + Math.random() * 1.5 });
          }
        }
      }
    }
    for (let k = particles.length - 1; k >= 0; k--) {
      const p = particles[k];
      p.age += dt;
      const f = p.age / p.life;
      if (f >= 1) { p.m.removeFromParent(); particles.splice(k, 1); continue; }
      if (p.fade) { stepPuff(p, f, dt); continue; }
      p.vy -= p.g * dt;
      p.m.position.x += p.vx * dt; p.m.position.y += p.vy * dt; p.m.position.z += p.vz * dt;
      if (p.land && p.m.position.y < 0.045) { p.m.position.y = 0.045; p.vx *= 0.5; p.vz *= 0.5; p.vy = Math.abs(p.vy) * 0.25; }
      if (p.spin) { p.m.rotation.x += dt * 6; p.m.rotation.y += dt * 4; }
      const grown = p.size * (1 + (p.grow - 1) * f);
      const fade = p.kind === 'debris' ? (f < 0.8 ? 1 : (1 - f) / 0.2) : 1 - f * f;
      p.m.scale.setScalar(Math.max(1e-4, grown * fade));
    }
    if (busy) requestAnimationFrame(effects); else effectsOn = false;
  }

  function stepPuff(p, f, dt) {
    const m = p.m, k = Math.exp(-p.drag * dt), wind = 0.4 + Math.max(0, m.position.y) * 0.35;
    p.vx = p.vx * k + WIND[0] * wind * (1 - k);
    p.vz = p.vz * k + WIND[1] * wind * (1 - k);
    p.vy = p.vy * k + p.rise * (1 - k);
    m.position.x += p.vx * dt; m.position.y += p.vy * dt; m.position.z += p.vz * dt;
    m.rotation.y += p.turn * dt;
    const s = p.size * (1 + (p.grow - 1) * (1 - (1 - f) * (1 - f)));   // grows fast, then slowly
    m.scale.set(s, s / p.flat, s);
    const floor = 0.04 + s / p.flat * 0.3;                              // rolls over the ground, not through it
    if (m.position.y < floor) { m.position.y = floor; if (p.vy < 0) p.vy = 0; }
    const level = Math.round(p.alpha * Math.min(1, f / 0.06) * Math.pow(1 - f, 1.6) * FADE_LEVELS);
    if (level !== p.level) { p.level = level; m.visible = level > 0; if (level > 0) m.material = fadeMat(p.col, level); }
  }

  // ---------- bullets ----------
  const bullets = [];
  let bulletGeo = null, bulletMat = null, MeshClass = null, FlatMaterial = null, Geometry = null, Attr = null;
  function bulletParts() {
    if (bulletGeo) return true;
    let mesh = null, basic = null, lambert = null;
    appScene.traverse((o) => {
      if (!mesh && o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh && o.geometry && o.geometry.attributes.position) mesh = o;
      const m = o.material;
      if (m && !Array.isArray(m)) { if (!basic && m.isMeshBasicMaterial) basic = m; if (!lambert && m.isMeshLambertMaterial) lambert = m; }
    });
    if (!mesh || !(basic || lambert)) return false;
    MeshClass = mesh.constructor;
    let proto = Object.getPrototypeOf(mesh.geometry);
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'translate')) proto = Object.getPrototypeOf(proto);
    Geometry = proto.constructor; Attr = mesh.geometry.attributes.position.constructor;
    FlatMaterial = (basic || lambert).constructor;
    LambertClass = lambert && lambert.constructor;
    // a small grey slug, stretched along its flight direction (+z) so it reads as a fast streak
    const w = BULLET_SIZE / 2, l = BULLET_LENGTH / 2, P = [], N = [];
    const quad = (a, b, c, e, n) => { for (const v of [a, b, c, a, c, e]) { P.push(...v); N.push(...n); } };
    quad([-w, -w, l], [w, -w, l], [w, w, l], [-w, w, l], [0, 0, 1]);
    quad([w, -w, -l], [-w, -w, -l], [-w, w, -l], [w, w, -l], [0, 0, -1]);
    quad([w, -w, l], [w, -w, -l], [w, w, -l], [w, w, l], [1, 0, 0]);
    quad([-w, -w, -l], [-w, -w, l], [-w, w, l], [-w, w, -l], [-1, 0, 0]);
    quad([-w, w, l], [w, w, l], [w, w, -l], [-w, w, -l], [0, 1, 0]);
    quad([-w, -w, -l], [w, -w, -l], [w, -w, l], [-w, -w, l], [0, -1, 0]);
    bulletGeo = new Geometry();
    bulletGeo.setAttribute('position', new Attr(new Float32Array(P), 3));
    bulletGeo.setAttribute('normal', new Attr(new Float32Array(N), 3));
    bulletMat = new (basic || lambert).constructor({ color: '#8d9299' });
    return true;
  }

  // Nearest building surface along the ray: { t, n } (n = surface normal facing the shooter).
  // Möller–Trumbore against the triangles of every building part whose box the ray crosses.
  function rayBuildings(o, d, maxT) {
    if (!appScene) return null;
    let best = null;
    eachMesh(buildingGroups(), (mesh, mw) => {
      const g = mesh.geometry, pos = g.attributes.position, idx = g.index, e = mw.elements;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      const tx = (x, y, z, out) => { out[0] = e[0] * x + e[4] * y + e[8] * z + e[12]; out[1] = e[1] * x + e[5] * y + e[9] * z + e[13]; out[2] = e[2] * x + e[6] * y + e[10] * z + e[14]; };
      // world box of this part, and whether the ray passes through it
      const c = [0, 0, 0], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < 8; i++) {
        tx(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z, c);
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], c[k]); hi[k] = Math.max(hi[k], c[k]); }
      }
      const O = [o.x, o.y, o.z], D = [d.x, d.y, d.z];
      let t0 = 0, t1 = best ? best.t : maxT;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(D[k]) < 1e-12) { if (O[k] < lo[k] || O[k] > hi[k]) return; continue; }
        let a = (lo[k] - O[k]) / D[k], b = (hi[k] - O[k]) / D[k]; if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) return;
      }
      const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i < n; i += 3) {
        const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1, ic = idx ? idx.getX(i + 2) : i + 2;
        tx(pos.getX(ia), pos.getY(ia), pos.getZ(ia), A); tx(pos.getX(ib), pos.getY(ib), pos.getZ(ib), B); tx(pos.getX(ic), pos.getY(ic), pos.getZ(ic), C);
        const e1x = B[0] - A[0], e1y = B[1] - A[1], e1z = B[2] - A[2], e2x = C[0] - A[0], e2y = C[1] - A[1], e2z = C[2] - A[2];
        const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
        const det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det, sx = o.x - A[0], sy = o.y - A[1], sz = o.z - A[2];
        const u = (sx * px + sy * py + sz * pz) * inv; if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (d.x * qx + d.y * qy + d.z * qz) * inv; if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t <= 1e-4 || t >= (best ? best.t : maxT)) continue;
        let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        if (nx * d.x + ny * d.y + nz * d.z > 0) { nx = -nx; ny = -ny; nz = -nz; }   // face the shooter
        best = { t, n: { x: nx, y: ny, z: nz } };
      }
    });
    return best;
  }

  // ---------- bullet holes ----------
  const holes = [];
  let holeGeo = null, holeMat = null;
  function addHole(p, n) {
    if (!bulletParts()) return;
    if (!holeGeo) {
      // a small dark disc (8 segments) facing +z
      const r = HOLE_SIZE / 2, P = [], N = [];
      for (let i = 0; i < 8; i++) {
        const a0 = (i / 8) * Math.PI * 2, a1 = ((i + 1) / 8) * Math.PI * 2;
        P.push(0, 0, 0, r * Math.cos(a0), r * Math.sin(a0), 0, r * Math.cos(a1), r * Math.sin(a1), 0);
        N.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
      }
      holeGeo = new Geometry();
      holeGeo.setAttribute('position', new Attr(new Float32Array(P), 3));
      holeGeo.setAttribute('normal', new Attr(new Float32Array(N), 3));
      holeMat = new FlatMaterial({ color: '#2a2b2f', polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    }
    const m = new MeshClass(holeGeo, holeMat);
    m.position.set(p.x + n.x * 0.0015, p.y + n.y * 0.0015, p.z + n.z * 0.0015);
    m.lookAt(p.x + n.x, p.y + n.y, p.z + n.z);
    m.rotateZ(Math.random() * Math.PI);                 // not every octagon the same way up
    appScene.add(m);
    holes.push(m);
    while (holes.length > MAX_HOLES) holes.shift().removeFromParent();
  }

  function fire(start, end, onArrive) {
    const len = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
    if (!bulletParts() || len < 0.01) { onArrive(); return; }
    const mesh = new MeshClass(bulletGeo, bulletMat);
    mesh.position.set(start.x, start.y, start.z);
    mesh.lookAt(end.x, end.y, end.z);
    mesh.frustumCulled = false;
    appScene.add(mesh);
    bullets.push({ mesh, start, dir: { x: (end.x - start.x) / len, y: (end.y - start.y) / len, z: (end.z - start.z) / len }, len, t: 0, onArrive });
  }

  function stepBullets(dt) {
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.t = Math.min(b.len, b.t + BULLET_SPEED * dt);
      b.mesh.position.set(b.start.x + b.dir.x * b.t, b.start.y + b.dir.y * b.t, b.start.z + b.dir.z * b.t);
      if (b.t >= b.len) { b.mesh.removeFromParent(); bullets.splice(i, 1); b.onArrive(); }
    }
  }
  function clearBullets() {
    for (const b of bullets) b.mesh.removeFromParent();
    bullets.length = 0;
  }


  // ---------- weapons in view ----------
  // Drawn after the city in its own little scene with its own camera, on a cleared depth buffer,
  // like in shooters: they never stick into walls and always have the same size. No lights: the
  // shading is baked into the vertex colours, so only Mesh + a flat material are needed.
  // Model units: the pistol is 0.2 long; muzzles point towards -z.
  const gunMotion = { dt: 0, moved: 0, lookX: 0, lookY: 0 };
  let gun = null, gunFailed = false;
  const WEAPONS = {
    // at: where it sits in front of the eye; aim: the barrel points at the crosshair this far ahead
    // (any distance lands on the crosshair; nearer = turned more, so you see more of its side);
    // roll: slight tilt around the barrel; muzzle: muzzle position on the model
    pistol: { name: 'Pistool', at: [0.12, -0.115, -0.29], aim: 1.0, roll: -0.04, muzzle: [0, 0.019, -0.21], kick: 1 },
    minigun: { name: 'Minigun', at: [0.15, -0.14, -0.36], aim: 0.9, roll: -0.05, muzzle: [0, 0, -0.45], kick: 0.25 },
  };
  const WEAPON_KEYS = { Digit1: 'pistol', Digit2: 'minigun' };
  let weapon = 'pistol', shown = 'pistol', swap = 0;    // swap: 0 = up and ready … 1 = lowered out of view
  let trigger = false, spin = 0, spinAngle = 0, fireAcc = 0;

  // Yaw and pitch that make the barrel's axis (through the muzzle, along -z) pass through the point
  // (0, 0, -aim) straight ahead, which is drawn at the crosshair. A few rounds of refining, as the
  // muzzle's height above the gun's origin turns with it.
  function aimTurn(W) {
    if (W.turn) return W.turn;
    let yaw = 0, pitch = 0;
    for (let k = 0; k < 6; k++) {
      const h = W.muzzle[1];   // barrel axis offset above the origin; rotate (0, h, 0) by pitch then yaw
      const oy = h * Math.cos(pitch), oz0 = h * Math.sin(pitch);
      const ox = oz0 * Math.sin(yaw), oz = oz0 * Math.cos(yaw);
      const dx = 0 - (W.at[0] + ox), dy = 0 - (W.at[1] + oy), dz = -W.aim - (W.at[2] + oz);
      const l = Math.hypot(dx, dy, dz);
      yaw = Math.atan2(-dx / l, -dz / l); pitch = Math.asin(dy / l);
    }
    return (W.turn = [pitch, yaw, W.roll]);
  }

  // ---- weapons from other scripts ----
  // window.scWalkWeapons.push({ id, name, key: 'Digit3', at, aim, roll, muzzle, kick, interval,
  //   build(tools) → { root, flash? }, fire({ o, d, start }) })   – see the rocket launcher script.
  function addWeapon(def) {
    if (!def || !def.id || WEAPONS[def.id]) return;
    WEAPONS[def.id] = { name: def.name || def.id, at: def.at || [0.13, -0.13, -0.32], aim: def.aim || 1, roll: def.roll || 0,
      muzzle: def.muzzle || [0, 0, -0.3], kick: def.kick ?? 1, plugin: def };
    if (def.key) WEAPON_KEYS[def.key] = def.id;
    gun = null;                                                   // build the models again, with this one
  }
  const pluginShot = {};
  function firePlugin(id) {
    const W = WEAPONS[id], def = W.plugin;
    if (swap > 0.3 || shown !== id) return;
    const now = performance.now();
    if (now - (pluginShot[id] || 0) < (def.interval || 0.5) * 1000) return;
    pluginShot[id] = now;
    const o = { x: pos.x, y: eye, z: pos.z };
    const d = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
    gunFired();
    if (window.scResidents && typeof window.scResidents.alarm === 'function') window.scResidents.alarm(o.x, o.z, SHOT_PANIC_RADIUS * 2, SHOT_PANIC_SECONDS);
    shotEvent(o, id);
    try { def.fire({ o, d, start: muzzleWorld(o) || { x: o.x + d.x * 0.05, y: o.y - 0.02 + d.y * 0.05, z: o.z + d.z * 0.05 } }); } catch (e) { console.warn('[walk] weapon', id, e); }
  }
  function shotEvent(o, weapon) { window.dispatchEvent(new CustomEvent('sc:shot', { detail: { x: o.x, y: o.y, z: o.z, weapon } })); }
  // Other scripts can add things you can shoot: { hit(o, d, maxT) → { t, … } | null, onHit(h, d, weapon) }.
  const targets = [];
  function hitTargets(o, d, maxT) {
    let best = null;
    for (const tg of targets) {
      let h = null;
      try { h = tg.hit(o, d, best ? best.t : maxT); } catch (e) { console.warn('[walk] target', e); }
      if (h && h.t > 0 && h.t < (best ? best.t : maxT)) best = { t: h.t, h, target: tg };
    }
    return best;
  }
  // what other scripts may use
  window.scWalk = {
    get player() { return { x: pos.x, y: eye, z: pos.z, yaw, pitch }; },
    leave: () => leave(),
    moveTo(x, z) { pos.x = x; pos.z = z; },
    lookAt(x, y, z) { const dx = x - pos.x, dz = z - pos.z; yaw = Math.atan2(-dx, -dz); pitch = Math.atan2(y - eye, Math.hypot(dx, dz)); },
    blocked: (x, z) => blocked(x, z),
    addTarget(t) { if (t && typeof t.hit === 'function' && typeof t.onHit === 'function') targets.push(t); },
    hitTargets: (o, d, max) => hitTargets(o, d, max),
    tracer: (start, end, onArrive) => fire(start, end, onArrive || (() => {})),
    blackSmoke: (x, y, z, o) => blackSmoke(x, y, z, o || {}),
    blastEvent: (x, z, gib, knock, panic) => blastEvent(x, z, gib, knock, panic),
    get walking() { return walking; },
    get scene() { return appScene; },
    classes() {
      if (!appScene || !bulletParts()) return null;
      return { Mesh: MeshClass, Geometry, Attr, Basic: FlatMaterial, Color: findColorClass(), M4: appCamera.matrixWorld.constructor, V3: cam.position.constructor, Q: cam.quaternion.constructor };
    },
    rayBuildings: (o, d, max) => rayBuildings(o, d, max),
    hitCar: (o, d, max) => (SHOOT_CARS ? hitCar(o, d, max) : null),
    hitProp: (o, d, max) => (DESTRUCTIBLE_PROPS ? hitProp(o, d, max) : null),
    carObjects: () => carObjects(),
    trafficCars: () => trafficCars,
    wreck(car) { let st = damage.get(car); if (!st) damage.set(car, (st = { hits: 0 })); if (!st.wreck) carExploded(car, car.x, car.z); st.wreck = true; st.t0 = performance.now() - CAR_BURN_SECONDS * 1000; car.parked = Infinity; car.speed = 0; },
    propsNear(x, z, r) { return [...props.values()].filter((p) => p.state === 'up' && Math.hypot(p.x - x, p.z - z) <= r); },
    knockProp(p, d) { if (p.state !== 'up') return; p.hits = Math.max(p.hits, PROP_HITS - 1); damageProp(p, d, { x: p.x, y: p.y0 + 0.05, z: p.z }); },
    spawn: (kind, x, y, z, o) => spawn(kind, x, y, z, o),
    startEffects: () => startEffects(),
    sound: (kind) => sound(kind),
    blastResidents(x, z, gib = 0) { blastEvent(x, z, gib, BLAST_KNOCK_RADIUS, BLAST_PANIC_RADIUS); const r = window.scResidents; if (r && r.blast) return r.blast(x, z, BLAST_KNOCK_RADIUS, BLAST_PANIC_RADIUS, PANIC_SECONDS); },
  };
  { const queued = Array.isArray(window.scWalkWeapons) ? window.scWalkWeapons : []; window.scWalkWeapons = { push: (d) => addWeapon(d) }; queued.forEach(addWeapon); }

  function selectWeapon(w) {
    if (!WEAPONS[w] || w === weapon) return;
    weapon = w;
    flash(WEAPONS[w].name);
  }

  function makeGun() {
    if (!bulletParts()) return null;
    const Color = findColorClass();
    if (!Color) return null;
    const c = new Color();
    const L = [-0.35, 0.85, 0.4], ll = Math.hypot(...L); L[0] /= ll; L[1] /= ll; L[2] /= ll;
    function builder() {
      const P = [], C = [];
      return {
        P, C,
        // box centred at (x, y, z), size (w, h, d), turned `roll` radians around z, then tilted `tilt` around x
        box(x, y, z, w, h, d, hex, tilt = 0, roll = 0) {
          c.set(hex);
          const hx = w / 2, hy = h / 2, hz = d / 2, ct = Math.cos(tilt), st = Math.sin(tilt), cr = Math.cos(roll), sr = Math.sin(roll);
          const rot = (v) => { const a = v[0] * cr - v[1] * sr, b = v[0] * sr + v[1] * cr; return [a, b * ct - v[2] * st, b * st + v[2] * ct]; };
          const quad = (a, b, e, f, n) => {
            const rn = rot(n), k = 0.3 + 0.7 * Math.max(0, rn[0] * L[0] + rn[1] * L[1] + rn[2] * L[2]);
            for (const v of [a, b, e, a, e, f]) {
              const r = rot([v[0] * hx, v[1] * hy, v[2] * hz]);
              P.push(x + r[0], y + r[1], z + r[2]); C.push(c.r * k, c.g * k, c.b * k);
            }
          };
          quad([-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1], [0, 0, 1]);
          quad([1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1], [0, 0, -1]);
          quad([1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1], [1, 0, 0]);
          quad([-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, 0, 0]);
          quad([-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1], [0, 1, 0]);
          quad([-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [0, -1, 0]);
        },
        // prism along z: a regular polygon with `sides` corners (first corner on +x), circumradius r, length d
        prism(x, y, z, r, d, sides, hex) {
          c.set(hex);
          const shade = (nx, ny, nz) => 0.3 + 0.7 * Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
          const tri = (a, b, e, k) => { for (const v of [a, b, e]) { P.push(x + v[0], y + v[1], z + v[2]); C.push(c.r * k, c.g * k, c.b * k); } };
          const z0 = -d / 2, z1 = d / 2;
          for (let i = 0; i < sides; i++) {
            const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2, am = (a0 + a1) / 2;
            const p0 = [Math.cos(a0) * r, Math.sin(a0) * r], p1 = [Math.cos(a1) * r, Math.sin(a1) * r];
            const k = shade(Math.cos(am), Math.sin(am), 0);
            tri([p0[0], p0[1], z0], [p1[0], p1[1], z0], [p1[0], p1[1], z1], k);
            tri([p0[0], p0[1], z0], [p1[0], p1[1], z1], [p0[0], p0[1], z1], k);
            tri([0, 0, z1], [p0[0], p0[1], z1], [p1[0], p1[1], z1], shade(0, 0, 1));
            tri([0, 0, z0], [p1[0], p1[1], z0], [p0[0], p0[1], z0], shade(0, 0, -1));
          }
        },
      };
    }
    const mat = new FlatMaterial({ vertexColors: true, side: 2, fog: false });
    const mesh = (b, m = mat) => {
      const g = new Geometry();
      g.setAttribute('position', new Attr(new Float32Array(b.P), 3));
      g.setAttribute('color', new Attr(new Float32Array(b.C), 3));
      const o = new MeshClass(g, m); o.frustumCulled = false; return o;
    };
    const METAL = '#2c3036', DARK = '#1b1d21', GRIP = '#202226', SKIN = '#c99a7a', SLEEVE = '#34445a';
    const flashMat = new FlatMaterial({ vertexColors: true, side: 2, fog: false, transparent: true, depthWrite: false, blending: 2 });
    const makeFlash = (size) => {
      const fl = builder(), s = size;
      fl.box(0, 0, -0.04 * s, 0.07 * s, 0.016 * s, 0.08 * s, '#ffc45e');
      fl.box(0, 0, -0.04 * s, 0.016 * s, 0.07 * s, 0.08 * s, '#ffc45e');
      fl.box(0, 0, -0.01 * s, 0.05 * s, 0.05 * s, 0.002, '#fff2c0');
      const f = mesh(fl, flashMat); f.visible = false; return f;
    };

    // ---- pistol ----
    const body = builder();
    body.box(0, -0.007, -0.085, 0.03, 0.022, 0.17, DARK);                 // frame under the slide
    body.box(0, -0.016, -0.15, 0.022, 0.008, 0.05, METAL);               // accessory rail
    body.box(0, -0.07, -0.006, 0.031, 0.11, 0.044, GRIP, -0.28);          // grip, raked back
    body.box(0, -0.039, -0.08, 0.011, 0.005, 0.058, DARK);                // trigger guard: bottom…
    body.box(0, -0.028, -0.108, 0.011, 0.025, 0.005, DARK);               // …and front
    body.box(0, -0.026, -0.072, 0.005, 0.018, 0.006, '#4a4e55', 0.25);    // trigger
    body.box(0.001, -0.068, 0.002, 0.044, 0.08, 0.056, SKIN, -0.28);      // hand around the grip
    body.box(0.001, -0.074, -0.034, 0.042, 0.05, 0.022, SKIN, -0.28);     // fingers in front of it
    body.box(-0.02, -0.03, -0.012, 0.012, 0.03, 0.03, SKIN, -0.28);       // ball of the thumb…
    body.box(-0.0195, -0.013, -0.045, 0.011, 0.013, 0.05, SKIN);          // …and the thumb along the frame
    body.box(0.002, -0.12, 0.03, 0.04, 0.045, 0.035, SKIN, 0.2);          // wrist
    body.box(0.006, -0.16, 0.12, 0.062, 0.065, 0.17, SLEEVE, 0.32);       // sleeve, out of view
    const pistol = mesh(body);
    const sl = builder();                                                 // the slide moves back when firing
    sl.box(0, 0.021, -0.1, 0.033, 0.034, 0.2, METAL);
    for (let i = 0; i < 5; i++) for (const sx of [-1, 1])                 // grip serrations at the back
      sl.box(sx * 0.0168, 0.021, -0.012 - i * 0.008, 0.0015, 0.026, 0.0035, DARK);
    sl.box(0.0168, 0.03, -0.075, 0.0015, 0.012, 0.035, '#121315');        // ejection port
    sl.box(0, 0.0405, -0.19, 0.005, 0.007, 0.01, DARK);                   // front sight
    sl.box(-0.009, 0.041, -0.012, 0.007, 0.008, 0.008, DARK);             // rear sight (two posts)
    sl.box(0.009, 0.041, -0.012, 0.007, 0.008, 0.008, DARK);
    sl.box(0, 0.019, -0.2015, 0.015, 0.015, 0.004, '#5a6068');           // barrel end
    sl.box(0, 0.019, -0.2035, 0.008, 0.008, 0.001, '#050505');           // bore
    const slide = mesh(sl);
    pistol.add(slide);
    const pistolFlash = makeFlash(1);
    pistolFlash.position.set(...WEAPONS.pistol.muzzle);
    pistol.add(pistolFlash);

    // ---- minigun: six barrels that spin around the gun's axis (z), housing, carry handle, ammo belt ----
    const mg = builder();
    mg.box(0, 0, -0.005, 0.085, 0.085, 0.13, METAL);                      // housing
    mg.box(0, 0, 0.065, 0.07, 0.07, 0.012, DARK);                         // back plate
    mg.box(0.052, 0.01, 0.0, 0.03, 0.05, 0.09, DARK);                     // motor on the right
    mg.box(0, 0.06, -0.06, 0.012, 0.035, 0.012, DARK);                    // carry handle: front post…
    mg.box(0, 0.06, 0.04, 0.012, 0.035, 0.012, DARK);                     // …back post…
    mg.box(0, 0.08, -0.01, 0.014, 0.012, 0.12, GRIP);                     // …and bar
    mg.box(-0.047, -0.01, -0.01, 0.012, 0.04, 0.05, DARK);                // feed chute on the left
    // Ammo belt hanging down to the left: cartridges lie side by side along the gun's axis, the belt
    // curves down from the feed chute. Spaced so nothing overlaps: the two links of each cartridge
    // wrap round it, the cartridge shows between them, the bullet tip sticks out at the front.
    {
      let bx = -0.063, by = -0.039, ang = -2.2;                           // heading: down and to the left
      for (let i = 0; i < 14; i++) {
        const roll = ang + Math.PI / 2;                                   // cartridge cross-section turned with the belt
        mg.box(bx, by, -0.006, 0.0075, 0.0075, 0.042, '#c8a24a', 0, roll);          // brass case
        mg.box(bx, by, -0.0315, 0.0055, 0.0055, 0.009, '#9a5a2e', 0, roll);         // copper bullet tip
        for (const lz of [-0.016, 0.006]) mg.box(bx, by, lz, 0.0095, 0.0095, 0.006, '#3a3328', 0, roll);   // links
        bx += Math.cos(ang) * 0.0115; by += Math.sin(ang) * 0.0115;
        ang = Math.max(-1.75, ang + 0.05);                                // straightening out, hanging down
      }
    }
    mg.box(0, -0.065, 0.03, 0.03, 0.08, 0.04, GRIP, -0.3);                // pistol grip below
    mg.box(0.002, -0.075, 0.036, 0.044, 0.065, 0.054, SKIN, -0.3);        // hand
    mg.box(0.004, -0.125, 0.09, 0.064, 0.068, 0.16, SLEEVE, 0.45);        // sleeve
    const minigun = mesh(mg);
    const br = builder();
    const R = 0.024;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2, x = Math.cos(a) * R, y = Math.sin(a) * R;
      br.box(x, y, -0.25, 0.009, 0.009, 0.36, i % 2 ? '#3a3f46' : '#30343a');   // barrel
      br.box(x, y, -0.4305, 0.005, 0.005, 0.002, '#050505');                      // bore
    }
    br.prism(0, 0, -0.13, 0.039, 0.014, 6, DARK);                         // hexagonal barrel clamps (rotate along)…
    br.prism(0, 0, -0.33, 0.037, 0.012, 6, DARK);                         // …corners on the barrels
    br.prism(0, 0, -0.25, 0.01, 0.36, 6, '#16181b');                      // central spindle
    const barrels = mesh(br);
    minigun.add(barrels);
    const mgFlash = makeFlash(1.6);
    mgFlash.position.set(...WEAPONS.minigun.muzzle);
    minigun.add(mgFlash);

    const scene = new appScene.constructor();
    pistol.rotation.order = minigun.rotation.order = 'YXZ';   // yaw, then pitch, then roll around the barrel
    scene.add(pistol, minigun);
    // weapons from other scripts: they build their model with the same tools
    const models = { pistol: { root: pistol, flash: pistolFlash, slide }, minigun: { root: minigun, flash: mgFlash, barrels } };
    for (const [id, W] of Object.entries(WEAPONS)) {
      if (!W.plugin) continue;
      try {
        const r = W.plugin.build({ builder, mesh, makeFlash, colors: { METAL, DARK, GRIP, SKIN, SLEEVE } }) || {};
        if (!r.root) continue;
        const fl = r.flash || makeFlash(1);
        fl.position.set(...W.muzzle);
        if (!fl.parent) r.root.add(fl);
        r.root.rotation.order = 'YXZ';
        scene.add(r.root);
        models[id] = { ...r, root: r.root, flash: fl };
      } catch (e) { console.warn('[walk] weapon', id, e); }
    }
    if (!mat.isMeshBasicMaterial) {   // only a lit material was found: give the gun scene a plain white light
      let light = null;
      appScene.traverse((o) => {
        if (light) return;
        if (o.isAmbientLight) light = new o.constructor('#ffffff', 1);
        else if (o.isHemisphereLight) light = new o.constructor('#ffffff', '#ffffff', 1);
      });
      if (light) scene.add(light);
    }
    const gcam = new cam.constructor(FOV, 1, 0.01, 10);
    return {
      scene, cam: gcam, shotAt: -1, phase: 0, walk: 0, sx: 0, sy: 0,
      models,
    };
  }

  function gunFired() {
    if (!gun) return;
    gun.shotAt = 0;
    const f = gun.models[shown].flash;
    f.rotation.z = Math.random() * Math.PI;
  }

  // Called every frame from stepWalk: spins the minigun and fires it while the button is held.
  function stepWeapons(dt) {
    const held = trigger && weapon === 'minigun' && shown === 'minigun' && swap < 0.3;
    spin = held ? Math.min(1, spin + dt / MINIGUN_SPINUP) : Math.max(0, spin - dt / MINIGUN_SPINDOWN);
    spinAngle += spin * MINIGUN_SPIN_SPEED * dt;
    whir(spin);
    if (held && spin >= 1) {
      fireAcc += dt * MINIGUN_RATE;
      while (fireAcc >= 1) { fireAcc -= 1; shoot('minigun'); }
    } else fireAcc = Math.min(fireAcc, 1);
  }

  function updateGun() {
    const g = gun, m = gunMotion, dt = m.dt;
    // switching: lower the current weapon, swap, raise the new one
    if (shown !== weapon) { swap = Math.min(1, swap + dt / 0.2); if (swap >= 1) { shown = weapon; g.shotAt = -1; } }
    else swap = Math.max(0, swap - dt / 0.25);
    if (!g.models[shown]) shown = weapon = 'pistol';
    const W = WEAPONS[shown], model = g.models[shown];
    for (const k in g.models) g.models[k].root.visible = k === shown;
    // recoil: snaps back and up in 30 ms, settles in ~0.2 s
    let kick = 0, back = 0;
    if (g.shotAt >= 0) {
      const t = (g.shotAt += dt);
      kick = t < 0.03 ? t / 0.03 : Math.exp(-(t - 0.03) / 0.06);
      back = t < 0.02 ? t / 0.02 : t < 0.05 ? 1 : Math.max(0, 1 - (t - 0.05) / 0.05);
      model.flash.visible = t < (shown === 'minigun' ? 0.03 : 0.045);
      model.flash.scale.setScalar(0.8 + 0.5 * Math.random());
      if (t > 0.6) g.shotAt = -1;
    } else model.flash.visible = false;
    kick *= W.kick;
    if (model.slide) model.slide.position.z = 0.04 * back;
    let shake = 0;
    if (model.barrels) {
      model.barrels.rotation.z = spinAngle;
      shake = spin * (trigger && shown === 'minigun' && spin >= 1 ? 0.004 : 0.0012);   // the whole gun hums and judders
    }
    // walking bob and look lag
    const moving = dt > 0 ? Math.min(1, m.moved / dt / 0.6) : 0;
    g.walk += (moving - g.walk) * Math.min(1, dt * 8);
    g.phase += m.moved / 0.09 * Math.PI;
    const lag = Math.min(1, dt * 10);
    g.sx += (Math.max(-60, Math.min(60, m.lookX)) * 0.0004 - g.sx) * lag;
    g.sy += (Math.max(-60, Math.min(60, m.lookY)) * 0.0004 - g.sy) * lag;
    m.lookX = m.lookY = m.moved = 0;
    const b = GUN_BOB, j = () => (Math.random() * 2 - 1) * shake;
    const s = swap * swap;
    g.models[shown].root.position.set(
      W.at[0] + b * (Math.sin(g.phase) * 0.006 * g.walk - g.sx) + j(),
      W.at[1] + b * (-Math.abs(Math.cos(g.phase)) * 0.005 * g.walk + g.sy) + kick * 0.008 + j() - s * 0.25,
      W.at[2] + kick * 0.035 + j());
    const turn = aimTurn(W);
    g.models[shown].root.rotation.set(turn[0] + kick * 0.22 - s * 0.6, turn[1] + b * g.sx * 2, turn[2] + b * Math.sin(g.phase) * 0.02 * g.walk);
    const el = renderer.domElement;
    g.cam.aspect = (el.clientWidth || 1) / (el.clientHeight || 1);
    g.cam.updateProjectionMatrix();
  }

  function drawGun(render) {
    if (!SHOW_GUN || !SHOOTING || gunFailed) return;
    try {
      if (!gun) { gun = makeGun(); if (!gun) return; }
      updateGun();
      const ac = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clearDepth();
      try { render(gun.scene, gun.cam); } finally { renderer.autoClear = ac; }
    } catch (e) { gunFailed = true; console.warn('[walk] weapons', e); }
  }

  // Where the bullet starts: just in front of the drawn muzzle, in the same direction from the eye.
  function muzzleWorld(o) {
    if (!gun) return null;
    const f = gun.models[shown].flash;
    f.parent.updateMatrixWorld();
    const v = f.getWorldPosition(new (cam.position.constructor)());
    v.normalize().applyQuaternion(cam.quaternion).multiplyScalar(0.05);
    return { x: o.x + v.x, y: o.y + v.y, z: o.z + v.z };
  }

  // the minigun's motor: a low hum that rises with the spin
  let whirNodes = null;
  function whir(level) {
    if (!SOUND || (!whirNodes && level <= 0)) return;
    try {
      audio = audio || new AudioContext();
      if (!whirNodes) {
        const osc = audio.createOscillator(), f = audio.createBiquadFilter(), g = audio.createGain();
        osc.type = 'sawtooth'; f.type = 'lowpass'; f.frequency.value = 900; g.gain.value = 0;
        osc.connect(f); f.connect(g); g.connect(audio.destination); osc.start();
        whirNodes = { osc, g };
      }
      const t = audio.currentTime;
      whirNodes.osc.frequency.setTargetAtTime(45 + 170 * level, t, 0.03);
      whirNodes.g.gain.setTargetAtTime(0.07 * level, t, 0.03);
    } catch {}
  }

  const rnd = (a, b) => a + Math.random() * (b - a);
  // ---------- trees and lamps ----------
  // Three kinds of props, found by their shape and colour in what the app draws:
  // - trees on open land: separate instanced trunks + crowns (one instance per tree);
  // - trees on lots and squares: a brown trunk block with two green crown balls, merged into a
  //   bigger mesh (a city block, a square) – and again in the building's own hidden copy;
  // - street lamps: a grey post with a light-yellow lamp head, merged into the squares' mesh.
  // First hit: the prop shakes. PROP_HITS hits: it snaps at the foot and falls over, away from you,
  // and stays down. Merged props are cut out of their mesh into a mesh of their own to fall.
  const props = new Map();          // key → prop
  const fallen = new Map();         // key → { axis, angle } of props that went down (to redo after a rebuild)
  let propSig = '', propsAt = 0;
  const propKey = (kind, x, z) => kind + ':' + Math.round(x * 50) + ',' + Math.round(z * 50);
  const isOurs = (o) => { for (let p = o; p; p = p.parent) if ((p.userData && (p.userData.scProp || p.userData.scNuke)) || p.name === 'sc-residents' || p.name === 'sc-nuke') return true; return false; };

  function scanProps() {
    if (!DESTRUCTIBLE_PROPS || !appScene || !bulletParts()) return;
    const C = findColorClass(); if (!C) return;
    const meshes = [], inst = [];
    appScene.traverse((o) => {
      if (isOurs(o)) return;
      if (o.isInstancedMesh) { const p = o.geometry && o.geometry.parameters; if (p && Math.abs(p.width - 0.045) < 1e-4 && Math.abs(p.height - 0.12) < 1e-4) inst.push(o); return; }
      if (o.isMesh && o.geometry && !o.geometry.index && o.geometry.attributes.color && o.geometry.attributes.position) meshes.push(o);
    });
    const sig = meshes.map((m) => m.geometry.uuid).join() + '|' + inst.map((m) => m.uuid).join();
    if (sig === propSig) return;
    propSig = sig;
    const old = props; const next = new Map();
    const lin = (hex) => { const c = new C(hex); return [c.r, c.g, c.b]; };
    const POLE = lin('#4b5058'), LAMP = lin('#f3e3a6'), TRUNK = lin('#8a5a3b');
    const add = (key, make) => { let p = next.get(key); if (!p) { const before = old.get(key); p = make(); if (before) { p.hits = before.hits; p.copy = before.copy; p.state = before.state; p.fall = before.fall; p.wobble = before.wobble; } next.set(key, p); } return p; };

    // --- merged trees and lamps ---
    for (const mesh of meshes) {
      const g = mesh.geometry, pos = g.attributes.position, col = g.attributes.color, n = Math.floor(pos.count / 3);
      mesh.updateWorldMatrix(true, false);
      const e = mesh.matrixWorld.elements;
      const W = (i) => [e[0] * pos.getX(i) + e[4] * pos.getY(i) + e[8] * pos.getZ(i) + e[12], e[1] * pos.getX(i) + e[5] * pos.getY(i) + e[9] * pos.getZ(i) + e[13], e[2] * pos.getX(i) + e[6] * pos.getY(i) + e[10] * pos.getZ(i) + e[14]];
      const same = (i, c) => Math.abs(col.getX(i) - c[0]) < 0.003 && Math.abs(col.getY(i) - c[1]) < 0.003 && Math.abs(col.getZ(i) - c[2]) < 0.003;
      const poles = [], trunks = [], heads = [];
      const cluster = (list, k) => {
        const i = k * 3, a = W(i), b = W(i + 1), c = W(i + 2), cx = (a[0] + b[0] + c[0]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
        let cl = list.find((q) => Math.abs(q.cx - cx) < 0.06 && Math.abs(q.cz - cz) < 0.06);   // props stand ≥ 0.3 apart
        if (!cl) list.push(cl = { cx, cz, tris: [], lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] });
        cl.tris.push(k);
        for (const v of [a, b, c]) for (let j = 0; j < 3; j++) { cl.lo[j] = Math.min(cl.lo[j], v[j]); cl.hi[j] = Math.max(cl.hi[j], v[j]); }
      };
      for (let k = 0; k < n; k++) {
        const i = k * 3;
        if (same(i, POLE) && same(i + 2, POLE)) cluster(poles, k);
        else if (same(i, TRUNK) && same(i + 2, TRUNK)) cluster(trunks, k);
        else if (same(i, LAMP) && same(i + 2, LAMP)) heads.push(k);
      }
      if (!poles.length && !trunks.length) continue;
      let shown = true; for (let q = mesh; q; q = q.parent) if (!q.visible) shown = false;
      const centroid = (k) => { const a = W(k * 3), b = W(k * 3 + 1), c = W(k * 3 + 2); return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]; };
      for (const p of poles) {
        const w = Math.max(p.hi[0] - p.lo[0], p.hi[2] - p.lo[2]), h = p.hi[1] - p.lo[1];
        if (w > 0.04 || h < 0.2 || h > 0.45) continue;
        const x = (p.lo[0] + p.hi[0]) / 2, z = (p.lo[2] + p.hi[2]) / 2, top = p.hi[1];
        const head = heads.filter((k) => { const c = centroid(k); return Math.abs(c[0] - x) < 0.045 && Math.abs(c[2] - z) < 0.045 && c[1] > top - 0.01 && c[1] < top + 0.07; });
        const prop = add(propKey('lamp', x, z), () => ({ kind: 'lamp', key: propKey('lamp', x, z), x, z, y0: p.lo[1], sources: [], hits: 0, state: 'up',
          parts: [{ cyl: true, r: 0.018, y0: p.lo[1], y1: top }, { c: [x, top + 0.015, z], r: 0.042 }], hc: top + 0.015 - p.lo[1], rc: 0.03 }));
        prop.sources.push({ mesh, tris: [...p.tris, ...head], shown });
      }
      if (trunks.length) {
        // crown candidates: triangles high enough, by cell
        const cells = new Map();
        for (let k = 0; k < n; k++) {
          const c = centroid(k); if (c[1] < 0.06) continue;
          const key = Math.floor(c[0] * 4) + ',' + Math.floor(c[2] * 4);
          (cells.get(key) || cells.set(key, []).get(key)).push(k);
        }
        for (const t of trunks) {
          const w = Math.max(t.hi[0] - t.lo[0], t.hi[2] - t.lo[2]), h = t.hi[1] - t.lo[1];
          if (w < 0.02 || w > 0.07 || h < 0.04 || h > 0.18 || Math.abs(t.lo[1] - 0.025) > 0.012) continue;
          const s = w / 0.03, x = (t.lo[0] + t.hi[0]) / 2, z = (t.lo[2] + t.hi[2]) / 2, y0 = t.lo[1];
          const c1 = [x, y0 + 0.08 * s + 0.055 * s, z], r1 = 0.075 * s * 1.08 + 0.003, c2 = [x + 0.01 * s, y0 + 0.08 * s + 0.13 * s, z - 0.008 * s], r2 = 0.05 * s + 0.003;
          const inS = (v, c, r) => (v[0] - c[0]) ** 2 + (v[1] - c[1]) ** 2 + (v[2] - c[2]) ** 2 <= r * r;
          const crown = [];
          for (let gx = Math.floor(x * 4) - 1; gx <= Math.floor(x * 4) + 1; gx++) for (let gz = Math.floor(z * 4) - 1; gz <= Math.floor(z * 4) + 1; gz++) {
            for (const k of cells.get(gx + ',' + gz) || []) {
              const a = W(k * 3), b = W(k * 3 + 1), c = W(k * 3 + 2);
              if ((inS(a, c1, r1) && inS(b, c1, r1) && inS(c, c1, r1)) || (inS(a, c2, r2) && inS(b, c2, r2) && inS(c, c2, r2))) crown.push(k);
            }
          }
          if (crown.length < 10) continue;
          const prop = add(propKey('tree', x, z), () => ({ kind: 'tree', key: propKey('tree', x, z), x, z, y0, sources: [], hits: 0, state: 'up',
            parts: [{ cyl: true, r: 0.022 * s, y0, y1: y0 + 0.08 * s }, { c: c1, r: r1 }, { c: c2, r: r2 }], hc: c1[1] - y0, rc: r1 * 0.85 }));
          prop.sources.push({ mesh, tris: [...t.tris, ...crown], shown });
        }
      }
    }
    // --- instanced trees on open land ---
    const M4 = appCamera.matrixWorld.constructor, m = new M4();
    for (const trunk of inst) {
      const sib = trunk.parent ? trunk.parent.children.filter((o) => o.isInstancedMesh && o.geometry.parameters && o.geometry.parameters.radius) : [];
      const crown = sib.find((o) => Math.abs(o.geometry.parameters.radius - 0.11) < 1e-4), top = sib.find((o) => Math.abs(o.geometry.parameters.radius - 0.075) < 1e-4);
      trunk.updateWorldMatrix(true, false);
      const orig = (im, i) => {                                  // the matrix before we tipped it over
        const o = im.userData.scOrig || (im.userData.scOrig = []);
        if (!o[i]) { o[i] = new M4(); im.getMatrixAt(i, o[i]); }
        return o[i];
      };
      for (let i = 0; i < trunk.count; i++) {
        m.copy(orig(trunk, i));
        const el = m.elements, s = Math.hypot(el[0], el[1], el[2]), x = el[12], z = el[14];
        const key = propKey('itree', x, z);
        const prop = add(key, () => ({ kind: 'itree', key, x, z, y0: 0, hits: 0, state: 'up',
          parts: [{ cyl: true, r: 0.032 * s, y0: 0, y1: 0.12 * s }, { c: [x, 0.21 * s, z], r: 0.115 * s }, { c: [x + 0.014 * s, 0.32 * s, z - 0.012 * s], r: 0.078 * s }], hc: 0.21 * s, rc: 0.11 * s * 0.85 }));
        prop.inst = [trunk, crown, top].filter(Boolean).map((im) => ({ im, i, m0: orig(im, i) }));
      }
    }
    props.clear();
    for (const [k, p] of next) props.set(k, p);
    // props that already fell before the app rebuilt this part: down again straight away
    for (const [k, f] of fallen) {
      const p = props.get(k); if (!p) continue;
      p.state = 'down';
      if (p.inst) poseInstanced(p, f.axis, f.angle);
      else if (p.sources) for (const s of p.sources) collapse(s);
    }
  }

  // ray against the props: nearest { prop, t }
  function hitProp(o, d, maxT) {
    let best = null;
    const a = d.x * d.x + d.z * d.z;
    for (const p of props.values()) {
      if (p.state !== 'up') continue;
      const ex = o.x - p.x, ez = o.z - p.z;
      if (Math.abs(ex * d.z - ez * d.x) / Math.sqrt(a || 1) > 0.25) continue;   // nowhere near
      for (const part of p.parts) {
        let t = null;
        if (part.cyl) {
          if (a < 1e-9) continue;
          const b = 2 * (ex * d.x + ez * d.z), c = ex * ex + ez * ez - part.r * part.r, disc = b * b - 4 * a * c;
          if (disc < 0) continue;
          const t0 = (-b - Math.sqrt(disc)) / (2 * a), y = o.y + d.y * t0;
          if (y >= part.y0 && y <= part.y1) t = t0;
        } else {
          const fx = o.x - part.c[0], fy = o.y - part.c[1], fz = o.z - part.c[2];
          const b = fx * d.x + fy * d.y + fz * d.z, c = fx * fx + fy * fy + fz * fz - part.r * part.r, disc = b * b - c;
          if (disc < 0) continue;
          t = -b - Math.sqrt(disc);
        }
        if (t !== null && t > 0 && t < maxT && (!best || t < best.t)) best = { prop: p, t };
      }
    }
    return best;
  }

  // the bullet arrived
  function damageProp(p, d, at) {
    if (p.state !== 'up') return;
    p.hits++;
    const l = Math.hypot(d.x, d.z) || 1, axis = [d.z / l, 0, -d.x / l];       // falls away from you
    if (p.kind === 'lamp') for (let k = 0; k < 6; k++) spawn('spark', at.x, at.y, at.z, { vx: rnd(-0.5, 0.5), vy: rnd(0.2, 0.8), vz: rnd(-0.5, 0.5), g: 3, size: 0.004, life: rnd(0.2, 0.5) });
    else for (let k = 0; k < 5; k++) spawn(at.y > p.y0 + p.hc * 0.6 ? 'leaf' : 'wood', at.x, at.y, at.z, { vx: rnd(-0.3, 0.3) - d.x * 0.3, vy: rnd(0, 0.4), vz: rnd(-0.3, 0.3) - d.z * 0.3, g: 1.5, size: rnd(0.005, 0.009), life: rnd(0.8, 1.6), land: true, spin: true });
    startEffects();
    if (!p.inst) detach(p);
    if (p.hits < PROP_HITS) { p.wobble = { t: 0, axis }; propsBusy(); return; }
    p.state = 'falling';
    p.wobble = null;
    p.fall = { axis, angle: 0.03, w: 0.5, max: Math.acos(Math.min(1, p.rc / p.hc)) };
    sound('crack');
    for (let k = 0; k < 10; k++) spawn(p.kind === 'lamp' ? 'debris' : 'wood', p.x, p.y0 + 0.01, p.z, { vx: rnd(-0.4, 0.4) + d.x * 0.3, vy: rnd(0.2, 0.7), vz: rnd(-0.4, 0.4) + d.z * 0.3, g: 3, size: rnd(0.004, 0.009), life: rnd(1, 2), land: true, spin: true });
    startEffects();
    propsBusy();
  }

  // cut a merged prop out of its mesh(es) into a mesh of its own, pivoting at its foot
  function detach(p) {
    if (p.copy || !p.sources || !p.sources.length) return;
    const src = p.sources.find((s) => s.shown) || p.sources[0], mesh = src.mesh, g = mesh.geometry;
    const e = mesh.matrixWorld.elements, has = (n) => !!g.attributes[n];
    const P = [], N = [], Cc = [], U = [];
    for (const k of src.tris) for (let v = k * 3; v < k * 3 + 3; v++) {
      const x = g.attributes.position.getX(v), y = g.attributes.position.getY(v), z = g.attributes.position.getZ(v);
      P.push(e[0] * x + e[4] * y + e[8] * z + e[12] - p.x, e[1] * x + e[5] * y + e[9] * z + e[13] - p.y0, e[2] * x + e[6] * y + e[10] * z + e[14] - p.z);
      if (has('normal')) { const nx = g.attributes.normal.getX(v), ny = g.attributes.normal.getY(v), nz = g.attributes.normal.getZ(v); N.push(e[0] * nx + e[4] * ny + e[8] * nz, e[1] * nx + e[5] * ny + e[9] * nz, e[2] * nx + e[6] * ny + e[10] * nz); }
      Cc.push(g.attributes.color.getX(v), g.attributes.color.getY(v), g.attributes.color.getZ(v));
      if (has('uv')) U.push(g.attributes.uv.getX(v), g.attributes.uv.getY(v));
    }
    const geo = new Geometry();
    geo.setAttribute('position', new Attr(new Float32Array(P), 3));
    if (N.length) geo.setAttribute('normal', new Attr(new Float32Array(N), 3));
    geo.setAttribute('color', new Attr(new Float32Array(Cc), 3));
    if (U.length) geo.setAttribute('uv', new Attr(new Float32Array(U), 2));
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const copy = new MeshClass(geo, mat);
    copy.userData.scProp = true; copy.castShadow = copy.receiveShadow = true; copy.frustumCulled = false;
    copy.position.set(p.x, p.y0, p.z);
    appScene.add(copy);
    p.copy = copy;
    for (const s of p.sources) collapse(s);
  }
  // hide a prop's triangles in a merged mesh (squeezed to a point)
  function collapse(s) {
    const pos = s.mesh.geometry.attributes.position;
    let lo = Infinity, hi = -1;
    for (const k of s.tris) {
      const i = k * 3, x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3, y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3, z = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
      for (let v = i; v < i + 3; v++) pos.setXYZ(v, x, y, z);
      lo = Math.min(lo, i); hi = Math.max(hi, i + 3);
    }
    if (hi < 0) return;
    if (pos.addUpdateRange) { pos.addUpdateRange(lo * 3, (hi - lo) * 3); }
    pos.needsUpdate = true;
  }

  function poseInstanced(p, axis, angle) {
    const M4 = appCamera.matrixWorld.constructor, V3 = cam.position.constructor;
    const R = new M4().makeRotationAxis(new V3(axis[0], axis[1], axis[2]), angle);
    const P = new M4().makeTranslation(p.x, p.y0, p.z).multiply(R).multiply(new M4().makeTranslation(-p.x, -p.y0, -p.z));
    for (const part of p.inst) { part.im.setMatrixAt(part.i, new M4().multiplyMatrices(P, part.m0)); part.im.instanceMatrix.needsUpdate = true; }
  }
  function pose(p, axis, angle) {
    if (p.inst) poseInstanced(p, axis, angle);
    else if (p.copy) p.copy.quaternion.setFromAxisAngle(new (cam.position.constructor)(axis[0], axis[1], axis[2]), angle);
  }

  // falling and shaking props move on their own clock (also when you stop walking)
  let propsOn = false, propsLast = 0;
  function propsBusy() { if (!propsOn) { propsOn = true; propsLast = 0; requestAnimationFrame(stepProps); } }
  function stepProps(t) {
    const dt = Math.min(0.05, propsLast ? (t - propsLast) / 1000 : 0); propsLast = t;
    let busy = false;
    for (const p of props.values()) {
      if (p.wobble) {
        const w = p.wobble; w.t += dt;
        pose(p, w.axis, 0.07 * Math.sin(w.t * 26) * Math.exp(-w.t * 5));
        if (w.t > 1.2) { pose(p, w.axis, 0); p.wobble = null; } else busy = true;
      }
      if (p.state === 'falling') {
        const f = p.fall;
        f.w += 14 * Math.sin(f.angle + 0.05) * dt;            // tipping over speeds up
        f.angle += f.w * dt;
        if (f.angle >= f.max) {
          f.angle = f.max;
          if (f.w > 0.6) {                                      // hits the ground: small bounce
            if (!f.bounced) { f.bounced = true; landEffects(p, f); }
            f.w = -f.w * 0.22;
          } else { p.state = 'down'; fallen.set(p.key, { axis: f.axis, angle: f.max }); }
        }
        pose(p, f.axis, f.angle);
        if (p.state === 'falling') busy = true;
      }
    }
    if (busy) requestAnimationFrame(stepProps); else propsOn = false;
  }
  function landEffects(p, f) {
    // where the top lands: the point straight above the foot, turned by the fall (axis × up)
    const h = p.hc, a = f.angle, tx = p.x - f.axis[2] * Math.sin(a) * h, tz = p.z + f.axis[0] * Math.sin(a) * h;
    if (p.kind === 'lamp') { sound('glass'); for (let k = 0; k < 12; k++) spawn('glass', tx, 0.06, tz, { vx: rnd(-0.6, 0.6), vy: rnd(0.2, 0.9), vz: rnd(-0.6, 0.6), g: 3, size: rnd(0.003, 0.007), life: rnd(1.5, 3), land: true, spin: true }); }
    else { sound('thud'); for (let k = 0; k < 10; k++) spawn('leaf', tx, 0.08, tz, { vx: rnd(-0.4, 0.4), vy: rnd(0.1, 0.5), vz: rnd(-0.4, 0.4), g: 1.2, size: rnd(0.005, 0.01), life: rnd(1.5, 3), land: true, spin: true }); }
    startEffects();
  }

  let audio = null;
  function sound(kind) {
    if (!SOUND) return;
    try {
      audio = audio || new AudioContext();
      const a = audio, t = a.currentTime, g = a.createGain();
      g.connect(a.destination);
      if (kind === 'mg') {
        // shorter, deeper crack; quieter, as there are twenty a second
        const buf = a.createBuffer(1, Math.floor(a.sampleRate * 0.06), a.sampleRate), ch = buf.getChannelData(0);
        for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length) ** 2;
        const src = a.createBufferSource(), f = a.createBiquadFilter();
        f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.7;
        src.buffer = buf; src.connect(f); f.connect(g);
        g.gain.setValueAtTime(0.28, t);
        src.start(t);
      } else if (kind === 'shot') {
        // short noise burst: a toy "pop"
        const buf = a.createBuffer(1, Math.floor(a.sampleRate * 0.12), a.sampleRate), ch = buf.getChannelData(0);
        for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length) ** 3;
        const src = a.createBufferSource(), f = a.createBiquadFilter();
        f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 0.8;
        src.buffer = buf; src.connect(f); f.connect(g);
        g.gain.setValueAtTime(0.5, t);
        src.start(t);
      } else if (kind === 'rocket') {
        // launch: a thump and a rushing hiss
        const len = 0.7, buf = a.createBuffer(1, Math.floor(a.sampleRate * len), a.sampleRate), ch = buf.getChannelData(0);
        for (let i = 0; i < ch.length; i++) { const x = i / ch.length; ch[i] = (Math.random() * 2 - 1) * (x < 0.05 ? 1 : (1 - x) ** 1.5 * 0.6); }
        const src = a.createBufferSource(), f = a.createBiquadFilter();
        f.type = 'bandpass'; f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(2400, t + len); f.Q.value = 0.6;
        src.buffer = buf; src.connect(f); f.connect(g);
        g.gain.setValueAtTime(0.6, t);
        src.start(t);
      } else if (kind === 'crack' || kind === 'glass') {
        // wood snapping / a lamp's glass breaking: a short bright noise burst
        const len = kind === 'crack' ? 0.25 : 0.4, buf = a.createBuffer(1, Math.floor(a.sampleRate * len), a.sampleRate), ch = buf.getChannelData(0);
        for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length) ** (kind === 'crack' ? 4 : 2) * (kind === 'crack' && Math.random() < 0.02 ? 3 : 1);
        const src = a.createBufferSource(), f = a.createBiquadFilter();
        f.type = kind === 'crack' ? 'bandpass' : 'highpass'; f.frequency.value = kind === 'crack' ? 900 : 3000;
        src.buffer = buf; src.connect(f); f.connect(g);
        g.gain.setValueAtTime(kind === 'crack' ? 0.6 : 0.35, t);
        src.start(t);
      } else if (kind === 'boom') {
        // explosion: long low noise burst
        const len = 1.6, buf = a.createBuffer(1, Math.floor(a.sampleRate * len), a.sampleRate), ch = buf.getChannelData(0);
        for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length) ** 2.5;
        const src = a.createBufferSource(), f = a.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(120, t + len);
        src.buffer = buf; src.connect(f); f.connect(g);
        g.gain.setValueAtTime(0.9, t);
        src.start(t);
      } else {
        // soft thud of someone falling over
        const osc = a.createOscillator();
        osc.type = 'sine'; osc.frequency.setValueAtTime(140, t); osc.frequency.exponentialRampToValueAtTime(55, t + 0.18);
        g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        osc.connect(g); osc.start(t); osc.stop(t + 0.25);
      }
    } catch {}
  }

  function look(dx, dy) {
    gunMotion.lookX += dx; gunMotion.lookY += dy;
    yaw -= dx * LOOK_SENSITIVITY;
    pitch = Math.max(-1.4, Math.min(1.4, pitch - dy * LOOK_SENSITIVITY));
  }

  // ---------- 6. on-screen UI ----------
  let ui = null, flashEl = null, flashTimer = 0;
  function showUi(on) {
    if (!ui) {
      ui = document.createElement('div');
      ui.id = 'sc-walk-ui';
      ui.innerHTML = `
        <style>
          #sc-walk-ui{position:fixed;inset:0;pointer-events:none;z-index:9999;font:600 14px/1.4 system-ui,sans-serif;color:#fff}
          #sc-walk-ui .cross{position:absolute;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;opacity:.8}
          #sc-walk-ui.fire .cross{animation:sc-kick .15s ease-out}
          @keyframes sc-kick{0%{transform:scale(1.8);opacity:1}100%{transform:scale(1);opacity:.8}}
          #sc-walk-ui .cross:before,#sc-walk-ui .cross:after{content:"";position:absolute;background:#fff;box-shadow:0 0 2px #000}
          #sc-walk-ui .cross:before{left:6px;top:0;width:2px;height:14px}
          #sc-walk-ui .cross:after{top:6px;left:0;height:2px;width:14px}
          #sc-walk-ui .help{position:absolute;left:16px;bottom:16px;background:rgba(20,30,45,.6);padding:8px 12px;border-radius:10px;text-shadow:0 1px 2px #000}
          #sc-walk-ui .stop{position:absolute;right:16px;top:16px;pointer-events:auto;border:0;border-radius:10px;padding:8px 14px;font:inherit;background:#fff;color:#223;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.3)}
          #sc-walk-ui .flash{position:absolute;left:50%;top:60%;transform:translateX(-50%);background:rgba(20,30,45,.6);padding:4px 10px;border-radius:8px;opacity:0;transition:opacity .3s}
          #sc-walk-ui .pad{position:absolute;left:24px;bottom:24px;width:120px;height:120px;border-radius:50%;background:rgba(255,255,255,.18);border:2px solid rgba(255,255,255,.5);pointer-events:auto;touch-action:none;display:none}
          #sc-walk-ui .pad i{position:absolute;left:50%;top:50%;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;background:rgba(255,255,255,.7)}
          #sc-walk-ui.touch .pad{display:block}#sc-walk-ui.touch .help{display:none}
        </style>
        <div class="cross"></div>
        <div class="help">WASD / pijltjes: lopen · muis: kijken · Shift: rennen · klik: schieten (minigun: ingedrukt houden) · 1/2/3/Q: wapen · scrollwiel: snelheid · R/F: hoger/lager · Esc: stoppen</div>
        <button class="stop" type="button">Stoppen met lopen</button>
        <div class="flash"></div>
        <div class="pad"><i></i></div>`;
      ui.querySelector('.stop').addEventListener('click', leave);
      flashEl = ui.querySelector('.flash');
      // touch joystick
      const pad = ui.querySelector('.pad'), knob = pad.querySelector('i');
      let pid = null;
      const move = (e) => {
        const r = pad.getBoundingClientRect();
        let x = (e.clientX - r.left - r.width / 2) / (r.width / 2), y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
        const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
        stick.x = x; stick.y = y;
        knob.style.transform = `translate(${x * 36}px, ${y * 36}px)`;
      };
      pad.addEventListener('pointerdown', (e) => { pid = e.pointerId; pad.setPointerCapture(pid); move(e); });
      pad.addEventListener('pointermove', (e) => { if (e.pointerId === pid) move(e); });
      const end = (e) => { if (e.pointerId !== pid) return; pid = null; stick.x = stick.y = 0; knob.style.transform = ''; };
      pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);
      document.body.appendChild(ui);
    }
    ui.style.display = on ? '' : 'none';
    ui.classList.toggle('touch', !usingMouse);
  }
  function flash(text, ms = 900) {
    if (!flashEl) return;
    flashEl.textContent = text; flashEl.style.opacity = '1';
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { flashEl.style.opacity = '0'; }, ms);
  }

  // ---------- 7. starting at a building ----------
  // The city data the app itself reads (also when the auto-layout script changed it): every
  // Response.json() call is watched for the {projects, roads} payload of /api/city.
  let city = null;
  const origJson = Response.prototype.json;
  Response.prototype.json = async function () {
    const d = await origJson.call(this);
    try { if (d && Array.isArray(d.projects) && Array.isArray(d.roads)) { city = d; app().catch(() => {}); } } catch {}
    return d;
  };

  // The app's main module, for the exact footprint and front-door position of a building.
  //   v = placed projects → [{id, fp, gx, gy, facing}]    a = front-door road keys (gx, gy, fp, facing)
  let appModule = null;
  async function app() {
    if (appModule) return appModule;
    const s = [...document.querySelectorAll('script[type="module"][src]')].find((s) => /\/index-[^/]*\.js/.test(s.src));
    if (!s) throw new Error('main module not found');
    const m = await import(s.src);
    if (typeof m.v !== 'function' || typeof m.a !== 'function') throw new Error('app internals changed');
    return (appModule = m);
  }

  // World box per building group (for clicking and as a fallback).
  function groupBox(g) {
    const V = appCamera.position.constructor, v = new V();
    let b = null;
    eachMesh([g], (o, mw) => {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(mw);
        if (!b) b = [v.x, v.y, v.z, v.x, v.y, v.z];
        else { b[0] = Math.min(b[0], v.x); b[1] = Math.min(b[1], v.y); b[2] = Math.min(b[2], v.z);
               b[3] = Math.max(b[3], v.x); b[4] = Math.max(b[4], v.y); b[5] = Math.max(b[5], v.z); }
      }
    });
    return b;
  }

  // Remember which building was clicked in the normal view: our own ray test against the
  // buildings' boxes (the app doesn't tell us), used to tell apart buildings with the same name.
  let lastPick = null, downAt = null;
  window.addEventListener('pointerdown', (e) => { if (!walking && renderer && e.target === renderer.domElement) downAt = [e.clientX, e.clientY]; }, true);
  // Building under a screen point in the normal (top-down) view, or null.
  function pickAt(clientX, clientY) {
    if (!renderer || !appCamera || !appScene) return null;
    const r = renderer.domElement.getBoundingClientRect();
    const V = appCamera.position.constructor;
    const nx = ((clientX - r.left) / r.width) * 2 - 1, ny = -((clientY - r.top) / r.height) * 2 + 1;
    const o = new V(nx, ny, -1).unproject(appCamera), d = new V(nx, ny, 1).unproject(appCamera).sub(o);
    let best = null;
    for (const g of buildingGroups()) {
      const b = groupBox(g); if (!b) continue;
      let t0 = 0, t1 = Infinity, ok = true;
      for (let k = 0; k < 3 && ok; k++) {
        const oo = [o.x, o.y, o.z][k], dd = [d.x, d.y, d.z][k];
        if (Math.abs(dd) < 1e-9) { if (oo < b[k] || oo > b[k + 3]) ok = false; continue; }
        let a = (b[k] - oo) / dd, c = (b[k + 3] - oo) / dd; if (a > c) [a, c] = [c, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, c); if (t0 > t1) ok = false;
      }
      if (ok && (!best || t0 < best.t)) best = { t: t0, id: g.userData.projectId };
    }
    return best ? best.id : null;
  }

  window.addEventListener('pointerup', (e) => {
    if (walking || !renderer || e.target !== renderer.domElement || !downAt) return;
    if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;     // that was a drag
    lastPick = pickAt(e.clientX, e.clientY);
  }, true);

  // Double-click a building: start walking in front of its door straight away.
  window.addEventListener('dblclick', (e) => {
    if (walking || !renderer || e.target !== renderer.domElement) return;
    const id = pickAt(e.clientX, e.clientY);
    const st = id != null && doorStart(id);
    if (!st) return;                                     // not on a building: leave it to the app
    e.preventDefault(); e.stopImmediatePropagation();
    // the two clicks also opened the info card; close it once React has rendered it
    setTimeout(() => document.querySelector('.info-card .m-close')?.click(), 0);
    enter(e, st);
  }, true);

  // Which project the open info card is about: its title, made unique by the last click.
  function cardProjectId() {
    const title = (document.querySelector('.info-card #info-title')?.textContent || '').trim();
    const placed = (city?.projects || []).filter((p) => typeof p.gx === 'number' && typeof p.gy === 'number');
    const same = placed.filter((p) => (p.name || '').trim() === title);
    if (lastPick != null && same.some((p) => String(p.id) === String(lastPick))) return lastPick;
    if (same.length) return same[0].id;
    return city ? null : lastPick;    // no data at all: trust the click
  }

  const NORMALS = [[0, -1], [1, 0], [0, 1], [-1, 0]];   // facing 0=N 1=E 2=S 3=W → outward direction
  // Spot just in front of the building's door (on its side of the street), looking at the building.
  function doorStart(id) {
    const p = (city?.projects || []).find((q) => String(q.id) === String(id));
    const g = appScene && buildingGroups().find((q) => String(q.userData.projectId) === String(id));
    let door = null, n = null;
    if (p && typeof p.gx === 'number' && NORMALS[p.facing]) {
      n = NORMALS[p.facing];
      try {
        const [b] = appModule.v([p]);
        const keys = appModule.a(p.gx, p.gy, b.fp.base ?? b.fp, p.facing);
        if (keys.length) {
          let sx = 0, sz = 0;
          for (const k of keys) { const [x, y, t] = k.split(','); sx += t === 'h' ? +x + 0.5 : +x; sz += t === 'h' ? +y : +y + 0.5; }
          door = [sx / keys.length, sz / keys.length];
        }
      } catch {}
    }
    const b = g && groupBox(g);
    if (!door && b) {
      n = n || [0, 1];                                   // facing unknown: start on the south side
      const cx = (b[0] + b[3]) / 2, cz = (b[2] + b[5]) / 2;
      door = [n[0] ? (n[0] > 0 ? b[3] : b[0]) : cx, n[1] ? (n[1] > 0 ? b[5] : b[2]) : cz];
    }
    if (!door) return null;
    return { door, n };
  }

  function applyStart({ door, n }) {
    // The road runs on the door line; start on the sidewalk just in front of the door, and step
    // further out if a wall or porch is in the way.
    let x = door[0] - n[0] * 0.2, z = door[1] - n[1] * 0.2;
    for (let i = 0; i < 30 && blocked(x, z); i++) { x += n[0] * 0.05; z += n[1] * 0.05; }
    pos.x = x; pos.z = z;
    yaw = Math.atan2(n[0], n[1]) + (START_FACING === 'street' ? Math.PI : 0);
    pitch = START_FACING === 'street' ? 0.05 : 0.3;
  }

  function walkFromCard(e) {
    const id = cardProjectId();
    const st = id != null && doorStart(id);
    if (!st) { alert('Dit gebouw staat (nog) niet op de kaart.'); return; }
    document.querySelector('.info-card .m-close')?.click();   // close the info card
    enter(e, st);
  }

  // "Lopen" button in the building's info card
  function ensureCardButton() {
    const row = document.querySelector('.info-card .info-actions');
    if (!row || row.querySelector('.sc-walk-here')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-neutral sc-walk-here';
    btn.title = 'Begin met lopen voor de deur van dit gebouw';
    btn.innerHTML = ICON.replace('width="24" height="24"', 'width="18" height="18"') + ' Lopen';
    btn.addEventListener('click', walkFromCard);
    row.insertBefore(btn, row.firstChild);
  }

  // ---------- 8. menu button ----------
  const SVG = 'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="g-ico" aria-hidden="true"';
  // Lucide "footprints"
  const ICON = `<svg ${SVG}><path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/></svg>`;

  function ensureButton() {
    if (document.getElementById('sc-walk-toggle')) return;
    const row = document.querySelector('.hz-tr .menu-mini');
    if (!row) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn small';
    btn.id = 'sc-walk-toggle';
    btn.title = 'Lopen door de stad';
    btn.setAttribute('aria-label', 'Lopen door de stad');
    btn.innerHTML = '<b class="s-bg"></b>' + ICON;
    btn.addEventListener('click', (e) => enter(e));
    row.appendChild(btn);
  }
  const start = () => {
    ensureButton();
    ensureCardButton();
    new MutationObserver(() => { ensureButton(); ensureCardButton(); }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
