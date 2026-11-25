// ==UserScript==
// @name         Savings City – bodycount
// @namespace    savings-city-tweaks
// @version      1.0
// @description  Counts the dead (shot, run over, blown up, buried under collapsing buildings, officers too) and the cars that exploded.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Only listens; the other scripts announce what happens:
 *  - sc:kill { x, z, cause, who } – residents (1.10+): shot, run over, blast, collapse, indoors
 *    (nuke); cops (1.0+): officers.
 *  - sc:car-exploded { x, z } – walk mode (1.20+: shot or chain reaction; rocket bursts go
 *    through its wreck()), nuke (2.4+).
 * The counter sits top right below the menu, from the first death on, in both views. Click it to
 * reset. The counts are per page load.
 */
(function () {
  'use strict';
  let dead = 0, cops = 0, cars = 0, el = null;

  function build() {
    if (el || !document.body) return;
    el = document.createElement('div');
    el.id = 'sc-bodycount';
    el.title = 'Klik om op nul te zetten';
    el.innerHTML = `
      <style>
        #sc-bodycount{position:fixed;right:16px;top:84px;z-index:10001;display:none;gap:14px;align-items:center;
          padding:6px 14px;border-radius:12px;background:rgba(20,22,30,.78);color:#fff;font:700 16px/1.2 system-ui,sans-serif;
          box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:pointer;user-select:none;white-space:nowrap}
        #sc-bodycount span{display:inline-flex;align-items:center;gap:6px}
        #sc-bodycount svg{width:20px;height:20px;flex:none}
        #sc-bodycount b{font-variant-numeric:tabular-nums}
        #sc-bodycount i{font-style:normal;font-weight:500;opacity:.8;font-size:14px}
        #sc-bodycount .pop{animation:sc-bc-pop .35s ease-out}
        @keyframes sc-bc-pop{0%{transform:scale(1.5);color:#ff5a5a}100%{transform:scale(1)}}
      </style>
      <span class="d"><svg viewBox="0 0 24 24" fill="#f2f2f2"><path d="M12 2C6.9 2 3 5.7 3 10.5c0 2.8 1.3 5 3.5 6.3V20a1 1 0 0 0 1 1h1.5v-2h2v2h2v-2h2v2h1.5a1 1 0 0 0 1-1v-3.2c2.2-1.3 3.5-3.5 3.5-6.3C21 5.7 17.1 2 12 2zm-3.5 12a2.3 2.3 0 1 1 0-4.6 2.3 2.3 0 0 1 0 4.6zm7 0a2.3 2.3 0 1 1 0-4.6 2.3 2.3 0 0 1 0 4.6z"/></svg><b>0</b><i>doden</i></span>
      <span class="c"><svg viewBox="0 0 24 24"><path fill="#ff9a2a" d="M12 1l2.2 5.3L19.5 4l-2.1 5.4L23 11l-5.4 1.9 2.1 5.4-5.3-2.3L12 21l-2.4-5-5.3 2.3 2.1-5.4L1 11l5.6-1.6L4.5 4l5.3 2.3z"/><path fill="#ffe27a" d="M12 7l1.2 3 3-.9-1.2 3 3 1.1-3 1 1.2 3-3-1.2L12 18l-1.2-3-3 1.2 1.2-3-3-1 3-1.1-1.2-3 3 .9z"/></svg><b>0</b><i>auto's</i></span>`;
    el.addEventListener('click', () => { dead = cops = cars = 0; draw(); el.style.display = 'none'; });
    document.body.appendChild(el);
  }
  function draw(pop) {
    build(); if (!el) return;
    el.style.display = dead || cars ? 'flex' : 'none';
    el.querySelector('.d b').textContent = dead;
    el.querySelector('.d i').textContent = (dead === 1 ? 'dode' : 'doden') + (cops ? ` (${cops} agent${cops === 1 ? '' : 'en'})` : '');
    el.querySelector('.c b').textContent = cars;
    el.querySelector('.c i').textContent = cars === 1 ? 'auto' : "auto's";
    if (pop) { const b = el.querySelector(pop + ' b'); b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
  }
  window.addEventListener('sc:kill', (e) => { dead++; if (e.detail && e.detail.who === 'cop') cops++; draw('.d'); });
  window.addEventListener('sc:car-exploded', () => { cars++; draw('.c'); });
  window.scBodycount = { get dead() { return dead; }, get cops() { return cops; }, get cars() { return cars; } };
})();
