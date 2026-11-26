# Agent instructions

Savings City – After Dark: Tampermonkey userscripts that add things to the Savings City web app, plus a
local copy of that app (`app/`) and example data, so the scripts can be developed and tested here.
All code for the project lives in this one repo: scripts, app copy, example data, tools and docs.
Read `README.md` for how the app runs and how releases are built.

## Privacy rules (apply to every file, including commit messages and this file)

1. **No web addresses.** Don't write `http://` or `https://` addresses, `www.` names, hostnames, IP addresses,
   or links to an owner, organisation, repository, session or account. Use the placeholder
   `https://your-savings-city-host.example/*` for the app's address, and `localhost` for local testing.
   Allowed exceptions are public references that are not about this project: three.js, the W3C namespace
   strings (`http://www.w3.org/...`), and the Tampermonkey documentation. `npm run check` lists the allowed prefixes.
2. **No personal information.** No names of people, usernames, owner or organisation names, email addresses,
   phone numbers, account or session identifiers, or local file paths (a home folder, a user folder, the folder the original app was kept in). If a name or term must be kept out, add it to the local `.privacy-denylist`
   (never committed).
3. **The app must not reveal where it came from.** Nothing in `app/` may contain the original app's address,
   its source host, its repository, or a source-map reference to one. Source maps are never copied.
   If the original app has such content, remove it from the copy in `app/` (or from the sync result) — don't
   add an exception to the check.
4. **City data is anonymous.** Files in `examples/` use fictional, generic ids and invented numbers. No names,
   street addresses, coordinates, companies or any data from a real city. Never copy a real `city.json`,
   or a screenshot or log that shows one, into the repo.
5. **Run `npm run check` before every commit.** It must pass. Don't commit `dist/` (it contains the release address).

## Layout

| Path | What it is |
|---|---|
| `savings-city-*.user.js` | The userscripts: the source of truth. `savings-city-core.user.js` is the shared base. |
| `app/` | Copy of the original Savings City app (html, js, css), from `npm run sync`. |
| `examples/city.json` | Anonymous example of `GET /api/city` → `{revision, projects, roads}`. |
| `tools/sync-app.mjs` | Mirrors the newest html/js/css from an app folder into `app/`, then runs the privacy check. |
| `tools/dev-server.mjs` | Serves `app/` at `http://localhost:8080`, with `/api/city` from `examples/city.json`. |
| `tools/build-loader.mjs` | Builds `dist/` for a release: the loader with the release address, plus all scripts. |
| `tools/loader-template.user.js` | Loader header template: version and name. The `@require` list is in `build-loader.mjs`. |
| `tools/check-privacy.mjs` | Privacy check (see the rules above). |

## Workflows

**Getting the newest app** (when someone gives you html/js/css from the original app):
`npm run sync -- <folder>`. It replaces `app/` with the source's html/js/css and removes stale copies.
Then run `npm run check` and fix what it reports. Review the diff of `app/` before committing.

**Developing and testing a script:**
1. `npm run dev`, then open `http://localhost:8080` in a browser.
2. Load the script (or the loader) with `@match` covering `http://localhost:8080/*`.
3. Check the console for `[core]`/script log lines. Don't paste real city data into any output that is committed.

**Adding a new script:** create `savings-city-<name>.user.js` with the same header style as the others
(`@name`, `@namespace savings-city-tweaks`, `@version`, `@match` placeholder, `@run-at document-start`,
`@grant none`), then add it to `LOAD_ORDER` in `tools/build-loader.mjs`. The build fails until you do.

**Releasing:** bump the loader `@version` in `tools/loader-template.user.js`, bump `@version` in each changed
script, then `npm run build -- --base <https folder address>` and upload `dist/` to that folder. The address is
an argument at build time; it must not be written into any file in the repo.

## Conventions

- Plain Node.js (18+) ES modules for tools. No new dependencies unless the user asks for them.
- Commit messages follow the existing history, e.g. `Release 1.15: ...` or `Tools: ...`.
- Keep changes to the scripts' behaviour and their version numbers in step: a changed script gets a new `@version`.
