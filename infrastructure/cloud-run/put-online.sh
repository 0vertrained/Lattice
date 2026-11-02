#!/usr/bin/env bash
# Puts Lattice online from Google Cloud Shell: the Google Cloud backend, sign-in, the deploy from GitHub, and the
# two addresses Netlify needs. In the Cloud Shell terminal of your Lattice project, run:
#
#   bash put-online.sh
#
# It works uploaded on its own or from infrastructure/cloud-run/ in a checkout. It is safe to run again: each step
# checks what already exists and carries on from there, so if Cloud Shell disconnects, run it again.
# It never asks for, prints or stores a password, key or token. GitHub and Google sign you in with their own
# pages, and the only answers it keeps (in ~/.config/lattice/hosting.env) are public addresses.
set -euo pipefail

REPOSITORY=0vertrained/Lattice
STATE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/lattice/hosting.env"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
say() { printf '  %s\n' "$@"; }
stop() { printf '\n' >&2; printf '%s\n' "$@" >&2; exit 1; }
ask() { local reply; read -r -p "  $1 " reply; printf '%s' "$reply"; }
agree() { local reply; read -r -p "  $1 [y/N] " reply; [[ "$reply" =~ ^[Yy]([Ee][Ss])?$ ]]; }
recall() { if [[ -f "$STATE_FILE" ]]; then sed -n "s/^$1=//p" "$STATE_FILE" | tail -n 1; fi; }
remember() {
  (
    umask 077
    mkdir -p "$(dirname "$STATE_FILE")"
    touch "$STATE_FILE"
    { grep -v "^$1=" "$STATE_FILE" || true; printf '%s=%s\n' "$1" "$2"; } > "$STATE_FILE.new"
    mv "$STATE_FILE.new" "$STATE_FILE"
  )
}

# gh 2.31 added the variable commands this needs; distribution packages can be older. Installs the current release
# into ~/.local/bin, which Cloud Shell keeps between sessions, after checking it against the published checksums.
ensure_gh() {
  export PATH="$HOME/.local/bin:$PATH"
  if command -v gh > /dev/null && gh variable list --help > /dev/null 2>&1; then return 0; fi
  say 'Installing the current GitHub command-line tool into ~/.local/bin...'
  local tag version arch dir
  tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest)
  tag=${tag##*/}
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || stop "Couldn't find the latest GitHub CLI release (got '$tag')."
  version=${tag#v}
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) stop "No GitHub CLI build for $(uname -m)." ;;
  esac
  dir=$(mktemp -d)
  local file="gh_${version}_linux_${arch}.tar.gz"
  curl -fsSL -o "$dir/$file" "https://github.com/cli/cli/releases/download/$tag/$file"
  curl -fsSL -o "$dir/checksums.txt" "https://github.com/cli/cli/releases/download/$tag/gh_${version}_checksums.txt"
  (cd "$dir" && grep " $file\$" checksums.txt | sha256sum --check --quiet --strict) ||
    stop 'The GitHub CLI download did not match its published checksum; nothing was installed.'
  tar -xzf "$dir/$file" -C "$dir"
  mkdir -p "$HOME/.local/bin"
  install -m 755 "$dir/gh_${version}_linux_${arch}/bin/gh" "$HOME/.local/bin/gh"
  rm -rf "$dir"
}

# A production Netlify origin: https, no path or trailing slash, and not a deploy-preview address.
site_ok() {
  [[ -n "$2" && "$2" != *--*.netlify.app ]] &&
    python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); from render import https; https({"site": sys.argv[2]}, "site", origin=True)' \
      "$1/infrastructure/cloud-run" "$2" 2> /dev/null
}

main() {
  for tool in gcloud git python3 curl; do
    command -v "$tool" > /dev/null || stop "This needs $tool. Run it in Google Cloud Shell, which has everything it needs."
  done

  step 'Google Cloud project'
  local project region name billing
  project="${LATTICE_PROJECT_ID:-$(gcloud config get-value project 2> /dev/null || true)}"
  [[ -n "$project" ]] ||
    stop 'No Google Cloud project is selected. Pick your Lattice project in the console header, or run: gcloud config set project YOUR_PROJECT_ID' \
      'Then run this again.'
  region="${LATTICE_REGION:-$(recall LATTICE_REGION)}"
  region="${region:-us-central1}"
  name=$(gcloud projects describe "$project" --format='value(name)') ||
    stop "Couldn't read project $project. Check the project ID and that Cloud Shell is signed in to the right Google account."
  say "Project: $project ($name), region $region"
  if [[ "$(recall LATTICE_PROJECT_ID)" != "$project" ]]; then
    say 'This creates resources that bill while idle: a small Cloud SQL database and an always-on Cloud Run service.'
    agree 'Set up Lattice in this project?' ||
      stop 'Nothing was changed. To use another project: gcloud config set project YOUR_PROJECT_ID, then run this again.'
    remember LATTICE_PROJECT_ID "$project"
  fi
  remember LATTICE_REGION "$region"
  billing=$(gcloud billing projects describe "$project" --format='value(billingEnabled)' < /dev/null 2> /dev/null || true)
  if [[ "$billing" == False ]]; then
    stop "Billing isn't turned on for $project. Link a billing account (console menu > Billing), then run this again."
  fi

  step 'GitHub'
  ensure_gh
  if ! gh auth status --hostname github.com > /dev/null 2>&1; then
    say 'Sign in as 0vertrained. Copy the one-time code shown below, then open the address it gives you.'
    gh auth login --hostname github.com --git-protocol https --web
  fi
  gh auth setup-git --hostname github.com
  local repo_id
  repo_id=$(gh api "repos/$REPOSITORY" --jq .id 2> /dev/null) ||
    stop "This GitHub sign-in can't see $REPOSITORY. Sign in as 0vertrained with: gh auth login --web" 'Then run this again.'
  [[ "$(gh api "repos/$REPOSITORY" --jq .permissions.admin)" == true ]] ||
    stop "The signed-in GitHub account can't change $REPOSITORY's settings. Sign in as 0vertrained with: gh auth login --web"
  say "Signed in as $(gh api user --jq .login)"

  step 'Lattice code'
  local here root updated=0
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  if root=$(git -C "$here" rev-parse --show-toplevel 2> /dev/null) && [[ -f "$root/infrastructure/cloud-run/setup-gcp.sh" ]]; then
    :
  elif [[ -d "$HOME/Lattice/.git" ]]; then
    root="$HOME/Lattice"
  else
    say 'Downloading it to ~/Lattice...'
    gh repo clone "$REPOSITORY" "$HOME/Lattice" -- --quiet
    root="$HOME/Lattice"
  fi
  [[ "$(git -C "$root" remote get-url origin | tr '[:upper:]' '[:lower:]')" =~ github\.com[:/]0vertrained/lattice(\.git)?$ ]] ||
    stop "$root is not a copy of $REPOSITORY."
  git -C "$root" fetch --quiet origin main
  if [[ "$(git -C "$root" rev-parse HEAD)" != "$(git -C "$root" rev-parse origin/main)" ]]; then
    if [[ "$(git -C "$root" branch --show-current)" != main ]] || ! git -C "$root" diff --quiet HEAD; then
      stop "$root has local changes or isn't on main. Set them aside with: cd $root && git stash && git checkout main" \
        'Then run this again.'
    fi
    git -C "$root" merge --quiet --ff-only origin/main ||
      stop "Couldn't bring $root up to date: it has commits that aren't on GitHub."
    updated=1
  fi
  say "Using $root at $(git -C "$root" log -1 --format='%h, %s')"
  # Carry on with the newest copy of this script whenever the code changed under it.
  local latest="$root/infrastructure/cloud-run/put-online.sh"
  if [[ -z "${LATTICE_PUT_ONLINE:-}" && -f "$latest" ]] && { ((updated)) || ! cmp -s "${BASH_SOURCE[0]}" "$latest"; }; then
    say 'Continuing with the updated copy of this script.'
    LATTICE_PUT_ONLINE=1 exec bash "$latest"
  fi
  export LATTICE_PUT_ONLINE=1

  step 'Netlify site'
  local site="${LATTICE_SITE_ORIGIN:-$(recall LATTICE_SITE_ORIGIN)}"
  site="${site%/}"
  until site_ok "$root" "$site"; do
    [[ -z "$site" ]] || say "That isn't a production https address without a path, like https://your-site.netlify.app"
    site=$(ask 'Paste your Netlify site address (Site overview shows it):')
    site="${site%/}"
  done
  remember LATTICE_SITE_ORIGIN "$site"
  say "Site: $site"

  step 'Google Cloud resources: database, image registry, secrets and the deploy identity'
  say 'The first run waits while Google creates the database, usually 5-15 minutes. Later runs take seconds.'
  bash "$root/infrastructure/cloud-run/setup-gcp.sh" "$project" "$repo_id" "$region"

  step 'Sign-in (a hosted Keycloak)'
  local import="$root/target/identity-import"
  python3 "$root/infrastructure/cloud-run/keycloak-config.py" --site-origin "$site" > /dev/null
  local issuer="${LATTICE_ISSUER:-$(recall LATTICE_OIDC_ISSUER)}"
  if [[ -z "$issuer" ]]; then
    cat << EOF
  Lattice signs people in with a hosted Keycloak, such as Cloud-IAM's managed Keycloak. In its admin console:
    1. Create realm > Browse, and pick lattice-realm.json. Your browser is downloading it now; it is also at
       $import/lattice-realm.json
       It adds the lattice-ui client and the three Lattice roles. It contains no users or passwords.
       If your plan allows only one realm, import lattice-client.json from the same folder into that realm
       (Clients > Import client) and add the roles lattice-viewer, lattice-operator and lattice-admin.
    2. Users > Add user for yourself, set a password, assign the lattice-admin role, and turn on MFA.
    3. In Realm settings, open the OpenID Endpoint Configuration link and copy the "issuer" value.
       It looks like https://YOUR-HOST/realms/lattice
EOF
    if command -v cloudshell > /dev/null; then cloudshell download "$import/lattice-realm.json" || true; fi
    issuer=$(ask 'Paste the issuer, or press Enter to stop here and continue later:')
    if [[ -z "$issuer" ]]; then
      step 'Paused at sign-in'
      say 'Run this script again once Keycloak is set up. It picks up from here.'
      exit 0
    fi
  fi

  step 'Deployment settings in GitHub'
  local wanted="$root/target/hosted-release/workflow-variables.json"
  if ! python3 "$root/infrastructure/cloud-run/configure-github.py" --project "$project" --region "$region" \
    --site-origin "$site" --issuer "$issuer" > /dev/null; then
    remember LATTICE_OIDC_ISSUER ''
    stop 'Check the issuer: it must be the realm issuer, like https://YOUR-HOST/realms/lattice, from the realm' \
      "where you imported Lattice. Then run this again."
  fi
  remember LATTICE_OIDC_ISSUER "$issuer"
  if gh variable list --repo "$REPOSITORY" --json name,value | python3 -c '
import json, sys
wanted = json.load(open(sys.argv[1]))
current = {item["name"]: item["value"] for item in json.load(sys.stdin)}
sys.exit(0 if all(current.get(name) == value for name, value in wanted.items()) else 1)' "$wanted"; then
    say 'GitHub already has these settings.'
  else
    python3 -c 'import json, sys; [print(f"    {k:<28} {v}") for k, v in json.load(open(sys.argv[1])).items()]' "$wanted"
    agree 'Save these to the repository? They are addresses and IDs, not secrets.' ||
      stop 'Nothing was saved. Run this again when you are ready.'
    python3 "$root/infrastructure/cloud-run/configure-github.py" --project "$project" --region "$region" \
      --site-origin "$site" --issuer "$issuer" --apply > /dev/null
    say 'Saved.'
  fi

  step 'Build and deploy'
  local url run_id='' last
  url=$(gcloud run services describe lattice-core --region "$region" --project "$project" --format='value(status.url)' 2> /dev/null || true)
  run_id=$(gh run list --repo "$REPOSITORY" --workflow deploy-hosted.yml --limit 10 --json databaseId,status \
    --jq '[.[] | select(.status != "completed")][0].databaseId // empty')
  if [[ -n "$run_id" ]]; then
    say 'A deploy is already running. Following it.'
  elif [[ -z "$url" ]] || agree "Lattice is already deployed at $url. Deploy the latest main again?"; then
    last=$(gh run list --repo "$REPOSITORY" --workflow deploy-hosted.yml --limit 1 --json databaseId --jq '.[0].databaseId // 0')
    gh workflow run deploy-hosted.yml --repo "$REPOSITORY" --ref main
    for _ in $(seq 1 30); do
      run_id=$(gh run list --repo "$REPOSITORY" --workflow deploy-hosted.yml --limit 5 --json databaseId \
        --jq "[.[] | select(.databaseId > $last)][0].databaseId // empty")
      [[ -z "$run_id" ]] || break
      sleep 2
    done
    [[ -n "$run_id" ]] ||
      stop "The deploy started but hasn't appeared yet. Follow it at https://github.com/$REPOSITORY/actions" \
        'and run this again afterwards.'
  fi
  if [[ -n "$run_id" ]]; then
    say 'This usually takes 15-25 minutes, most of it compiling the Rust core.'
    say "Progress: https://github.com/$REPOSITORY/actions/runs/$run_id"
    say 'If Cloud Shell disconnects, the deploy carries on at GitHub. Run this again to pick up.'
    gh run watch "$run_id" --repo "$REPOSITORY" --exit-status --interval 30 ||
      stop "The deploy failed. Its log: https://github.com/$REPOSITORY/actions/runs/$run_id"
    url=$(gcloud run services describe lattice-core --region "$region" --project "$project" --format='value(status.url)')
  fi
  curl -fsS --max-time 20 -o /dev/null "$url/ready" ||
    stop "The backend at $url isn't answering yet. Give it a minute and run this again."
  say "Backend: $url"

  local identity
  identity=$(python3 -c 'import sys; from urllib.parse import urlparse; u = urlparse(sys.argv[1]); print(f"{u.scheme}://{u.netloc}")' "$issuer")
  if curl -fsS --max-time 20 "$site/api/v1/auth/config" 2> /dev/null | python3 -c '
import json, sys
config = json.load(sys.stdin)
sys.exit(0 if config.get("mode") == "oidc" and config.get("issuer") == sys.argv[1] else 1)' "$issuer" 2> /dev/null; then
    step 'Lattice is online'
    say "Public tour:       $site"
    say "Operator console:  $site/operator.html (sign in with your Keycloak user)"
    say 'Robots: to run a live demo, connect the simulators from a Linux machine (docs/HOSTED_DEMO.md, section 4).'
  else
    step 'Netlify'
    cat << EOF
  One manual step left. In Netlify, open your site > Site configuration > Environment variables and add these two.
  They are public addresses, so leave "Contains secret values" off:

    LATTICE_API_ORIGIN        $url
    LATTICE_IDENTITY_ORIGIN   $identity

  Then Deploys > Trigger deploy > Deploy site. When it finishes, run this script again: it checks the connection
  and prints your links.
EOF
  fi
}

# The whole script is read before anything runs, so updating the checkout underneath it is safe.
main "$@"; exit
