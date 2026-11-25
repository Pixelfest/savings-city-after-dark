// ==UserScript==
// @name         Savings City – After Dark (loader)
// @namespace    savings-city-tweaks
// @version      1.1
// @description  Loads all Savings City After Dark scripts from GitHub, so you install one script and get every update.
// @match        https://your-savings-city-host.example/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-after-dark.user.js
// @downloadURL  https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-after-dark.user.js
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-bodycount.user.js
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-car-tyres.user.js
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-auto-layout.user.js
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-season-toggle.user.js
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-walk-mode.user.js
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-residents.user.js
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-rocket-launcher.user.js
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-cops.user.js
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-heli-crane.user.js
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-nuke.user.js
// @require      https://raw.githubusercontent.com/Pixelfest/savings-city-after-dark/main/savings-city-monster.user.js
// ==/UserScript==

/*
 * This script has no code of its own: Tampermonkey runs every @require above, in that order,
 * before the app starts (document-start). Their own headers (@match, @version) are ignored.
 *
 * - Set @match above to the address of your Savings City app (keep the /* at the end), or add it
 *   in Tampermonkey under this script's Settings → Includes/Excludes → User matches.
 * - Don't want a script? Delete its @require line (or put a space between // and @require).
 * - Keep the order: walk mode before residents, rocket launcher and cops, which build on it.
 * - Tampermonkey keeps a copy of the required files and refreshes them on its "externals" update
 *   interval: Dashboard → Settings → Config mode: Advanced → Externals → Update Interval
 *   ("Always" = every page load picks up the latest version from GitHub).
 */
