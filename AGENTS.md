# Savings City – After Dark: instructions for agents

Tampermonkey userscripts that add features (and mayhem) to the Savings City web app, plus a local
copy of that app to develop and test them on. Everything for this project lives in this
repository: scripts, local runner, app copy, test city, docs and releases.

Before changing anything, read `CONTEXT.md`: it describes the app (three.js city, how buildings,
cars, trees and lamps are built), how the scripts hook into it without changing app code, how the
scripts talk to each other, and how to test without the real app.

## Privacy rules (this repository is public)

Nothing in this repository may point to a specific web address of the real app or its owner, or
contain data that could be personal information. This applies to every file, commit message, pull
request, issue and comment.

- **No real addresses.** Never write the real Savings City host, its API, logo or favicon URLs,
  internal host names, or any other address that leads to the real app or the organisation behind
  it. Use the placeholder `https://your-savings-city-host.example/` (the scripts `@match`
  `https://your-savings-city-host.example/*`) or a root-relative path (`/api/city`, `/logo/coin.png`).
- **No personal or identifying data.** No names of people, teams, the company or its customers; no
  e-mail addresses, phone numbers, user ids, real project names or descriptions, real figures
  (hours, budgets, totals), real database ids, or locations that point to the organisation.
- **Allowed exceptions:** public libraries, repositories and files – three.js, React, Tampermonkey,
  Google Fonts, Node/Playwright docs, GitHub, this repository's own `raw.githubusercontent.com`
  URLs (the loader updates from them) – and placeholders such as `example.com` / `voorbeeld.nl`.
  The full list is `ALLOWED_HOSTS` in `tools/check-privacy.js`; add a host there only if it is
  public and unrelated to the real app's owner.
- **City data must be anonymous:** project names made up, description
  `Voorbeeldproject (geanonimiseerd).`, authors `Bouwer A`, `Bouwer B`, …, links `null` or
  `https://example.com/`, fresh UUIDs, figures scrambled. Use `tools/anonymise-city.js`.
- **App files must be cleaned before they're committed:** use `tools/sanitize-app.js` (below).
  Never commit a "Save page as" HTML as it is: it contains the real host and the rendered page with
  real project data.
- **Run `node tools/check-privacy.js` before every commit** (CI runs it too, see
  `.github/workflows/privacy.yml`). If it fails, fix the content – don't silence the check.
- Locally, put the real host, company and people's names in `.private-terms` (one per line;
  git-ignored, never commit it) and the check looks for those too. CI doesn't have this file.
- If something private was given to you (in a prompt, an uploaded file, a log or screenshot), use
  it only to do the work; don't copy it into the repo, a commit message or a PR. If you find
  private data already committed, stop and tell the user (it has to be removed from history too).

## Layout

| Path | What |
|---|---|
| `savings-city-<feature>.user.js` | One userscript per feature (see the table in `README.md`). |
| `savings-city-after-dark.user.js` | The loader users install: `@require`s every script from this repo's `main` branch. |
| `app/index.html`, `app/assets/` | Cleaned copy of the real app: HTML shell, minified JS bundles, CSS, logo, font CSS. Read-only reference + what the local runner serves. Never edit the bundles. |
| `local/server.js` | Serves `app/` with `/api/*` answered from a city JSON (in memory) and the scripts injected at document-start. |
| `local/shot.js` | Headless Chromium screenshot of the local app (Playwright). |
| `local/city.json` | Anonymous test city (the `/api/city` format). |
| `tools/check-privacy.js` | The privacy check (URLs, host names, e-mail addresses, city data, `.private-terms`). |
| `tools/sanitize-app.js` | Brings new files from the real app into `app/`, cleaned. |
| `tools/anonymise-city.js` | Turns a real `/api/city` dump into an anonymous city. |
| `CONTEXT.md` | How the app works internally and how the scripts hook into it. Keep it current. |

## Conventions

- One script per feature, `savings-city-<feature>.user.js`; bump its `@version` on every change.
  Every script's `@match` stays `https://your-savings-city-host.example/*`.
- Settings are constants at the top of each script; comments in English, UI text in Dutch.
- Keep `README.md` (the script table with versions) and `CONTEXT.md` up to date.
- New shared needs (hooks, traps, borrowed classes) go into the core, not into each script.

## Updating the app copy (new HTML/JS/CSS from the real app)

The user will hand you the newest files of the real app (a "Save page as" folder, or files from
DevTools → Network: `index-*.js`, the lazily loaded `CityCanvas-*.js`, `index-*.css`, `logo.webp`,
the Google Fonts `css2`). Then:

1. Put them in a scratch folder outside the repo (or `incoming/`, which is git-ignored).
2. `node tools/sanitize-app.js <folder-or-files>` – writes `app/index.html` and `app/assets/`,
   replaces older bundles with the same name prefix (one build at a time), and runs the privacy
   check on the result. If the check fails because a bundle contains a private URL, don't commit
   it: tell the user.
3. Compare old and new bundles to see what changed (`git diff --stat app/`; for the minified code,
   grep for the shapes `CONTEXT.md` mentions, e.g. the helpers the core finds by code shape).
4. Fix the scripts that broke (minified names change every build; find things by shape/strings),
   bump their versions, and test with the local runner.
5. Update `CONTEXT.md` (bundle names and dates, what changed) and `README.md`.
6. `node tools/check-privacy.js`, then commit.

A new city dump from the real app: `node tools/anonymise-city.js dump.json local/city.json`
(keep the dump itself out of the repo).

## Testing

```bash
node local/server.js --port 8123 &
node local/shot.js 'http://localhost:8123/?plugins=core,graphics' /tmp/city.png --wait 15000
```

Then look at the PNG. More in `CONTEXT.md` → "Testing without the real app" (walk mode, aiming,
holding cars). Playwright comes pre-installed in most agent environments (`NODE_PATH=$(npm root -g)`
if `require('playwright')` fails); otherwise `npm install`.

## Releases

A release is one commit to `main` (via the user's usual branch/PR flow) titled
`Release X.Y: <what changed>`, with:

- the changed scripts' own `@version` bumped,
- the loader's `@version` bumped to `X.Y` **and** every `?v=` on its `@require` lines set to `X.Y`
  (that's what makes Tampermonkey fetch the scripts again),
- `README.md` updated (versions in the table, new features).
