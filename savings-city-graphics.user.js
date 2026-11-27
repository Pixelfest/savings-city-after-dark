// ==UserScript==
// @name         Savings City – graphics
// @namespace    savings-city-tweaks
// @version      1.3
// @description  Graphics settings in the settings popup (needs the core): winter on/off, day and night or always day/night, shadows, ambient occlusion and bigger pixels.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Settings (in the core's settings popup):
 *
 * - Winter (by date / on / off) and Day & night (real time / always day / always night).
 *   Since the 26 Nov 2026 build the app decides everything from one clock:
 *     clock = V_()  – Date.now, or with ?date=YYYY-MM-DD / ?time=HH:MM / ?timelapse=N a clock that
 *                     starts at that moment (Europe/Amsterdam) and runs N× as fast;
 *     season = { snow: month 11–2, christmas: Nov – 6 Jan } of that clock's date;
 *     daylight = the real sun position at the app's location for that clock (night = sun below the horizon).
 *   (?winter= is gone, which broke the old season toggle.) Snow patches three.js' shaders when the
 *   city is built, so both only apply after a reload: at document-start this script puts ?date=,
 *   ?time= and ?timelapse= in the URL before the app reads it:
 *     winter off in Nov–Feb → the nearest date outside it (31 Oct or 1 Mar; the sun is about the same),
 *     winter on outside it  → 15 Dec (snow and Christmas);
 *     always day   → the clock stands still at the current time if that's between 10:00 and 15:00,
 *                    otherwise at 12:00 (timelapse 1e-6 ≈ stopped);
 *     always night → stands still at 23:00.
 *   Parameters someone put in the URL themselves (different from what this script last wrote) win.
 * - Shadows: the sun's castShadow and renderer.shadowMap.enabled (three.js recompiles the shaders
 *   by itself when the number of shadow-casting lights changes). Applies right away.
 * - Ambient occlusion: the app has none, this adds screen-space AO (SSAO). The frame is drawn into a
 *   render target with a depth texture (classes borrowed from the sun's shadow map), an AO pass reads
 *   the depth (16 samples in a hemisphere around the normal, radius AO_RADIUS world units, works with
 *   the app's orthographic camera and walk mode's perspective one), a last pass draws the frame ×
 *   the blurred AO to the screen with the app's tone mapping. Only for the normal daylight render:
 *   at night the app draws through its bloom composer and the frame is left alone. Costs about one
 *   extra frame's worth of GPU time, so it's off by default.
 * - Pixel size (1×–4×): renderer.setPixelRatio is wrapped: with N× one rendered pixel covers N×N
 *   screen pixels (CSS pixels), the canvas is scaled up with image-rendering: pixelated (blocky,
 *   old-school look, and much lighter for the GPU).
 */
(function () {
  'use strict';

  const AO_RADIUS = 0.45;          // world units (1 tile ≈ 20 m) – how far corners darken (was 0.25: hardly visible)
  const AO_INTENSITY = 2.0;        // how dark a corner gets (was 1.4)
  const AO_STRENGTH = 0.85;        // 0…1, how much of it is applied
  const DAY_FROM = 10, DAY_TO = 15; // "always day": keep the current time if it's in this window (hours)
  const DAY_DEFAULT = '12:00', NIGHT_TIME = '23:00';
  const STOPPED = '0.000001';      // timelapse for a clock that stands still

  const whenCore = (fn) => (window.scCore ? fn(window.scCore) : (window.scCoreWaiting = window.scCoreWaiting || []).push(fn));

  // ---------- winter and day/night: URL parameters the app's clock reads ----------
  function applyClock(S) {
    const KEY = 'sc-graphics:url';
    const PARAMS = ['date', 'time', 'timelapse'];
    const url = new URL(location.href);
    const q = url.searchParams;
    let last = {};
    try { last = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
    // someone put their own date/time in the URL: leave it alone
    if (PARAMS.some((k) => q.has(k) && q.get(k) !== last[k])) return;

    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    const now = {};
    for (const p of fmt.formatToParts(new Date())) if (p.type !== 'literal') now[p.type] = Number(p.value);
    const pad = (n) => String(n).padStart(2, '0');
    const winterByDate = now.month >= 11 || now.month <= 2;

    const want = {};
    const winter = S.get('winter'), dn = S.get('daynight');
    if (winter === 2 && winterByDate) want.date = now.month >= 11 ? `${now.year}-10-31` : `${now.year}-03-01`;
    if (winter === 1 && !winterByDate) want.date = `${now.year}-12-15`;
    if (dn === 1) {
      want.time = now.hour >= DAY_FROM && now.hour < DAY_TO ? `${pad(now.hour)}:${pad(now.minute)}` : DAY_DEFAULT;
      want.timelapse = STOPPED;
    } else if (dn === 2) {
      want.time = NIGHT_TIME;
      want.timelapse = STOPPED;
    }
    if (want.time && !want.date) want.date = `${now.year}-${pad(now.month)}-${pad(now.day)}`;   // time alone would work too; keeps it explicit

    let changed = false;
    for (const k of PARAMS) {
      const v = want[k] ?? null;
      if (q.get(k) === v) continue;
      if (v === null) q.delete(k); else q.set(k, v);
      changed = true;
    }
    try { localStorage.setItem(KEY, JSON.stringify(want)); } catch {}
    if (changed) history.replaceState(history.state, '', url);
  }

  // ---------- shadows and pixel size ----------
  function setupRenderer(core, r, S) {
    // pixel size: the app asks min(devicePixelRatio, 2); with N× we draw 1/N pixel per CSS pixel
    const origPR = r.setPixelRatio.bind(r);
    let asked = r.getPixelRatio();
    const effective = () => { const n = S.get('pixel') + 1; return n > 1 ? 1 / n : asked; };
    r.setPixelRatio = (v) => { asked = v; origPR(effective()); };
    const style = () => {
      const pix = S.get('pixel') > 0;
      r.domElement.style.imageRendering = pix ? 'pixelated' : '';
    };
    S.onChange('pixel', () => { origPR(effective()); style(); });
    style();

    // shadows: the sun is the directional light that casts them
    let sun = null;
    const shadows = () => {
      const on = S.get('shadows');
      if (!sun && core.scene) core.scene.traverse((o) => { if (!sun && o.isDirectionalLight) sun = o; });
      if (sun) sun.castShadow = on;
      r.shadowMap.enabled = on;
      return !!sun;
    };
    S.onChange('shadows', shadows);
    // after the first frame with shadows (ambient occlusion borrows the shadow map's classes)
    core.onRender(() => {
      if (shadows.done || !core.scene) return false;
      let s = null;
      core.scene.traverse((o) => { if (!s && o.isDirectionalLight) s = o; });
      if (!s) return false;
      if (s.shadow && s.shadow.map) ao.borrow(s.shadow.map);
      else if (r.shadowMap.enabled) return false;              // wait one frame for the map
      shadows.done = shadows();
      return false;
    });
  }

  // ---------- ambient occlusion (SSAO) ----------
  const ao = (() => {
    let RT = null, Depth = null;                  // WebGLRenderTarget, DepthTexture
    let frames = 0;
    let sceneRT = null, aoRT = null, quad = null, quadScene = null, aoMat = null, outMat = null, failed = false;
    const U = {
      tDepth: { value: null }, tColor: { value: null }, tAO: { value: null },
      proj: { value: null }, projInv: { value: null }, size: { value: null },
      radius: { value: AO_RADIUS }, intensity: { value: AO_INTENSITY }, strength: { value: AO_STRENGTH }, show: { value: 0 },
    };

    function borrow(map) {
      if (RT) return;
      RT = map.constructor;
      Depth = map.depthTexture && map.depthTexture.constructor;
    }

    const VERT = `
      varying vec2 vUv;
      void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`;

    // Screen-space AO in the style of scalable AO (McGuire et al. 2012): 16 samples on a spiral
    // within the projected radius; each neighbour above the surface's tangent plane darkens it
    // (by the cosine of its angle above the plane, less with distance; unitless, so any radius works). Works for the orthographic camera and walk mode's perspective one alike.
    const AO_FRAG = `
      uniform sampler2D tDepth;
      uniform mat4 proj, projInv;
      uniform vec2 size;
      uniform float radius, intensity, show;
      varying vec2 vUv;
      vec3 viewPos( vec2 uv ) {
        float d = texture2D( tDepth, uv ).x;
        vec4 p = projInv * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
        return p.xyz / p.w;
      }
      void main() {
        float d = texture2D( tDepth, vUv ).x;
        if ( d >= 1.0 ) { gl_FragColor = vec4( 1.0 ); return; }
        vec3 p = viewPos( vUv );
        vec2 px = 1.0 / size;
        // normal from the neighbour on the flatter side (no seams on edges)
        vec3 l = viewPos( vUv - vec2( px.x, 0.0 ) ), r = viewPos( vUv + vec2( px.x, 0.0 ) );
        vec3 b = viewPos( vUv - vec2( 0.0, px.y ) ), t = viewPos( vUv + vec2( 0.0, px.y ) );
        vec3 dx = abs( r.z - p.z ) < abs( p.z - l.z ) ? r - p : p - l;
        vec3 dy = abs( t.z - p.z ) < abs( p.z - b.z ) ? t - p : p - b;
        vec3 n = normalize( cross( dx, dy ) );
        if ( show > 1.5 ) { gl_FragColor = vec4( n * 0.5 + 0.5, 1.0 ); return; }
        // the radius on screen (in uv), measured by projecting it
        vec4 c0 = proj * vec4( p, 1.0 ), c1 = proj * vec4( p + vec3( radius, 0.0, 0.0 ), 1.0 );
        float ruv = length( c1.xy / c1.w - c0.xy / c0.w ) * 0.5;
        // a random turn per pixel, 4×4 pattern (the last pass blurs it away)
        vec2 cell = mod( floor( gl_FragCoord.xy ), 4.0 );
        float turn = ( cell.x * 4.0 + cell.y ) * 0.3926991 + 0.2;
        float r2 = radius * radius, sum = 0.0;
        float aspect = size.x / size.y;
        for ( int i = 0; i < 16; i++ ) {
          float f = ( float( i ) + 0.5 ) / 16.0;
          float ang = f * 43.98230 + turn;                         // 7 turns
          vec2 uv = vUv + vec2( cos( ang ), sin( ang ) * aspect ) * ruv * f;
          if ( uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ) continue;
          vec3 v = viewPos( uv ) - p;
          float vv = dot( v, v );
          // how far above the tangent plane the neighbour is (cosine), less with distance
          sum += max( dot( v, n ) * inversesqrt( vv + 1e-10 ) - 0.3, 0.0 ) * max( 1.0 - vv / r2, 0.0 );   // 0.3: flat ground seen at a grazing angle doesn't shade itself
        }
        float ao = clamp( 1.0 - intensity * 5.0 * sum / 16.0, 0.0, 1.0 );
        gl_FragColor = vec4( vec3( ao ), 1.0 );
      }`;

    const OUT_FRAG = `
      uniform sampler2D tColor, tAO;
      uniform vec2 size;
      uniform float strength, show;
      varying vec2 vUv;
      void main() {
        vec4 col = texture2D( tColor, vUv );
        vec2 px = 1.0 / size;
        float a = 0.0;
        for ( int x = -2; x < 2; x++ ) for ( int y = -2; y < 2; y++ ) a += texture2D( tAO, vUv + ( vec2( x, y ) + 0.5 ) * px ).r;
        a /= 16.0;
        gl_FragColor = show > 1.5 ? texture2D( tAO, vUv ) : show > 0.5 ? vec4( vec3( a ), 1.0 ) : vec4( col.rgb * mix( 1.0, a, strength ), col.a );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`;

    function shaderMat(core, frag, key, toneMapped) {
      const K = core.classes();
      const m = new K.Basic({ color: 0xffffff });
      m.depthTest = m.depthWrite = false;
      m.blending = 0;                             // NoBlending
      m.toneMapped = toneMapped;
      m.onBeforeCompile = (sh) => { Object.assign(sh.uniforms, U); sh.vertexShader = VERT; sh.fragmentShader = frag; };
      m.customProgramCacheKey = () => key;
      return m;
    }

    function setup(core) {
      const K = core.classes();
      if (!K || !RT || !Depth) return false;
      const M4 = K.M4;
      U.proj.value = new M4(); U.projInv.value = new M4();
      U.size.value = { x: 1, y: 1, isVector2: true };
      const g = new K.Geometry();
      g.setAttribute('position', new K.Attr(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
      aoMat = shaderMat(core, AO_FRAG, 'sc-ssao', false);
      outMat = shaderMat(core, OUT_FRAG, 'sc-ssao-out', true);
      quad = new K.Mesh(g, aoMat);
      quad.frustumCulled = false;
      quadScene = new core.scene.constructor();
      quadScene.add(quad);
      return true;
    }

    // size is a Vector2-like; three.js reads .x/.y for vec2 uniforms
    function draw(core, s, c, raw, S) {
      if (failed || !S.get('ao')) return false;
      const r = core.renderer;
      // The app draws every frame through its bloom composer (a render target), so the target is no
      // reason to skip: the AO output goes back into the same target (`prev`) for the composer to finish.
      // Daylight only (night: the app's view says so; no AO on night light).
      const v = core.view ? core.view() : null;
      if (!r || s !== core.scene || !c || s.overrideMaterial || !c.projectionMatrix || (v && v.night > 0.5)) return false;
      if (!quad && !setup(core)) return false;
      try {
        const w = Math.max(1, Math.round(r.domElement.width)), h = Math.max(1, Math.round(r.domElement.height));
        if (!sceneRT || sceneRT.width !== w || sceneRT.height !== h) {
          if (sceneRT) { sceneRT.dispose(); aoRT.dispose(); }
          sceneRT = new RT(w, h, { type: 1016, samples: 4, depthTexture: new Depth(w, h, 1015) });   // HalfFloatType colour, FloatType depth (24 bits is too coarse over the app's 400 units)
          aoRT = new RT(w, h);
        }
        const prev = r.getRenderTarget();
        r.setRenderTarget(sceneRT);
        raw(s, c);
        U.tDepth.value = sceneRT.depthTexture; U.tColor.value = sceneRT.texture; U.tAO.value = aoRT.texture;
        U.proj.value.copy(c.projectionMatrix); U.projInv.value.copy(c.projectionMatrixInverse);
        U.size.value.x = w; U.size.value.y = h;
        const ac = r.autoClear;
        r.autoClear = false;
        quad.material = aoMat;
        r.setRenderTarget(aoRT);
        raw(quadScene, c);
        quad.material = outMat;
        r.setRenderTarget(prev);
        raw(quadScene, c);
        r.autoClear = ac;
        frames++;
        return true;
      } catch (e) {
        failed = true;
        console.warn('[graphics] ambient occlusion off:', e);
        return false;
      }
    }

    return { borrow, draw, U, get aoRT() { return aoRT; }, state: () => ({ RT: !!RT, Depth: !!Depth, quad: !!quad, failed, frames }) };
  })();

  whenCore((core) => {
    const S = core.settings;
    S.define({ id: 'winter', label: 'Winter (sneeuw en kerst)', options: ['Volgens datum', 'Aan', 'Uit'], value: 0, reload: true,
      help: 'Volgens datum: november t/m februari sneeuw, kerst tot 6 januari.' });
    S.define({ id: 'daynight', label: 'Dag en nacht', options: ['Echte tijd', 'Altijd dag', 'Altijd nacht'], value: 0, reload: true,
      help: 'Echte tijd: de zon staat zoals hij nu echt staat.' });
    S.define({ id: 'shadows', label: 'Schaduwen', type: 'toggle', value: true });
    S.define({ id: 'ao', label: 'Ambient occlusion', type: 'toggle', value: false,
      help: 'Donkere hoeken waar muren, daken en grond samenkomen. Zwaarder voor de computer; alleen overdag.' });
    S.define({ id: 'pixel', label: 'Pixelgrootte', options: ['Normaal', '2×', '3×', '4×'], value: 0,
      help: 'Grotere pixels: blokkerig als een oude game, en lichter voor de computer.' });

    applyClock(S);
    core.onRenderer((r) => setupRenderer(core, r, S));
    core.onDraw((s, c, draw) => ao.draw(core, s, c, draw, S));
    // for testing: scGraphics.ao.U.show.value = 1 shows the AO buffer
    window.scGraphics = { ao, settings: S };
  });
})();
