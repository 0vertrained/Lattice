#!/usr/bin/env bash
# Run in an authenticated Cloud Shell. Creates dedicated Lattice resources, never Caduceus resources.
set -euo pipefail
PROJECT="${1:?usage: setup-gcp.sh PROJECT_ID GITHUB_REPOSITORY_ID [REGION]}"
REPO_ID="${2:?Supply the immutable GitHub repository ID for 0vertrained/Lattice}"
REGION="${3:-us-central1}"
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ && "$REPO_ID" =~ ^[0-9]+$ && "$REGION" =~ ^[a-z]+-[a-z]+[1-9][0-9]*$ ]] || {
  echo 'Supply a valid 6–30 character GCP project ID, numeric repository ID, and region.' >&2; exit 1;
}
command -v gcloud >/dev/null || { echo 'Run this script in authenticated Cloud Shell or install the Google Cloud CLI first.' >&2; exit 1; }
export CLOUDSDK_CORE_PROJECT="$PROJECT"
exists() { "$@" > /dev/null 2>&1; }
retry() { for _ in 1 2 3 4 5 6; do "$@" > /dev/null && return 0; sleep 5; done; "$@" > /dev/null; }
# Creating Cloud SQL takes several minutes. Wait for it here rather than inside the create call, so a rerun after
# a closed Cloud Shell tab resumes the wait instead of failing on an instance that is still being created.
wait_for_database() {
  local state started=$SECONDS shown=-1
  while true; do
    state=$(gcloud sql instances describe lattice-db --format='value(state)' 2>/dev/null) || state=''
    case "$state" in
      RUNNABLE) return 0 ;;
      PENDING_CREATE|MAINTENANCE|REPAIRING|'') ;;
      *) echo "Cloud SQL instance lattice-db is $state. Resolve it in the console, then run this script again." >&2; exit 1 ;;
    esac
    if (( SECONDS - started > ${LATTICE_DATABASE_WAIT_SECONDS:-2700} )); then
      echo 'Cloud SQL is still not ready. It keeps building on its own; run this script again later to continue.' >&2; exit 1
    fi
    if (( (SECONDS - started) / 60 != shown )); then
      shown=$(( (SECONDS - started) / 60 ))
      echo "Waiting for Cloud SQL to finish creating lattice-db ($shown min so far; this usually takes 5-15 minutes)."
    fi
    sleep "${LATTICE_POLL_SECONDS:-15}"
  done
}
NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
RUNTIME="lattice-runtime@$PROJECT.iam.gserviceaccount.com"
DEPLOYER="lattice-deployer@$PROJECT.iam.gserviceaccount.com"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com sqladmin.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com
exists gcloud artifacts repositories describe lattice --location "$REGION" || gcloud artifacts repositories create lattice --repository-format docker --location "$REGION"
for name in lattice-runtime lattice-deployer; do
  exists gcloud iam service-accounts describe "$name@$PROJECT.iam.gserviceaccount.com" || gcloud iam service-accounts create "$name"
done
exists gcloud sql instances describe lattice-db || gcloud sql instances create lattice-db --database-version POSTGRES_16 --tier db-f1-micro --region "$REGION" --edition ENTERPRISE --storage-size 10 --backup-start-time 04:00 --enable-point-in-time-recovery --deletion-protection --async
wait_for_database
exists gcloud sql databases describe lattice --instance lattice-db || gcloud sql databases create lattice --instance lattice-db
# Never regenerate a stable signing identity on rerun. No secret enters shell arguments or build context.
if ! exists gcloud secrets describe lattice-signing-seed; then
  python3 -c 'import secrets,base64;print(base64.b64encode(secrets.token_bytes(32)).decode(),end="")' | gcloud secrets create lattice-signing-seed --replication-policy automatic --data-file=-
fi
if ! exists gcloud secrets describe lattice-database-url; then
  work=$(mktemp -d); chmod 700 "$work"; trap 'rm -rf "$work"' EXIT
  python3 - "$work" "$PROJECT" "$REGION" <<'PY'
import json,secrets,sys
from pathlib import Path
from urllib.parse import quote
root,project,region=Path(sys.argv[1]),sys.argv[2],sys.argv[3]
password=secrets.token_hex(32)
# gcloud --flags-file keys are flag names, leading dashes included; bare keys are rejected as
# unrecognized arguments and echoed back, password and all.
(root/'db-flags.yaml').write_text(json.dumps({'--instance':'lattice-db','--password':password}))
(root/'database-url').write_text(f'postgres://lattice:{password}@/lattice?host={quote(f"/cloudsql/{project}:{region}:lattice-db",safe="")}')
for path in root.iterdir():path.chmod(0o600)
PY
  if gcloud sql users list --instance lattice-db --format='value(name)' | grep -qx lattice; then
    echo 'Database user exists without its stored connection secret. Restore the secret; refusing to reset credentials.' >&2; exit 1
  fi
  gcloud sql users create lattice --flags-file "$work/db-flags.yaml"
  gcloud secrets create lattice-database-url --replication-policy automatic --data-file "$work/database-url"
fi
for secret in lattice-database-url lattice-signing-seed; do
  retry gcloud secrets add-iam-policy-binding "$secret" --member "serviceAccount:$RUNTIME" --role roles/secretmanager.secretAccessor
done
retry gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$RUNTIME" --role roles/cloudsql.client --condition None
# Run admin is needed to configure invoker access. Prefer a dedicated demo project.
retry gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$DEPLOYER" --role roles/run.admin --condition None
retry gcloud iam service-accounts add-iam-policy-binding "$RUNTIME" --member "serviceAccount:$DEPLOYER" --role roles/iam.serviceAccountUser
retry gcloud artifacts repositories add-iam-policy-binding lattice --location "$REGION" --member "serviceAccount:$DEPLOYER" --role roles/artifactregistry.writer
exists gcloud iam workload-identity-pools describe lattice-github --location global || gcloud iam workload-identity-pools create lattice-github --location global --display-name 'Lattice GitHub deployments'
exists gcloud iam workload-identity-pools providers describe lattice --location global --workload-identity-pool lattice-github || gcloud iam workload-identity-pools providers create-oidc lattice --location global --workload-identity-pool lattice-github --issuer-uri https://token.actions.githubusercontent.com --attribute-mapping 'google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref' --attribute-condition "assertion.repository_id == '$REPO_ID' && assertion.ref == 'refs/heads/main'"
retry gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --role roles/iam.workloadIdentityUser --member "principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/lattice-github/attribute.repository_id/$REPO_ID"
cat <<OUTPUT
Set these GitHub Actions repository variables:
GCP_PROJECT=$PROJECT
GCP_REGION=$REGION
GCP_WIF_PROVIDER=projects/$NUMBER/locations/global/workloadIdentityPools/lattice-github/providers/lattice
GCP_DEPLOY_SERVICE_ACCOUNT=$DEPLOYER
Also set LATTICE_SITE_ORIGIN, LATTICE_OIDC_ISSUER and LATTICE_OIDC_JWKS_URL.
Then run the Deploy hosted Lattice workflow from main. See docs/HOSTED_DEMO.md.
OUTPUT
