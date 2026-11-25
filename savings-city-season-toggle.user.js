// ==UserScript==
// @name         Savings City – season toggle
// @namespace    savings-city-tweaks
// @version      1.0
// @description  Adds a button to the top-right menu that switches between winter (snow + Christmas) and the normal season.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * How it works
 * ------------
 * The app decides the season once, when the 3D city is built:
 *
 *   function Om(){ let e = new URLSearchParams(location.search).get('winter');
 *     return e==='1' ? {snow:true, christmas:true}
 *          : e==='0' ? {snow:false, christmas:false}
 *          : Dm(new Date) }          // Nov–Feb snow, Nov–6 Jan Christmas
 *
 * Snow also patches three.js' global shaders, so it can't be switched off live.
 * This script therefore:
 *   1. at document-start (before the app runs) adds ?winter=0/1 to the URL
 *      according to the saved choice, and
 *   2. adds a button that saves the new choice and reloads the page.
 * An explicit ?winter=… already in the URL always wins.
 */
(function () {
  'use strict';

  const KEY = 'sc-tweaks:season';   // 'winter' | 'normal' | absent (= follow the date)

  const load = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const save = (v) => { try { localStorage.setItem(KEY, v); } catch {} };

  // 1. Apply the saved choice before the app reads location.search.
  const url = new URL(location.href);
  const pref = load();
  if (!url.searchParams.has('winter') && (pref === 'winter' || pref === 'normal')) {
    url.searchParams.set('winter', pref === 'winter' ? '1' : '0');
    history.replaceState(history.state, '', url);
  }

  // The season the app will actually use (same rule as the app).
  function currentIsWinter() {
    const p = new URLSearchParams(location.search).get('winter');
    if (p === '1') return true;
    if (p === '0') return false;
    const m = new Date().getMonth() + 1;
    return m >= 11 || m <= 2;
  }

  function toggle() {
    const next = currentIsWinter() ? 'normal' : 'winter';
    save(next);
    const u = new URL(location.href);
    u.searchParams.set('winter', next === 'winter' ? '1' : '0');
    location.replace(u);
  }

  // 2. The button, styled like the app's own menu buttons.
  const SVG_ATTRS = 'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="g-ico" aria-hidden="true"';
  // Lucide "snowflake" and "sun" icons (same icon set the app uses).
  const ICON_SNOW = `<svg ${SVG_ATTRS}><path d="m10 20-1.25-2.5L6 18"/><path d="M10 4 8.75 6.5 6 6"/><path d="m14 20 1.25-2.5L18 18"/><path d="m14 4 1.25 2.5L18 6"/><path d="m17 21-3-6h-4"/><path d="m17 3-3 6 1.5 3"/><path d="M2 12h6.5L10 9"/><path d="m20 10-1.5 2 1.5 2"/><path d="M22 12h-6.5L14 15"/><path d="m4 10 1.5 2L4 14"/><path d="m7 21 3-6-1.5-3"/><path d="m7 3 3 6h4"/></svg>`;
  const ICON_SUN = `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;

  function makeButton() {
    const winter = currentIsWinter();
    // Show the season you'd switch TO.
    const label = winter ? 'Normaal seizoen' : 'Winter';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn small';
    btn.id = 'sc-season-toggle';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = '<b class="s-bg"></b>' + (winter ? ICON_SUN : ICON_SNOW);
    btn.addEventListener('click', toggle);
    return btn;
  }

  // React renders the menu later and may re-render it, so keep re-adding the button.
  function ensureButton() {
    if (document.getElementById('sc-season-toggle')) return;
    const row = document.querySelector('.hz-tr .menu-mini');
    if (row) row.appendChild(makeButton());
  }

  const start = () => {
    ensureButton();
    new MutationObserver(ensureButton).observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
