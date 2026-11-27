// ==UserScript==
// @name         Savings City – graphics
// @namespace    savings-city-tweaks
// @version      1.6
// @description  Graphics settings in the settings popup (needs the core): winter on/off, day and night or always day/night, shadows, ambient occlusion, outlines, light shafts and their haze, lens effects and bigger pixels.
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
 *   Since 1.5 the AO is one step of a post-processing chain (see "post-processing" below): the
 *   scene is drawn once, and AO, outlines, light shafts and the lens share that one frame.
 * - Outlines (Omlijning): dark lines on creases and silhouettes, from the depth buffer alone (its
 *   Laplacian: zero on flat surfaces). Day and night, about one extra full-screen pass.
 * - Light shafts (Lichtstralen: off / explosions only / sun and explosions):
 *     sun: a layer of haze, ray-marched through the sun's shadow map, so the shadows of buildings
 *          become shafts in the haze (needs shadows, daytime; the heaviest effect, at half size);
 *          the settings' section "Nevel (zonnestralen)" sets its height, thickness, darkness in shadow, glow, colour
 *          and wind (drifting patches – shafts show best with movement), live, kept in localStorage;
 *     explosions: any script can add a light source to window.scLightBursts (the nuke does): rays
 *          fan out from it (radial blur), day and night. Costs nothing when nothing explodes.
 * - Lens (Lenseffect: off / at explosions / always): chromatic aberration and a slight barrel
 *   distortion; every sc:blast and every light burst kicks it up for a moment.
 * - Pixel size (1×–4×): renderer.setPixelRatio is wrapped: with N× one rendered pixel covers N×N
 *   screen pixels (CSS pixels), the canvas is scaled up with image-rendering: pixelated (blocky,
 *   old-school look, and much lighter for the GPU).
 */
(function () {
  'use strict';

  const AO_RADIUS = 0.45;          // world units (1 tile ≈ 20 m) – how far corners darken (was 0.25: hardly visible)
  const AO_INTENSITY = 2.0;        // how dark a corner gets (was 1.4)
  const AO_STRENGTH = 0.85;        // 0…1, how much of it is applied
  const EDGE_STRENGTH = 0.55;      // 0…1, how dark the outlines are
  const SHAFT_STEPS = 24;          // samples per pixel through the sun's shadow map (at half size)
  // the haze for sun shafts – defaults of the settings in the section "Nevel (zonnestralen)"
  // (HAZE_KEY: where graphics 1.5 kept them, read once)
  const HAZE_DEFAULTS = {
    top: 10,                       // world units: the haze layer goes from the ground up to here
    thick: 0.07,                   // per world unit: how thick the haze is
    dim: 0.6,                      // how much darker the picture gets behind haze in a building's shadow
    glow: 0.07,                    // how bright sunlit haze is (× the sun's colour and intensity)
    color: '#ffd9a8',              // the haze's own colour…
    tint: 0,                       // …and how much of it (0 = the sun's colour, 1 = only this colour)
    wind: 0,                       // 0…1: patchy haze drifting with the wind (shafts show best with movement)
  };
  const HAZE_KEY = 'sc-graphics:haze';
  const WIND_SPEED = 1.2;          // world units per second at wind 1
  const WIND_SCALE = 0.35;         // size of the haze patches: noise frequency per world unit
  const BURST_SAMPLES = 48;        // radial blur samples for a burst (the nuke)
  const BURST_DECAY = 0.985;       // per sample: rays fade out further from the source
  const BURST_STRENGTH = 2.2;      // brightness of burst rays at strength 1
  const BURST_KICK = 0.8;          // lens kick from a burst at strength 1
  const BLAST_KICK = 0.35;         // lens kick from every sc:blast (rockets, cars, meteors)
  const KICK_DECAY = 0.35;         // seconds
  const LENS_CA = 0.003;           // chromatic aberration ("Altijd"): colours shifted by this share of the distance to the centre
  const LENS_DISTORT = 0.03;       // barrel distortion ("Altijd"; small: clicks still land on what you see)
  const KICK_CA = 0.035, KICK_DISTORT = 0.25;   // added at a full kick (an explosion)
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
      if (s.shadow && s.shadow.map) post.borrow(s.shadow.map);
      else if (r.shadowMap.enabled) return false;              // wait one frame for the map
      shadows.done = shadows();
      return false;
    });
  }

  // ---------- haze for the sun shafts: settings in the core's popup ----------
  // Section "Nevel (zonnestralen)", shown while Lichtstralen is "Zon en explosies". Up to graphics
  // 1.5 these were in a floating panel of their own; its values (localStorage HAZE_KEY) are taken
  // over once.
  const HAZE_SETTINGS = [
    { id: 'hazeTop', k: 'top', label: 'Hoogte van de nevel', min: 2, max: 30, step: 0.5, format: (v) => `${v} (≈ ${Math.round(v * 20)} m)`,
      help: 'Zonnestralen zie je overdag, met schaduwen aan. Een lage zon (ochtend, eind van de middag) geeft lange stralen; wind laat ze bewegen.' },
    { id: 'hazeThick', k: 'thick', label: 'Dikte', min: 0, max: 0.3, step: 0.005, format: (v) => v.toFixed(3) },
    { id: 'hazeDim', k: 'dim', label: 'Schaduw in de nevel', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
    { id: 'hazeGlow', k: 'glow', label: 'Gloed in de zon', min: 0, max: 0.4, step: 0.01, format: (v) => v.toFixed(2) },
    { id: 'hazeColor', k: 'color', label: 'Kleur van de nevel', type: 'color', help: 'Telt mee naarmate "Eigen kleur" hoger staat.' },
    { id: 'hazeTint', k: 'tint', label: 'Eigen kleur', min: 0, max: 1, step: 0.05, format: (v) => (v ? `${Math.round(v * 100)}%` : 'kleur van de zon') },
    { id: 'hazeWind', k: 'wind', label: 'Wind (nevel in vlagen)', min: 0, max: 1, step: 0.05, format: (v) => (v ? `${Math.round(v * 100)}%` : 'stil') },
  ];
  const haze = {
    get() {
      const H = { ...HAZE_DEFAULTS }, S = window.scCore && window.scCore.settings;
      if (S) for (const d of HAZE_SETTINGS) { const v = S.get(d.id); if (v !== undefined) H[d.k] = v; }
      return H;
    },
    define(S) {
      for (const { k, ...d } of HAZE_SETTINGS) S.define({ ...d, value: HAZE_DEFAULTS[k], when: () => S.get('shafts') === 2 });
      try {                                                        // the old panel's values, once
        const old = JSON.parse(localStorage.getItem(HAZE_KEY));
        if (old && typeof old === 'object') for (const d of HAZE_SETTINGS) if (old[d.k] !== undefined) S.set(d.id, old[d.k]);
        localStorage.removeItem(HAZE_KEY);
      } catch {}
    },
  };

  // ---------- post-processing: ambient occlusion, outlines, light shafts, lens ----------
  // One chain for every effect: the scene is drawn once into a target with a depth texture, then
  //   AO pass      (daylight only)                       → aoRT
  //   shafts pass  (half size: sun haze + burst rays)    → shaftRT
  //   composite    (lens + AO + outlines + haze/rays, tone mapping) → wherever the app was drawing.
  // Effects that are off cost nothing; with everything off (and no burst/kick) the app draws as usual.
  const post = (() => {
    let RT = null, Depth = null;                  // WebGLRenderTarget, DepthTexture
    let frames = 0;
    let sceneRT = null, aoRT = null, shaftRT = null, quad = null, quadScene = null, aoMat = null, shaftMat = null, burstMat = null, outMat = null, failed = false;
    let sun = null, kick = 0, lastT = 0, windT = 0;
    const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z, isVector3: true });
    const U = {
      tDepth: { value: null }, tColor: { value: null }, tAO: { value: null }, tShaft: { value: null }, tShadow: { value: null },
      proj: { value: null }, projInv: { value: null }, viewInv: { value: null }, shadowMat: { value: null }, size: { value: null },
      radius: { value: AO_RADIUS }, intensity: { value: AO_INTENSITY }, strength: { value: AO_STRENGTH }, show: { value: 0 },
      aoOn: { value: 0 }, edgeOn: { value: 0 }, edgeStep: { value: 1 }, edgeStrength: { value: EDGE_STRENGTH },
      shaftOn: { value: 0 }, sunOn: { value: 0 }, sunDir: { value: v3() }, sunCol: { value: v3() },
      shaftTop: { value: 0 }, shaftExt: { value: 0 }, shaftDim: { value: 0 }, shaftScatter: { value: 0 }, shadowBias: { value: 0 },
      hazeCol: { value: v3() }, tint: { value: 0 }, wind: { value: 0 }, windOff: { value: v3() },
      burstOn: { value: 0 }, burstUv: { value: v3() }, burstCol: { value: v3() },
      ca: { value: 0 }, distort: { value: 0 },
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

    // Light shafts, at half size. Two kinds, added together:
    // - Sun: a layer of haze from the ground up to shaftTop. Each pixel's view ray is cut to that
    //   layer and marched in SHAFT_STEPS steps through the sun's shadow map (hardware compare, the
    //   same depth texture three.js shades with): lit haze scatters sunlight, haze in a building's
    //   shadow doesn't, so the shadows of tall buildings become dark shafts in a sunny haze. Works for
    //   the top-down orthographic camera (where the sun is never on screen) and walk mode alike.
    //   rgb = scattered light (sunlit haze), a = haze in shadow. Not physical on purpose: shadowed haze
    //   darkens and sunlit haze only adds a glow, so the shafts show without fogging the city over.
    // - Burst (the nuke): classic radial blur (GPU Gems 3, ch. 13) towards the fireball's point on
    //   screen, of what's bright near the fireball: rays fan out from it, cut off by what's in front.
    const SHAFT_FRAG = `
      uniform sampler2D tDepth, tColor;
      #ifdef SUN
      uniform sampler2DShadow tShadow;
      #endif
      uniform mat4 projInv, viewInv, shadowMat;
      uniform vec3 sunCol, burstUv, burstCol, hazeCol, windOff;
      uniform vec2 size;
      uniform float sunOn, shaftTop, shaftExt, shaftScatter, shadowBias, burstOn, tint, wind;
      varying vec2 vUv;
      float hash( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
      float hash3( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
      float noise( vec3 x ) {                                        // value noise, 0…1
        vec3 i = floor( x ), f = fract( x );
        f = f * f * ( 3.0 - 2.0 * f );
        return mix( mix( mix( hash3( i ), hash3( i + vec3( 1, 0, 0 ) ), f.x ), mix( hash3( i + vec3( 0, 1, 0 ) ), hash3( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
                    mix( mix( hash3( i + vec3( 0, 0, 1 ) ), hash3( i + vec3( 1, 0, 1 ) ), f.x ), mix( hash3( i + vec3( 0, 1, 1 ) ), hash3( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
      }
      vec3 worldAt( vec2 uv, float d ) {
        vec4 p = projInv * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
        return ( viewInv * vec4( p.xyz / p.w, 1.0 ) ).xyz;
      }
      void main() {
        float jit = hash( gl_FragCoord.xy );
        vec3 light = vec3( 0.0 );
        float fog = 0.0;
        #ifdef SUN
        if ( sunOn > 0.5 ) {
          float d = min( texture2D( tDepth, vUv ).x, 0.99999 );
          vec3 O = worldAt( vUv, 0.0 ), D = worldAt( vUv, d ) - O;
          float t0 = 0.0, t1 = 1.0;
          if ( abs( D.y ) > 1e-5 ) {
            float a = ( shaftTop - O.y ) / D.y, b = -O.y / D.y;
            t0 = max( t0, min( a, b ) ); t1 = min( t1, max( a, b ) );
          } else if ( O.y > shaftTop || O.y < 0.0 ) t1 = -1.0;
          if ( t1 > t0 ) {
            // with wind the haze is patchy (density 0…2 from drifting noise), else even
            float lit = 0.0, dens = 0.0;
            for ( int i = 0; i < ${SHAFT_STEPS}; i++ ) {
              vec3 w = O + D * ( t0 + ( t1 - t0 ) * ( float( i ) + jit ) / ${SHAFT_STEPS}.0 );
              float k = 1.0;
              if ( wind > 0.0 ) {
                vec3 q = ( w + windOff ) * ${WIND_SCALE};
                k = mix( 1.0, 2.0 * smoothstep( 0.25, 0.75, 0.65 * noise( q ) + 0.35 * noise( q * 2.3 + 7.0 ) ), wind );
              }
              vec4 sc = shadowMat * vec4( w, 1.0 );
              sc.xyz /= sc.w;
              bool inside = sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 && sc.z < 1.0;
              lit += k * ( inside ? texture( tShadow, vec3( sc.xy, sc.z + shadowBias ) ) : 1.0 );
              dens += k;
            }
            dens /= ${SHAFT_STEPS}.0;
            lit /= ${SHAFT_STEPS}.0;                                     // sunlit density, 0…dens
            float len = length( D ) * ( t1 - t0 );
            float haze = 1.0 - exp( -shaftExt * len * dens );
            float litShare = dens > 0.0 ? lit / dens : 1.0;
            light = mix( sunCol, hazeCol * length( sunCol ) * 0.577, tint ) * shaftScatter * haze * litShare;
            fog = haze * ( 1.0 - litShare );
          }
        }
        #endif
        if ( burstOn > 0.0 ) {
          vec2 asp = vec2( size.x / size.y, 1.0 );
          vec2 delta = burstUv.xy - vUv;
          vec3 b = vec3( 0.0 );
          float w = 1.0;
          for ( int i = 0; i < ${BURST_SAMPLES}; i++ ) {
            vec2 uv = vUv + delta * ( float( i ) + jit ) / ${BURST_SAMPLES}.0;
            vec3 s = texture2D( tColor, uv ).rgb;
            float near = 1.0 - smoothstep( burstUv.z, burstUv.z * 3.0, length( ( uv - burstUv.xy ) * asp ) );
            b += max( s - 0.6, 0.0 ) * near * w;
            w *= ${BURST_DECAY};
          }
          light += b * burstCol * burstOn / ${BURST_SAMPLES}.0;
        }
        gl_FragColor = vec4( light, fog );
      }`;

    // Last pass: lens (barrel distortion + chromatic aberration, both from the centre outward),
    // AO, outlines, haze and rays, then the app's tone mapping.
    // Outlines: the Laplacian of the depth along x and y. A plane has a depth that's linear on screen
    // (view z for the orthographic camera, 1/z for a perspective one), so it's zero on flat surfaces
    // and large on creases (a wall meeting the ground or a roof) and silhouettes; divided by the size
    // of a pixel in world units it's a slope change, the same for any zoom.
    const OUT_FRAG = `
      uniform sampler2D tColor, tAO, tDepth, tShaft;
      uniform mat4 proj, projInv;
      uniform vec2 size;
      uniform float strength, show, aoOn, edgeOn, edgeStep, edgeStrength, shaftOn, shaftDim, ca, distort;
      varying vec2 vUv;
      float zAt( vec2 uv ) {
        float d = texture2D( tDepth, uv ).x;
        vec4 p = projInv * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
        return -p.z / p.w;
      }
      void main() {
        vec2 uv = vUv;
        if ( distort != 0.0 ) {
          vec2 c = uv - 0.5;
          uv = 0.5 + c * ( 1.0 + distort * dot( c, c ) ) / ( 1.0 + distort * 0.5 );   // corners stay corners
        }
        vec4 col = texture2D( tColor, uv );
        if ( ca > 0.0 ) {
          vec2 c = uv - 0.5;
          col.r = texture2D( tColor, 0.5 + c * ( 1.0 - ca ) ).r;
          col.b = texture2D( tColor, 0.5 + c * ( 1.0 + ca ) ).b;
        }
        vec2 px = 1.0 / size;
        if ( aoOn > 0.5 ) {
          float a = 0.0;
          for ( int x = -2; x < 2; x++ ) for ( int y = -2; y < 2; y++ ) a += texture2D( tAO, uv + ( vec2( x, y ) + 0.5 ) * px ).r;
          a /= 16.0;
          if ( show > 1.5 ) { gl_FragColor = texture2D( tAO, uv ); return; }
          if ( show > 0.5 ) { gl_FragColor = vec4( vec3( a ), 1.0 ); return; }
          col.rgb *= mix( 1.0, a, strength );
        }
        if ( edgeOn > 0.5 ) {
          vec2 o = edgeStep * px;
          float z = zAt( uv ), l = zAt( uv - vec2( o.x, 0.0 ) ), r = zAt( uv + vec2( o.x, 0.0 ) );
          float b = zAt( uv - vec2( 0.0, o.y ) ), t = zAt( uv + vec2( 0.0, o.y ) );
          float k = 2.0 * edgeStep / ( proj[1][1] * size.y );           // a step in world units (at depth 1 for perspective)
          float e = proj[3][3] > 0.5
            ? ( abs( l + r - 2.0 * z ) + abs( b + t - 2.0 * z ) ) / k
            : ( abs( 1.0 / l + 1.0 / r - 2.0 / z ) + abs( 1.0 / b + 1.0 / t - 2.0 / z ) ) * z / k;
          float edge = smoothstep( 0.3, 0.9, e ) * edgeStrength;
          if ( show > 2.5 ) { gl_FragColor = vec4( vec3( 1.0 - edge ), 1.0 ); return; }
          col.rgb *= 1.0 - edge;
        }
        if ( shaftOn > 0.5 ) {
          vec2 hp = 2.0 * px;                                         // the shaft target is half size
          vec4 s = 0.25 * ( texture2D( tShaft, uv + vec2( -0.75, -0.75 ) * hp ) + texture2D( tShaft, uv + vec2( 0.75, -0.75 ) * hp )
                          + texture2D( tShaft, uv + vec2( -0.75, 0.75 ) * hp ) + texture2D( tShaft, uv + vec2( 0.75, 0.75 ) * hp ) );
          if ( show > 3.5 ) { gl_FragColor = vec4( s.rgb, 1.0 ); return; }
          col.rgb = col.rgb * ( 1.0 - shaftDim * s.a ) + s.rgb;
        }
        gl_FragColor = col;
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
      U.proj.value = new M4(); U.projInv.value = new M4(); U.viewInv.value = new M4(); U.shadowMat.value = new M4();
      U.size.value = { x: 1, y: 1, isVector2: true };
      const g = new K.Geometry();
      g.setAttribute('position', new K.Attr(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
      aoMat = shaderMat(core, AO_FRAG, 'sc-ssao', false);
      // two builds: with the sun's shadow map, and without it for bursts only (a sampler2DShadow with
      // no shadow map bound makes WebGL skip the whole draw – the rays never showed)
      shaftMat = shaderMat(core, '#define SUN\n' + SHAFT_FRAG, 'sc-shafts-sun', false);
      burstMat = shaderMat(core, SHAFT_FRAG, 'sc-shafts', false);
      outMat = shaderMat(core, OUT_FRAG, 'sc-post-out', true);
      quad = new K.Mesh(g, aoMat);
      quad.frustumCulled = false;
      quadScene = new core.scene.constructor();
      quadScene.add(quad);
      return true;
    }

    // Bursts: anyone can put a light source in window.scLightBursts (a Set; load order doesn't
    // matter) – { x, y, z, radius, strength, color: [r, g, b] } in world units, changed every frame by
    // its owner and deleted when done. The strongest one gets rays; its strength also kicks the lens.
    const bursts = window.scLightBursts = window.scLightBursts || new Set();
    function strongestBurst() {
      let best = null;
      for (const b of bursts) if (b && b.strength > 0.01 && (!best || b.strength > best.strength)) best = b;
      return best;
    }
    // where a world point lands on screen: uv (0…1) and the uv height of `radius` there; null behind the camera
    function project(c, x, y, z, radius) {
      const v = c.matrixWorldInverse.elements, p = c.projectionMatrix.elements;
      const vx = v[0] * x + v[4] * y + v[8] * z + v[12], vy = v[1] * x + v[5] * y + v[9] * z + v[13], vz = v[2] * x + v[6] * y + v[10] * z + v[14];
      const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12], cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13], cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
      if (cw <= 1e-6) return null;
      return { u: cx / cw * 0.5 + 0.5, v: cy / cw * 0.5 + 0.5, r: radius * p[5] / cw * 0.5 };
    }

    function findSun(core) {
      if (sun && sun.parent) return sun;
      sun = null;
      if (core.scene) core.scene.traverse((o) => { if (!sun && o.isDirectionalLight) sun = o; });
      return sun;
    }

    // something blew up (rockets, cars, meteors…): a short lens kick
    window.addEventListener('sc:blast', () => { kick = Math.min(1, kick + BLAST_KICK); });

    function draw(core, s, c, raw, S) {
      if (failed) return false;
      const r = core.renderer;
      if (!r || s !== core.scene || !c || s.overrideMaterial || !c.projectionMatrix) return false;
      const now = performance.now(), dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
      lastT = now;
      kick *= Math.exp(-dt / KICK_DECAY);
      const v = core.view ? core.view() : null;
      const night = v && v.night > 0.5;
      const shafts = S.get('shafts'), lens = S.get('lens');
      const L = findSun(core);
      const burst = shafts > 0 ? strongestBurst() : null;
      if (burst && lens > 0) kick = Math.max(kick, Math.min(1, (burst.strength - 0.6) * BURST_KICK));   // the flash, not the glow after it
      const aoOn = S.get('ao') && !night;
      const edgeOn = S.get('outlines');
      const sunOn = shafts === 2 && !night && L && L.castShadow && r.shadowMap.enabled && L.shadow && L.shadow.map
        && L.shadow.map.depthTexture && L.intensity > 0.05;
      const always = lens === 2 ? 1 : 0, kicked = lens > 0 ? kick : 0;
      if (!aoOn && !edgeOn && !sunOn && !burst && !always && kicked < 0.01) return false;
      if (!quad && !setup(core)) return false;
      try {
        const w = Math.max(1, Math.round(r.domElement.width)), h = Math.max(1, Math.round(r.domElement.height));
        if (!sceneRT || sceneRT.width !== w || sceneRT.height !== h) {
          if (sceneRT) { sceneRT.dispose(); aoRT.dispose(); shaftRT.dispose(); }
          sceneRT = new RT(w, h, { type: 1016, samples: 4, depthTexture: new Depth(w, h, 1015) });   // HalfFloatType colour, FloatType depth (24 bits is too coarse over the app's 400 units)
          aoRT = new RT(w, h);
          shaftRT = new RT(Math.max(1, w >> 1), Math.max(1, h >> 1), { type: 1016 });
        }
        const prev = r.getRenderTarget();
        r.setRenderTarget(sceneRT);
        // The app's bloom composer clears its own target and then renders with autoClear off, so our
        // target would never be cleared: every frame piled onto the last (moving things smeared).
        r.clear(true, true, true);
        raw(s, c);
        U.tDepth.value = sceneRT.depthTexture; U.tColor.value = sceneRT.texture; U.tAO.value = aoRT.texture; U.tShaft.value = shaftRT.texture;
        U.proj.value.copy(c.projectionMatrix); U.projInv.value.copy(c.projectionMatrixInverse); U.viewInv.value.copy(c.matrixWorld);
        U.size.value.x = w; U.size.value.y = h;
        U.aoOn.value = aoOn ? 1 : 0;
        U.edgeOn.value = edgeOn ? 1 : 0;
        U.edgeStep.value = r.getPixelRatio() >= 1.5 ? 2 : 1;          // about one CSS pixel
        U.sunOn.value = sunOn ? 1 : 0;
        if (sunOn) {
          U.tShadow.value = L.shadow.map.depthTexture;
          U.shadowMat.value.copy(L.shadow.matrix);
          U.shadowBias.value = L.shadow.bias;
          const k = L.intensity * (1 - (v ? v.night : 0));
          U.sunCol.value.x = L.color.r * k; U.sunCol.value.y = L.color.g * k; U.sunCol.value.z = L.color.b * k;
          const H = haze.get();
          U.shaftTop.value = H.top; U.shaftExt.value = H.thick; U.shaftDim.value = H.dim; U.shaftScatter.value = H.glow;
          U.tint.value = H.tint; U.wind.value = H.wind;
          const lin = (c) => Math.pow(c / 255, 2.2), hex = parseInt(String(H.color).slice(1), 16) || 0;
          U.hazeCol.value.x = lin(hex >> 16 & 255); U.hazeCol.value.y = lin(hex >> 8 & 255); U.hazeCol.value.z = lin(hex & 255);
          windT += dt * WIND_SPEED * H.wind;                            // the haze drifts along x, a bit along z, and churns slowly
          U.windOff.value.x = -windT; U.windOff.value.y = -windT * 0.15; U.windOff.value.z = -windT * 0.4;
        } else U.tShadow.value = null;
        let bOn = 0;
        if (burst) {
          const pr = project(c, burst.x, burst.y, burst.z, burst.radius || 1);
          if (pr) {
            bOn = burst.strength * BURST_STRENGTH;
            U.burstUv.value.x = pr.u; U.burstUv.value.y = pr.v; U.burstUv.value.z = Math.max(0.01, pr.r);
            const col = burst.color || [1, 0.85, 0.6];
            U.burstCol.value.x = col[0]; U.burstCol.value.y = col[1]; U.burstCol.value.z = col[2];
          }
        }
        U.burstOn.value = bOn;
        U.shaftOn.value = sunOn || bOn > 0 ? 1 : 0;
        U.ca.value = LENS_CA * always + KICK_CA * kicked;
        U.distort.value = LENS_DISTORT * always + KICK_DISTORT * kicked;
        const ac = r.autoClear;
        r.autoClear = false;
        if (aoOn) { quad.material = aoMat; r.setRenderTarget(aoRT); raw(quadScene, c); }
        if (U.shaftOn.value) { quad.material = sunOn ? shaftMat : burstMat; r.setRenderTarget(shaftRT); raw(quadScene, c); }
        quad.material = outMat;
        r.setRenderTarget(prev);
        raw(quadScene, c);
        r.autoClear = ac;
        frames++;
        return true;
      } catch (e) {
        failed = true;
        console.warn('[graphics] post-processing off:', e);
        return false;
      }
    }

    return {
      borrow, draw, U, bursts, get aoRT() { return aoRT; },
      kick: (k = 1) => { kick = Math.min(1, kick + k); },
      state: () => ({ RT: !!RT, Depth: !!Depth, quad: !!quad, failed, frames, kick: +kick.toFixed(3) }),
    };
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
    S.define({ id: 'outlines', label: 'Omlijning', type: 'toggle', value: false,
      help: 'Donkere lijnen langs randen en hoeken, als een tekening of een maquette.' });
    S.define({ id: 'shafts', label: 'Lichtstralen', options: ['Uit', 'Alleen explosies', 'Zon en explosies'], value: 1,
      help: 'Stralen van licht uit de atoombom. Zon: zonnestralen door de nevel tussen de gebouwen (overdag, met schaduwen aan; zwaarder voor de computer).' });
    S.define({ id: 'lens', label: 'Lenseffect', options: ['Uit', 'Alleen bij explosies', 'Altijd'], value: 1,
      help: 'Kleurranden en een licht bolle lens, als door een camera. Bij explosies even veel sterker.' });
    S.define({ id: 'pixel', label: 'Pixelgrootte', options: ['Normaal', '2×', '3×', '4×'], value: 0,
      help: 'Grotere pixels: blokkerig als een oude game, en lichter voor de computer.' });

    applyClock(S);
    haze.define(S);
    core.onRenderer((r) => setupRenderer(core, r, S));
    core.onDraw((s, c, draw) => post.draw(core, s, c, draw, S));
    // for testing: scGraphics.post.U.show.value = 1 AO buffer, 2 normals, 3 outlines, 4 shafts
    window.scGraphics = { post, ao: post, haze, settings: S };
  });
})();
