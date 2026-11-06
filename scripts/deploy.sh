#!/usr/bin/env bash
#
# scripts/deploy.sh — deploy the Game Board and its games to Vercel.
#
# Five independent Vercel projects, all built and deployed from this monorepo:
#
#   game-board       <- repo root             (the showcase site)
#   first-hearth     <- games/first-hearth
#   blade-and-mount  <- games/blade-and-mount
#   alien-shooter    <- games/alien-shooter
#   city-sim         <- games/city-sim
#
# The script is idempotent: re-running it re-deploys the same five projects to
# production and rewrites data/deploy.json. It never logs in (run
# `npx vercel login` yourself), never creates a project under another name and
# never writes secrets.
#
# Usage:
#   npx vercel login             # once, interactively
#   ./scripts/deploy.sh          # deploy all five + verify + write data/deploy.json
#
# Flags:
#   --build         run the local production build for every project first
#                   (slow for blade-and-mount; Vercel builds remotely anyway)
#   --verify-only   do not deploy; re-verify the URLs recorded in data/deploy.json
#   --only <name>   restrict to one project (repeatable), e.g. --only first-hearth
#   --no-spa-check  skip the board SPA-route check (/making-of/<slug>, /about)
#   --dry-run       print the plan, change nothing
#   -h, --help      show this help
#
# Exit codes: 0 ok · 1 one or more steps failed · 2 bad usage · 3 not authenticated

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEPLOY_JSON="$ROOT/data/deploy.json"
VERCEL_SCOPE="${VERCEL_SCOPE:-}"
VERCEL_VERSION="${VERCEL_VERSION:-latest}"
VC=(npx --yes "vercel@${VERCEL_VERSION}")

BUILD_PREFLIGHT=0
VERIFY_ONLY=0
DRY_RUN=0
SPA_CHECK=1
ONLY=()

# name | directory | expected document title | kind
PROJECTS=(
  "game-board|.|@@board-title@@|board"
  "first-hearth|games/first-hearth|First Hearth — A Living Civilization|game"
  "blade-and-mount|games/blade-and-mount|Blade & Mount — Tournament of the Realm|game"
  "alien-shooter|games/alien-shooter|ALIEN SHOOTER — Neon Arena|game"
  "city-sim|games/city-sim|Sunmeadow Isles — Miniature 3D City Builder|game"
)

TMP_FILES=()
SUMMARY=()
FAILURES=0
WARNINGS=0

cleanup() {
  if [ "${#TMP_FILES[@]}" -gt 0 ]; then
    rm -f "${TMP_FILES[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------- output helpers
c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_dim=$'\033[2m'
c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_cya=$'\033[36m'
if [ ! -t 1 ]; then c_reset=''; c_bold=''; c_dim=''; c_red=''; c_grn=''; c_yel=''; c_cya=''; fi

log()  { printf '%s\n' "${c_cya}▸${c_reset} $*"; }
ok()   { printf '%s\n' "${c_grn}✓${c_reset} $*"; }
warn() { printf '%s\n' "${c_yel}!${c_reset} $*"; WARNINGS=$((WARNINGS + 1)); }
err()  { printf '%s\n' "${c_red}✗${c_reset} $*" >&2; }
fail() { err "$*"; FAILURES=$((FAILURES + 1)); }

usage() {
  awk 'NR > 1 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "${BASH_SOURCE[0]}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --build)        BUILD_PREFLIGHT=1 ;;
    --verify-only)  VERIFY_ONLY=1 ;;
    --no-spa-check) SPA_CHECK=0 ;;
    --dry-run)      DRY_RUN=1 ;;
    --only)
      shift
      [ "$#" -gt 0 ] || { err "--only needs a project name"; exit 2; }
      ONLY+=("$1")
      ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown flag: $1"; usage; exit 2 ;;
  esac
  shift
done

selected() {
  local name="$1" want
  [ "${#ONLY[@]}" -eq 0 ] && return 0
  for want in "${ONLY[@]}"; do
    [ "$want" = "$name" ] && return 0
  done
  return 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "missing required command: $1"; exit 2; }
}

# Decode the handful of HTML entities that can appear in a page <title>.
decode_title() {
  printf '%s' "$1" | sed 's/&amp;/\&/g; s/&lt;/\</g; s/&gt;/\>/g; s/&quot;/\"/g; s/&#39;/'"'"'/g'
}

page_title() {
  local file="$1"
  grep -o '<title>[^<]*</title>' "$file" 2>/dev/null | head -n 1 \
    | sed -e 's/^<title>//' -e 's/<\/title>$//' || true
}

# ---------------------------------------------------------------- preconditions
require_cmd node
require_cmd npx
require_cmd curl

# The board lives at the repo root and is owned by the site task; when only
# games are selected (`--only <game>`) the board files may not exist yet.
if selected game-board; then
  [ -f "$ROOT/package.json" ] || { err "board app not ready: package.json is missing at repo root (owned by the site task)"; exit 1; }
  [ -f "$ROOT/index.html" ] || { err "board app not ready: index.html is missing at repo root (owned by the site task)"; exit 1; }
  [ -f "$ROOT/vercel.json" ] || warn "root vercel.json missing — board SPA routes (/making-of/<slug>) will 404 until the site task lands it"
fi

for p in "${PROJECTS[@]}"; do
  IFS='|' read -r name dir title kind <<<"$p"
  selected "$name" || continue
  [ -f "$ROOT/$dir/vercel.json" ] || fail "missing deploy config: ${dir}/vercel.json"
done
[ "$FAILURES" -eq 0 ] || { err "aborting: deploy config is incomplete"; exit 1; }

# Board title is whatever the site ships; fall back to the project name.
BOARD_TITLE="$(decode_title "$(page_title "$ROOT/index.html")")"
[ -n "$BOARD_TITLE" ] || BOARD_TITLE="Game Board"

AUTH_HELP="Run:  npx vercel login   (then re-run ./scripts/deploy.sh)"

check_auth() {
  local out
  if ! out="$("${VC[@]}" whoami 2>&1)"; then
    err "Vercel CLI is not authenticated."
    printf '%s\n' "${c_dim}${out}${c_reset}" >&2
    printf '\n  %s\n\n' "${c_bold}${AUTH_HELP}${c_reset}"
    exit 3
  fi
  if printf '%s' "$out" | grep -q "Logged out"; then
    err "Vercel CLI is not authenticated."
    printf '\n  %s\n\n' "${c_bold}${AUTH_HELP}${c_reset}"
    exit 3
  fi
  log "authenticated as: $(printf '%s\n' "$out" | tail -n 1)"
}

# ---------------------------------------------------------------- build preflight
local_build() {
  local name="$1" dir="$2"
  case "$name" in
    alien-shooter)
      ( cd "$ROOT/$dir" && rm -rf dist && sh -c 'mkdir -p dist && cp -R index.html css js screenshots dist/' )
      ;;
    city-sim)
      ( cd "$ROOT/$dir" && pnpm install --frozen-lockfile && pnpm build )
      ;;
    *)
      ( cd "$ROOT/$dir" && npm install --no-audit --no-fund --loglevel=error && npm run build )
      ;;
  esac
}

# ---------------------------------------------------------------- deploy
# Deploys one project to production. Sets DEPLOYED_URL on success.
deploy_one() {
  local name="$1" dir="$2" workdir out
  workdir="$ROOT/$dir"
  local args=(deploy --prod --yes --project "$name" --create-if-missing)
  [ -n "$VERCEL_SCOPE" ] && args=(--scope "$VERCEL_SCOPE" "${args[@]}")

  log "deploying ${c_bold}${name}${c_reset} (${dir}) → production"
  if ! out="$(cd "$workdir" && "${VC[@]}" "${args[@]}" 2>&1)"; then
    fail "[$name] deploy failed"
    printf '%s\n' "$out" | tail -n 40 | sed 's/^/    /'
    return 1
  fi
  printf '%s\n' "$out" | tail -n 3 | sed 's/^/    /'

  DEPLOYED_URL="$(printf '%s\n' "$out" | sed -n 's/.*[Pp]roduction: \(https:\/\/[^ ]*\).*/\1/p' | tail -n 1)"
  if [ -z "$DEPLOYED_URL" ]; then
    DEPLOYED_URL="$(printf '%s\n' "$out" | grep -Eo 'https://[A-Za-z0-9._-]+\.vercel\.app' | tail -n 1 || true)"
  fi
  if [ -z "$DEPLOYED_URL" ]; then
    DEPLOYED_URL="https://${name}.vercel.app"
    warn "[$name] could not parse the deployment URL; assuming ${DEPLOYED_URL}"
  fi
  return 0
}

# ---------------------------------------------------------------- verification
# Polls a URL until it serves 200 with the expected <title>.
# Sets LAST_CODE to the most recent HTTP status so callers can distinguish
# "wrong page" (200, no point trying another host) from "not reachable yet".
LAST_CODE=""
verify_candidate() {
  local name="$1" url="$2" expected="$3" attempt=1 code body got
  body="$(mktemp)"; TMP_FILES+=("$body")

  while [ "$attempt" -le 10 ]; do
    code="$(curl -s -o "$body" -w '%{http_code}' --max-time 30 "$url" 2>/dev/null || true)"
    LAST_CODE="$code"
    if [ "$code" = "200" ]; then
      got="$(decode_title "$(page_title "$body")")"
      if [ "$got" = "$expected" ]; then
        ok "[$name] 200 ${url}"
        printf '    title: %s\n' "$got"
        return 0
      fi
      err "[$name] ${url} returned 200 but title is '${got}' (expected '${expected}')"
      return 1
    fi
    sleep 3
    attempt=$((attempt + 1))
  done
  err "[$name] ${url} did not return 200 (last status: ${code:-no response})"
  return 1
}

# Tries the parsed production URL, then the canonical <project>.vercel.app alias.
verify_project() {
  local name="$1" url="$2" expected="$3"
  [ -n "$url" ] || { fail "[$name] no URL to verify"; return 1; }
  if verify_candidate "$name" "$url" "$expected"; then return 0; fi
  # Only fall back to the canonical alias when the parsed host did not answer
  # with a page at all; a 200 with the wrong document means the deploy is live
  # but serving the wrong build, which the alias cannot fix.
  if [ "$LAST_CODE" != "200" ] && [ "$url" != "https://${name}.vercel.app" ] \
     && verify_candidate "$name" "https://${name}.vercel.app" "$expected"; then
    DEPLOYED_URL="https://${name}.vercel.app"
    return 0
  fi
  fail "[$name] verification failed for ${url}"
  return 1
}

check_spa_routes() {
  local board_url="$1" raw code body
  local routes=("/" "/making-of" "/about")
  body="$(mktemp)"; TMP_FILES+=("$body")
  for raw in first-hearth blade-and-mount alien-shooter; do routes+=("/making-of/${raw}"); done
  for raw in "${routes[@]}"; do
    code="$(curl -s -o "$body" -w '%{http_code}' --max-time 30 "${board_url%/}${raw}" 2>/dev/null || true)"
    if [ "$code" = "200" ] && grep -Eqi '<title>' "$body"; then
      ok "[board] ${raw} → 200"
    else
      fail "[board] ${raw} → ${code:-no response} (SPA rewrite missing — see docs/DEPLOY.md)"
    fi
  done
}

# ---------------------------------------------------------------- data/deploy.json
write_deploy_json() {
  mkdir -p "$(dirname "$DEPLOY_JSON")"
  DEPLOY_JSON="$DEPLOY_JSON" \
  BOARD_URL="${URL_game_board:-}" BOARD_AT="${AT_game_board:-}" \
  FH_URL="${URL_first_hearth:-}" FH_AT="${AT_first_hearth:-}" \
  BAM_URL="${URL_blade_and_mount:-}" BAM_AT="${AT_blade_and_mount:-}" \
  AS_URL="${URL_alien_shooter:-}" AS_AT="${AT_alien_shooter:-}" \
  CS_URL="${URL_city_sim:-}" CS_AT="${AT_city_sim:-}" \
  node -e '
    const fs = require("fs");
    const file = process.env.DEPLOY_JSON;
    const now = new Date().toISOString();
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { prev = {}; }
    const out = {
      generatedAt: now,
      games: { ...(prev.games || {}) },
      board: { ...(prev.board || {}) },
    };
    const put = (slug, url, at) => {
      if (!url) return;
      const stored = slug === null ? out.board : (out.games[slug] || {});
      const entry = { url, deployedAt: at || stored.deployedAt || now };
      if (slug === null) out.board = entry;
      else out.games[slug] = entry;
    };
    put(null, process.env.BOARD_URL, process.env.BOARD_AT);
    put("first-hearth", process.env.FH_URL, process.env.FH_AT);
    put("blade-and-mount", process.env.BAM_URL, process.env.BAM_AT);
    put("alien-shooter", process.env.AS_URL, process.env.AS_AT);
    put("city-sim", process.env.CS_URL, process.env.CS_AT);
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
    console.log(`  wrote ${file}`);
  '
}

# ---------------------------------------------------------------- main
printf '\n%s\n' "${c_bold}Game Board → Vercel${c_reset} ${c_dim}$(date -u '+%Y-%m-%dT%H:%M:%SZ')${c_reset}"
printf '%s\n\n' "${c_dim}repo: ${ROOT}${c_reset}"

if [ "$VERIFY_ONLY" -eq 0 ]; then
  check_auth
else
  log "verify-only: skipping the auth check"
fi

if [ "$BUILD_PREFLIGHT" -eq 1 ]; then
  for p in "${PROJECTS[@]}"; do
    IFS='|' read -r name dir title kind <<<"$p"
    selected "$name" || continue
    log "local build check: ${name}"
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '  would build in %s\n' "$dir"
      continue
    fi
    logfile="/tmp/game-board-build-${name}.log"
    if local_build "$name" "$dir" >"$logfile" 2>&1; then
      ok "[$name] local build ok (log: ${logfile})"
    else
      fail "[$name] local build failed (log: ${logfile})"
      tail -n 25 "$logfile" | sed 's/^/    /'
    fi
  done
  [ "$FAILURES" -eq 0 ] || { err "aborting: fix local builds before deploying"; exit 1; }
fi

# URLs already recorded (used by --verify-only and as a fallback for the board check).
URL_game_board=""; URL_first_hearth=""; URL_blade_and_mount=""; URL_alien_shooter=""; URL_city_sim=""
AT_game_board=""; AT_first_hearth=""; AT_blade_and_mount=""; AT_alien_shooter=""; AT_city_sim=""

if [ -f "$DEPLOY_JSON" ]; then
  while IFS=$'\t' read -r slug url; do
    [ -n "$slug" ] || continue
    case "$slug" in
      board)           URL_game_board="$url" ;;
      first-hearth)    URL_first_hearth="$url" ;;
      blade-and-mount) URL_blade_and_mount="$url" ;;
      alien-shooter)   URL_alien_shooter="$url" ;;
      city-sim)        URL_city_sim="$url" ;;
    esac
  done < <(node -e '
    try {
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (j.board && j.board.url) console.log("board\t" + j.board.url);
      for (const [slug, g] of Object.entries(j.games || {})) if (g && g.url) console.log(slug + "\t" + g.url);
    } catch (_) {}
  ' "$DEPLOY_JSON" 2>/dev/null || true)
fi

record_result() { SUMMARY+=("$1|$2|$3"); }

url_for() {
  case "$1" in
    game-board)      printf '%s' "$URL_game_board" ;;
    first-hearth)    printf '%s' "$URL_first_hearth" ;;
    blade-and-mount) printf '%s' "$URL_blade_and_mount" ;;
    alien-shooter)   printf '%s' "$URL_alien_shooter" ;;
    city-sim)        printf '%s' "$URL_city_sim" ;;
  esac
}

set_url() {
  case "$1" in
    game-board)      URL_game_board="$2" ;;
    first-hearth)    URL_first_hearth="$2" ;;
    blade-and-mount) URL_blade_and_mount="$2" ;;
    alien-shooter)   URL_alien_shooter="$2" ;;
    city-sim)        URL_city_sim="$2" ;;
  esac
}

set_ts() {
  case "$1" in
    game-board)      AT_game_board="$2" ;;
    first-hearth)    AT_first_hearth="$2" ;;
    blade-and-mount) AT_blade_and_mount="$2" ;;
    alien-shooter)   AT_alien_shooter="$2" ;;
    city-sim)        AT_city_sim="$2" ;;
  esac
}

for p in "${PROJECTS[@]}"; do
  IFS='|' read -r name dir title kind <<<"$p"
  selected "$name" || continue
  expected="$title"
  [ "$name" = "game-board" ] && expected="$BOARD_TITLE"

  if [ "$VERIFY_ONLY" -eq 1 ]; then
    url="$(url_for "$name")"
    if [ -z "$url" ]; then
      fail "[$name] no recorded URL in data/deploy.json — run a deploy first"
      record_result "$name" "—" "NO URL"
      continue
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '  would verify %s (%s)\n' "$url" "$name"
      continue
    fi
    if verify_project "$name" "$url" "$expected"; then
      record_result "$name" "$url" "200 · title ok"
    else
      record_result "$name" "$url" "FAIL"
    fi
    continue
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  would deploy %s from %s → project %s\n' "$name" "$dir" "$name"
    continue
  fi

  DEPLOYED_URL=""
  if ! deploy_one "$name" "$dir"; then
    record_result "$name" "—" "DEPLOY FAILED"
    continue
  fi
  url="$DEPLOYED_URL"
  set_url "$name" "$url"

  sleep 2
  if verify_project "$name" "$url" "$expected"; then
    url="$(url_for "$name")"
    record_result "$name" "$url" "200 · title ok"
    set_ts "$name" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  else
    record_result "$name" "$url" "FAIL"
  fi
done

if [ "$SPA_CHECK" -eq 1 ] && [ "$VERIFY_ONLY" -eq 0 ] && [ "$DRY_RUN" -eq 0 ] && [ -n "$URL_game_board" ]; then
  log "verifying board SPA routes on ${URL_game_board}"
  check_spa_routes "$URL_game_board"
fi

if [ "$DRY_RUN" -eq 0 ]; then
  write_deploy_json
fi

printf '\n%s\n' "${c_bold}Summary${c_reset}"
printf '%-16s %-52s %s\n' "PROJECT" "URL" "CHECK"
printf '%s\n' "--------------------------------------------------------------------------------"
if [ "${#SUMMARY[@]}" -gt 0 ]; then
  for row in "${SUMMARY[@]}"; do
    IFS='|' read -r n u s <<<"$row"
    printf '%-16s %-52s %s\n' "$n" "$u" "$s"
  done
fi
printf '\n'

if [ "$FAILURES" -ne 0 ]; then
  err "${FAILURES} failure(s), ${WARNINGS} warning(s)"
  exit 1
fi
[ "$WARNINGS" -ne 0 ] && warn "${WARNINGS} warning(s)"
if [ "$DRY_RUN" -eq 1 ]; then
  ok "dry run complete — nothing was deployed or written"
elif [ "$VERIFY_ONLY" -eq 1 ]; then
  ok "verification complete"
else
  ok "all projects deployed and verified"
fi
