# k6 ADF Performance Tests

End-to-end performance tests for the Azure Data Factory pipeline. Written in k6
(plain JS, no npm dependencies) and wired into Azure DevOps as a PR branch policy
gate and a nightly scheduled run.

---

## Repo layout

```
.pipelines/
  perf-gate.yml      # PR-gate pipeline (runs load.js)
  perf-nightly.yml   # Nightly pipeline (runs smoke.js)
tests/
  lib/
    auth.js          # Azure AD service-principal token exchange
    blob.js          # Azure Blob Storage PUT helper
    adf.js           # ADF pipeline trigger + status poll
    payload.js       # Synthetic record generator
  scenarios/
    smoke.js         # 1 VU × 1 iteration — sanity check
    load.js          # 5 VU × 5 min — PR gate / load test
  thresholds/
    gate.json        # Shared k6 threshold definitions
results/             # JUnit XML written here at runtime (git-ignored)
```

---

## Prerequisites

Install [k6](https://k6.io/docs/get-started/installation/):

```bash
# macOS
brew install k6

# Ubuntu / Debian
sudo gpg --no-default-keyring \
  --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

---

## Running locally

Export all required environment variables, then run the desired scenario.

```bash
export TENANT_ID="<Azure AD tenant ID>"
export CLIENT_ID="<App registration client ID>"
export CLIENT_SECRET="<App registration client secret>"
export SUBSCRIPTION_ID="<Azure subscription ID>"
export RESOURCE_GROUP="<Resource group name>"
export ADF_FACTORY_NAME="<Data Factory name>"
export ADF_PIPELINE_NAME="<Pipeline name>"
export STORAGE_ACCOUNT_NAME="<Storage account name>"
export BLOB_CONTAINER_NAME="<Container name>"

# Smoke test (1 run, fast sanity check)
k6 run tests/scenarios/smoke.js

# Load test (5 VUs × 5 minutes)
k6 run tests/scenarios/load.js
```

JUnit XML is written to `results/summary.xml` at the end of each load.js run.

---

## Scenarios

| Scenario | VUs | Duration | Purpose |
|---|---|---|---|
| `smoke.js` | 1 | 1 iteration | Sanity check — verifies the full flow works end-to-end once |
| `load.js` | 5 | 5 minutes | Load gate — catches performance regressions before merge |

Both scenarios execute the same flow per VU iteration:

1. Obtain two bearer tokens (management scope for ADF, storage scope for blob)
2. Generate 10–100 synthetic transaction records
3. Upload the records to the Blob Storage container via the REST API
4. Trigger the ADF pipeline
5. Poll every 10 s until the run reaches `Succeeded`, `Failed`, or `Cancelled` (timeout 10 min)
6. Assert `Succeeded` and record the duration as `adf_pipeline_duration_ms`

---

## Thresholds (`tests/thresholds/gate.json`)

| Metric | Threshold |
|---|---|
| `http_req_failed` | `rate < 1 %` |
| `http_req_duration` | `p(95) < 2 000 ms` |
| `adf_pipeline_duration_ms` | `p(95) < 600 000 ms` (10 min) |

Edit `gate.json` to tighten or relax thresholds without touching test logic.

---

## Azure DevOps setup

### 1 — Create the variable group

In Azure DevOps go to **Pipelines → Library → + Variable group** and create a
group named exactly **`perf-tests-secrets`**. Add the following secrets (mark
each as secret / lock icon):

| Variable | What it is | Where to find it |
|---|---|---|
| `TENANT_ID` | Azure AD tenant ID | Azure Portal → Azure Active Directory → Overview |
| `CLIENT_ID` | App registration client / application ID | Azure Portal → Azure AD → App registrations → your app → Overview |
| `CLIENT_SECRET` | App registration client secret **value** | Azure Portal → App registrations → your app → Certificates & secrets → New client secret |
| `SUBSCRIPTION_ID` | Azure subscription ID | Azure Portal → Subscriptions → your subscription |
| `RESOURCE_GROUP` | Resource group containing the ADF instance | Azure Portal → Resource groups |
| `ADF_FACTORY_NAME` | Data Factory resource name | Azure Portal → Data factories |
| `ADF_PIPELINE_NAME` | Name of the pipeline to trigger | ADF Studio → Author tab → Pipelines |
| `STORAGE_ACCOUNT_NAME` | Storage account that hosts the blob container | Azure Portal → Storage accounts |
| `BLOB_CONTAINER_NAME` | Container name where source data is uploaded | Storage account → Containers |

The service principal (identified by `CLIENT_ID`) must have:
- **Contributor** or **Data Factory Contributor** on the ADF instance
- **Storage Blob Data Contributor** on the storage account / container

### 2 — Import the pipelines

1. In Azure DevOps go to **Pipelines → New pipeline → Azure Repos Git** (or GitHub).
2. Select **Existing Azure Pipelines YAML file**.
3. Choose `.pipelines/perf-gate.yml` → Save (do **not** run yet).
4. Repeat for `.pipelines/perf-nightly.yml`.

### 3 — Link `perf-gate` as a branch policy

1. Go to **Repos → Branches → `main` → Branch policies**.
2. Under **Build validation** click **+**.
3. Select the `perf-gate` pipeline.
4. Set **Trigger**: Automatic, **Policy requirement**: Required.
5. Save.

PRs targeting `main` will now run the load test automatically.
