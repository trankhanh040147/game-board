# Deploying the Game Board

The repository ships **five independent Vercel projects**. Each game has its own
URL; the board links out to them and reads those URLs from `data/deploy.json`.

| Vercel project   | Deployed from          | Framework | Build command                             | Output          |
| ---------------- | ---------------------- | --------- | ----------------------------------------- | --------------- |
| `game-board`     | repo root (`.`)        | Vite      | `npm run build`                           | `dist`          |
| `first-hearth`   | `games/first-hearth`   | Vite      | `npm run build` (`tsc --noEmit && vite build`) | `dist`     |
| `blade-and-mount`| `games/blade-and-mount`| Vite      | `npm run build` (`tsc --noEmit && vite build`) | `dist`     |
| `alien-shooter`  | `games/alien-shooter`  | Other (`null`) | `mkdir -p dist && cp -R index.html css js screenshots dist/` | `dist` |
| `city-sim`       | `games/city-sim`       | Vite      | `pnpm build` (`tsc --noEmit && vite build`), `pnpm install --frozen-lockfile` | `dist` |

Nothing here needs environment variables, secrets, a database or a server
runtime. All five projects are static output.

---

## 0. Prerequisites

- Node **20.19+** (the repo is verified on Node 26; Vercel's default 22.x is fine
  for Vite 7/8 — see [Known risks](#7-known-risks)).
- `npm` and `npx` (no global Vercel install is required; every command below uses
  `npx --yes vercel@latest`).
- The repo checked out locally, dependencies *not* required — Vercel installs
  them remotely.

## 1. Authenticate (one time, interactive)

```bash
npx vercel login
npx vercel whoami        # should print your username/team, not "Logged out"
```

`scripts/deploy.sh` never logs in for you. Without auth it stops with exit code
`3` and prints this exact command.

## 2. One-command deploy

```bash
./scripts/deploy.sh
```

What it does, in order:

1. Preflight — checks `node`, `npx`, `curl`, the root board app files and all
   four `vercel.json` files.
2. Auth check — `npx vercel whoami`; exits `3` if logged out.
3. For each project, from its own directory:
   `npx --yes vercel@latest deploy --prod --yes --project <name> --create-if-missing`
   (creates the project on first run, re-deploys the same project on every later
   run — the script is idempotent).
4. Verifies every production URL: HTTP `200` **and** the expected `<title>`.
5. Verifies the board SPA routes `/`, `/making-of`, `/making-of/<game-slug>` and
   `/about` resolve (requires the board rewrite in the root `vercel.json`).
6. Writes `data/deploy.json` (see [§5](#5-data-deployjson)) and prints a summary
   table.

Useful flags:

| Flag | Effect |
| --- | --- |
| `--build` | Runs the local production build for all four projects first (slow: `blade-and-mount` pulls ~150 MB of deps). Vercel still builds remotely. |
| `--only <name>` | Restricts the run to one project, e.g. `--only first-hearth`. Repeatable. Useful after a single game changes. Still rewrites only that entry in `data/deploy.json`. |
| `--verify-only` | Re-checks the URLs recorded in `data/deploy.json` without deploying. |
| `--no-spa-check` | Skips the board route checks. |
| `--dry-run` | Prints the plan; changes nothing. |

Exit codes: `0` all good · `1` a step failed · `2` bad usage · `3` not authenticated.

To override the Vercel team/scope:

```bash
VERCEL_SCOPE=my-team ./scripts/deploy.sh
```

## 3. The dashboard equivalent (manual path)

If you would rather connect the GitHub repo to Vercel instead of deploying from
the CLI, create **four** projects and use these exact settings. The values match
the committed `vercel.json` files, so both paths produce the same deployment.

For every project: **Add New… → Project → Import Git Repository →
`trankhanh040147/game-board`**, then set:

### 3.1 `game-board`

| Setting | Value |
| --- | --- |
| Root Directory | `.` (repository root) — *not* `apps/…`, leave empty/`.` |
| Framework Preset | **Vite** |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | default (`npm install`, lockfile respected) |
| Development Command | `npm run dev` (optional) |
| Node.js Version | 22.x (default) |
| Environment Variables | **none** |

`game-board/vercel.json` at the repo root adds the SPA rewrite
(`/(.*)` → `/index.html` with `assets/*` excluded) and cache headers. The board
build imports `data/registry.json` and `data/telemetry/games.json`; the root
`.vercelignore` keeps `games/`, `shots/`, `docs/` and `scripts/` out of the
board upload while keeping `data/` (build input) in.

### 3.1.1 Upload ignore lists (why `tools/` must stay for first-hearth)

Each project also carries a `.vercelignore` that trims the upload without
touching anything the build reads:

- root: `games/`, `shots/`, `docs/`, `scripts/`, `node_modules/`, `dist/` — the
  board imports `data/`, so `data/` stays.
- `games/first-hearth`: `shots/`, `docs/` — **`tools/` must stay uploaded**.
  `tsconfig.json` includes `tests/`, and `tests/helpers.ts` imports
  `../tools/autoplay`; dropping `tools/` makes `tsc --noEmit` fail on Vercel with
  `TS2307: Cannot find module '../tools/autoplay'` even though the local build
  passes (the files exist locally).
- `games/blade-and-mount`: `shots/`, `docs/`, `tools/`, `assets-src/` — its tests
  do not import `tools/`, and the build is verified with those excluded.
- `games/alien-shooter`: no ignore list needed; the whole folder is the site.

### 3.2 `first-hearth`

| Setting | Value |
| --- | --- |
| Root Directory | `games/first-hearth` |
| Framework Preset | **Vite** |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Node.js Version | 22.x |
| Environment Variables | **none** |

`games/first-hearth/vercel.json` pins the build command/output and adds
`Cache-Control: public, max-age=31536000, immutable` for `/assets/*` (all
filenames are content-hashed) and `must-revalidate` for `index.html`.

### 3.3 `blade-and-mount`

| Setting | Value |
| --- | --- |
| Root Directory | `games/blade-and-mount` |
| Framework Preset | **Vite** |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Node.js Version | 22.x |
| Environment Variables | **none** |

Same cache headers as `first-hearth` via `games/blade-and-mount/vercel.json`.

### 3.4 `alien-shooter`

| Setting | Value |
| --- | --- |
| Root Directory | `games/alien-shooter` |
| Framework Preset | **Other** (`"framework": null` in `vercel.json`) |
| Build Command | `mkdir -p dist && cp -R index.html css js screenshots dist/` |
| Output Directory | `dist` |
| Node.js Version | 22.x |
| Environment Variables | **none** |

There is no `package.json` here — the "build" only stages the static files.
`README.md` is intentionally not copied. `games/alien-shooter/vercel.json` holds
the staging command, the output directory and short-lived cache headers for the
non-hashed `js/`, `css/` and `screenshots/` assets.

### 3.5 If you use the dashboard instead of the CLI

1. Import the repo four times (one project per row above).
2. Set **Root Directory** per project **before** the first build.
3. Leave `vercel.json` in the repo — it supplies the headers and is a readable
   record of the settings; the dashboard values above take precedence if the two
   ever drift.
4. Attach custom domains later if wanted: **Project → Settings → Domains**.
   Nothing in the build depends on the domain.
5. GitHub integration is optional. Without it, deploy with
   `./scripts/deploy.sh` (or the `npx vercel deploy …` line in §4).

### 3.6 Creating the projects without the dashboard

The CLI creates projects on first deploy, which is what `scripts/deploy.sh` does:

```bash
cd games/first-hearth
npx --yes vercel@latest deploy --prod --yes --project first-hearth --create-if-missing
```

Project names must be exactly `game-board`, `first-hearth`, `blade-and-mount`,
`alien-shooter` — the expected production aliases are
`https://<name>.vercel.app` and the board's links assume them when
`data/deploy.json` is missing.

## 4. Deploying a single project by hand

```bash
# board (repo root)
npx --yes vercel@latest deploy --prod --yes --project game-board --create-if-missing

# a game
cd games/blade-and-mount
npx --yes vercel@latest deploy --prod --yes --project blade-and-mount --create-if-missing
```

`--project` deploys the current directory to that project without writing a
`.vercel/` link file. If you run a bare `npx vercel deploy` instead, a `.vercel/`
directory is created locally — it is git-ignored and must never be committed.

## 5. `data/deploy.json`

After a successful run the script writes (and the board site reads):

```json
{
  "generatedAt": "2026-11-01T08:00:00.000Z",
  "games": {
    "first-hearth":   { "url": "https://first-hearth.vercel.app",   "deployedAt": "2026-11-01T07:58:11.000Z" },
    "blade-and-mount":{ "url": "https://blade-and-mount.vercel.app","deployedAt": "2026-11-01T07:58:29.000Z" },
    "alien-shooter":  { "url": "https://alien-shooter.vercel.app",  "deployedAt": "2026-11-01T07:58:33.000Z" }
  },
  "board": { "url": "https://game-board.vercel.app", "deployedAt": "2026-11-01T07:59:02.000Z" }
}
```

The file is committed **without** secrets — it only contains public production
URLs. Existing entries are preserved when a project is skipped or fails, so a
partial run cannot silently blank out a working URL.

Production aliases after the first deploy:

| Project | Production URL | Note |
| --- | --- | --- |
| `first-hearth` | <https://first-hearth.vercel.app> | canonical alias |
| `blade-and-mount` | <https://blade-and-mount.vercel.app> | canonical alias |
| `alien-shooter` | <https://alien-shooter-omega.vercel.app> | `alien-shooter.vercel.app` was already taken by another account, so Vercel assigned the `-omega` alias |
| `city-sim` | <https://city-sim-six.vercel.app> | created by `vercel deploy --prod --project city-sim --create-if-missing`; `games/city-sim/pnpm-workspace.yaml` allows esbuild's build script so a frozen-lockfile pnpm 10/11 install passes |
| `game-board` | <https://game-board-pi.vercel.app> | `game-board.vercel.app` was taken, so Vercel assigned `-pi` |

`data/deploy.json` is the authoritative list of URLs the board links to; do not
hard-code them elsewhere. A re-deploy keeps the same production alias.

## 6. Verifying a deploy

```bash
# status codes for all four (URLs from data/deploy.json — aliases can differ)
node -e '
  const j = require("./data/deploy.json");
  const urls = [j.board?.url, ...Object.values(j.games || {}).map((g) => g.url)].filter(Boolean);
  console.log(urls.join("\n"));
' | while read -r u; do printf '%s -> %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' "$u")"; done

# expected document titles
#   game-board        whatever <title> the site ships (script reads it from index.html)
#   first-hearth      First Hearth — A Living Civilization
#   blade-and-mount   Blade & Mount — Tournament of the Realm
#   alien-shooter     ALIEN SHOOTER — Neon Arena
curl -s https://first-hearth.vercel.app | grep -o '<title>[^<]*</title>'

# board SPA routes (each must return 200 and the board shell)
BOARD_URL="$(node -e 'console.log(require("./data/deploy.json").board?.url || "")')"
for p in / /making-of /making-of/first-hearth /making-of/blade-and-mount \
         /making-of/alien-shooter /about; do
  printf '%s -> %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "${BOARD_URL%/}$p")"
done

# re-verify without redeploying
./scripts/deploy.sh --verify-only
```

## 7. Known risks

| Risk | Detail | Mitigation |
| --- | --- | --- |
| **WebGL bundle weight** | `blade-and-mount` ships a `1.04 MB` JS bundle (≈285 kB gzip) plus a 576 kB animation JSON. `first-hearth` is `864 kB` JS (≈267 kB gzip). | Vite content-hashes assets and `vercel.json` marks `/assets/*` immutable, so repeat visits are cached. Sizes are fine for static hosting; they are only a first-load cost. |
| **Node version on Vercel** | Vite 7/8 need Node ≥ 20.19/22.12. Vercel's default 22.x satisfies this. If a project is pinned to an older Node, the build fails on `crypto.hash`/ESM APIs. | Keep Node.js Version at `22.x` (dashboard: Project → Settings → General → Node.js Version). |
| **SPA routes 404 on the board** | Vercel serves static files; `/making-of/<slug>` only resolves because the root `vercel.json` rewrites unknown paths to `/index.html`. The deploy script fails the SPA check when that rewrite is missing. | Root `vercel.json` is owned by the site task; do not remove its `rewrites` entry. |
| **Board upload size** | The repo carries ~560 MB of `shots/` evidence and the full game sources. Uploading the root with no ignore rules would be slow and hit limits. | Root `.vercelignore` excludes `games/`, `shots/`, `docs/`, `scripts/`. Keep `data/` included — the board imports it at build time. |
| **Project name collision** | If a project name is already taken on Vercel, the production alias is not exactly `<name>.vercel.app`. | The script verifies the URL the CLI reports and falls back to the canonical alias; the recorded URL in `data/deploy.json` is always the one that returned 200. |
| **Deployment protection** | New Vercel projects can enable deployment protection, which makes project URLs return 401/403 even after a successful build. | Keep protection disabled for these public projects (Settings → Deployment Protection). Otherwise `--verify-only` reports the exact failing status. |
| **First deploy is slower** | The first build of each project installs dependencies from scratch (a few minutes for `blade-and-mount`). | Later deploys reuse the build cache. |
| **No secrets here** | There are no environment variables, tokens or `.env` files involved. `.vercel/` is git-ignored. | Never commit `.vercel/` or `~/.vercel` contents. |

## 8. Rollback

Instant rollback (recommended — no rebuild):

```bash
npx --yes vercel@latest ls game-board            # list deployments, newest first
npx --yes vercel@latest rollback <deployment-url> --yes
npx --yes vercel@latest promote <deployment-url> # any project, promote a specific deployment
```

Dashboard equivalent: **Project → Deployments → the previous good deployment →
⋯ → Instant Rollback** (or "Promote to Production").

Redeploying the previous commit is equivalent to rolling back if the rollback
window has expired:

```bash
git checkout <previous-good-commit>
./scripts/deploy.sh --only <project>
```

`data/deploy.json` records the URL, not the deployment id; after a rollback the
URL is unchanged, so the board keeps linking to the same (now rolled-back)
deployment.

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Vercel CLI is not authenticated` (exit 3) | Run `npx vercel login`, then re-run `./scripts/deploy.sh`. |
| `board app not ready: package.json is missing at repo root` | The board site has not landed yet. Deploy the games first with `--only <game>`, or wait for the board files. |
| `missing deploy config: games/<slug>/vercel.json` | A per-project config was deleted. Restore it from git before deploying. |
| Build fails with `tsc: command not found` | Dev dependencies were pruned (`NODE_ENV=production` during install). Vercel installs devDependencies by default; do not set that variable. |
| Verification fails on title only | The expected title in `scripts/deploy.sh` is the document `<title>` after HTML-entity decoding (`&amp;` → `&`). Update the `PROJECTS` table if the site changes a title. |
| **Board deep links return Vercel's plain-text `NOT_FOUND`** (while `/` is 200) | `cleanUrls: true` in the root `vercel.json` makes Vercel redirect `/index.html` back to `/`, so a catch-all rewrite whose destination is `/index.html` resolves to nothing. Keep `cleanUrls: false` together with `rewrites: [{ "source": "/(.*)", "destination": "/index.html" }]`. The `scripts/deploy.sh` SPA check catches this. |
| A stale hashed asset path returns 200 `text/html` instead of 404 | Expected SPA behaviour: the catch-all rewrite serves the app shell for any unknown path, including asset hashes from an older build. Current assets (referenced by the live `index.html`) are served with the right content types. |
| `curl` gets 401/403 | Deployment protection is on — disable it for public projects. |
