# Put Lattice online: Netlify and Cloud Run

You only need to choose three things: a Netlify site, a dedicated Google Cloud
project with billing enabled, and a hosted sign-in provider. The scripts create
Lattice's database, image registry, secrets and deployment identities. You do not
need to create individual Cloud Run services in the Google console.

The public recorded demo works as soon as Netlify builds the repository. The live
operator interface additionally needs the backend and sign-in setup below.
Google Cloud SQL and the always-running Cloud Run instance incur charges while
idle; a Google Cloud budget alert is useful, but it is not a spending cap.

## The quick way: one script

Steps 2 to 6 also run as one script in Cloud Shell. Connect Netlify (step 1) and
create the Google Cloud project with billing (step 2, items 1 to 4). Then, in Cloud
Shell, either upload `infrastructure/cloud-run/put-online.sh` with the terminal's
**More → Upload** and run `bash put-online.sh`, or run this from a checkout:

```bash
bash infrastructure/cloud-run/put-online.sh
```

It signs you into GitHub, asks for your Netlify address, creates the Google Cloud
resources, prepares the Keycloak import file and asks for the realm issuer, saves
the GitHub deployment settings after showing them, runs the deploy, and prints the
two Netlify values. If Keycloak isn't ready yet, press Enter at the issuer prompt
and it stops there. Run it again at any time, including after Cloud Shell
disconnects: finished steps are skipped. The sections below describe each step.

## 1. Connect Netlify

In Netlify, import `0vertrained/Lattice`, select `main`, and use its checked-in
`netlify.toml`. It specifies the base directory, build command and publish folder.
Do not add backend variables yet. The recorded demo needs none.

Choose any available site name. `lattice-0vertrained` is one possible name if it
is available; the product and GitHub repository can still be named **Lattice**.
Copy the actual production URL Netlify gives you, such as
`https://YOUR-ACTUAL-SITE.netlify.app`, without a trailing slash. Use that URL,
not a branch-preview URL, in the remaining steps.

## 2. Create the Google Cloud project

1. Open the [Google Cloud console](https://console.cloud.google.com/).
2. Create a new project for Lattice and link a billing account.
3. Select that project in the console's project selector.
4. Open **Cloud Shell** using the terminal button in the console header.

Use `us-central1` for this demo unless you have a specific regional requirement.
The project's **ID** is the identifier needed below; it can differ from the
friendly name displayed in the console.

Run these commands in Cloud Shell:

```bash
export LATTICE_PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"
export LATTICE_REGION=us-central1
gcloud projects describe "$LATTICE_PROJECT_ID" --format='table(projectId,name)'
gcloud billing projects describe "$LATTICE_PROJECT_ID" --format='value(billingEnabled)'
```

Check that the displayed project is the new Lattice project and billing says
`True`. Then sign into GitHub through its normal browser flow and obtain the code.
The repository is private, so sign in before cloning. Step 5 needs `gh` 2.31 or
newer (`gh --version`); `put-online.sh` installs a current one when it's older.

```bash
command -v gh || { sudo apt-get update && sudo apt-get install -y gh; }
gh auth login --hostname github.com --git-protocol https --web
gh repo clone 0vertrained/Lattice
cd Lattice
read -r -p 'Paste your actual Netlify HTTPS origin, with no trailing slash: ' LATTICE_SITE_ORIGIN
export LATTICE_SITE_ORIGIN
```

Sign into the `0vertrained` account when GitHub opens. You do not need to create,
paste into this conversation, or store a Google service-account key. GitHub
Actions will use short-lived Workload Identity Federation credentials.

## 3. Create the backend resources

Still inside the Lattice checkout in Cloud Shell:

```bash
LATTICE_REPOSITORY_ID="$(gh api repos/0vertrained/Lattice --jq .id)"
bash infrastructure/cloud-run/setup-gcp.sh \
  "$LATTICE_PROJECT_ID" "$LATTICE_REPOSITORY_ID" "$LATTICE_REGION"
```

Google takes 5 to 15 minutes to create the database; the script prints its progress
every minute. If Cloud Shell disconnects meanwhile, run the same command again: the
database keeps building and the script resumes waiting. The script
creates dedicated Lattice resources: one Cloud SQL database, an Artifact Registry
repository, two Secret Manager entries, runtime/deployment service accounts, and
a GitHub federation provider restricted to this repository and `main`.

It preserves an existing signing identity and refuses to silently reset a
previous database user's missing credentials. On an error, keep the output and
fix that error before deploying. Re-running the script resumes existing setup.

## 4. Set up sign-in without operating another server

Use **managed Keycloak**, for example a hosted Keycloak offering from
[Cloud-IAM](https://www.cloud-iam.com/). Choose a maintained HTTPS instance with
realm administration access. Pricing and available plans belong to the provider.
This is the direct fit for Lattice's existing, locally tested sign-in contract;
no Auth0-specific claims adapter or extra identity server needs to be developed.

Generate the import files in Cloud Shell:

```bash
python3 infrastructure/cloud-run/keycloak-config.py \
  --site-origin "$LATTICE_SITE_ORIGIN"
```

Use Cloud Shell's **Download file** action to download
`Lattice/target/identity-import/lattice-realm.json`. In the hosted Keycloak admin
console, use **Create realm → Browse** to import it. It creates the `lattice`
realm, the `lattice-ui` public client, the API audience mapper, and the three
Lattice roles. The file contains no users or passwords.

If your hosted plan supplies a single existing realm and does not permit creating
another, download `lattice-client.json` instead and use **Clients → Import client**
in that realm. Add the realm roles `lattice-viewer`, `lattice-operator` and
`lattice-admin`. Keep the imported client ID `lattice-ui`, PKCE `S256`, audience
`lattice-api`, and exact redirect URI `YOUR_NETLIFY_ORIGIN/operator.html`. The
standard client scopes `basic`, `roles`, `profile`, `email`, and `web-origins`
must be available; the realm's access-token signing algorithm must remain RS256.

Create your named user, set its password in Keycloak, and assign `lattice-admin`.
Enable MFA for that administrator. The general public does not need an account to
view the recorded tour. Additional live-demo viewers should receive only
`lattice-viewer`.

Copy the realm's **issuer** from its OpenID Connect discovery document. It is
usually shaped like `https://YOUR-IDENTITY-HOST/realms/lattice`, but an existing
managed realm may have another name. Use its exact issuer, not the admin-console
URL. The next helper reads discovery and obtains the JWKS URL automatically.

## 5. Connect GitHub deployment and deploy

Back in Cloud Shell:

```bash
read -r -p 'Paste the exact HTTPS Keycloak realm issuer: ' LATTICE_ISSUER
export LATTICE_ISSUER
python3 infrastructure/cloud-run/configure-github.py \
  --project "$LATTICE_PROJECT_ID" --region "$LATTICE_REGION" \
  --site-origin "$LATTICE_SITE_ORIGIN" --issuer "$LATTICE_ISSUER"
```

This prints a preview and writes `target/hosted-release`. It derives the project
number, WIF provider, deployment account and JWKS URL. The values are configuration
metadata, not credentials. Check the project, Netlify URL and issuer, then save:

```bash
python3 infrastructure/cloud-run/configure-github.py \
  --project "$LATTICE_PROJECT_ID" --region "$LATTICE_REGION" \
  --site-origin "$LATTICE_SITE_ORIGIN" --issuer "$LATTICE_ISSUER" --apply
gh workflow run deploy-hosted.yml --repo 0vertrained/Lattice --ref main
```

Open the repository's **Actions → Deploy hosted Lattice** run and wait for it to
succeed. The job builds immutable images, deploys the core with its private
inference sidecar, and checks readiness and unauthenticated access rejection.
The output tells you the `LATTICE_API_ORIGIN` value. You can also retrieve it with:

```bash
gcloud run services describe lattice-core \
  --project "$LATTICE_PROJECT_ID" --region "$LATTICE_REGION" \
  --format='value(status.url)'
```

The workflow artifact includes the reviewed map and deployed service manifest.
It does not prove that a physical simulator is online; that is the last step.

## 6. Enable Netlify sign-in

Add two **build environment variables** to your Netlify site and trigger a new
production deploy:

| Variable | Value |
| --- | --- |
| `LATTICE_API_ORIGIN` | The HTTPS Cloud Run service URL from step 5, without a trailing slash |
| `LATTICE_IDENTITY_ORIGIN` | The origin of your Keycloak service, without `/realms/...` or a trailing slash |

For example, issuer `https://identity.example/realms/lattice` has identity origin
`https://identity.example`. These are public addresses, not passwords.

Open `YOUR_NETLIFY_ORIGIN/operator.html`, sign in, and confirm your administrator
role. The public tour remains available at the site's root. The frontend proxies
API calls to Cloud Run; no service-account or signing credentials go into Netlify.

## 7. Connect the robots when you want a live demonstration

The core can be online without a robot. Gazebo and MuJoCo must run on a persistent
Linux machine with the repository's simulation prerequisites; this managed coding
session is not a guaranteed always-running simulator host.

In the operator interface, issue one device credential for `gazebo-rover` and a
separate one for `mujoco-go1`. Keep each one-time token in a private file on that
machine. Follow [the paired hosted runner instructions](HOSTED_DEMO.md#4-connect-netlify-and-the-simulated-bodies).
The runner validates the files and starts only the simulators/body adapters; the
database and signing identity remain in Cloud Run.

Verify both bodies online, complete a reviewed route, and then test the blocked
path/replan and connection-loss cases. Until those checks pass against the actual
hosted core, describe the deployment as configured or reachable, not as a verified
live robotics service.
