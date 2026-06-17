# k6 ADF Performance Test Suite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a k6 load-test suite that authenticates via service principal, uploads synthetic data to Azure Blob Storage, triggers an ADF pipeline, polls it to completion, asserts success, and publishes results as JUnit XML in Azure DevOps.

**Architecture:** Each library module (`auth`, `blob`, `adf`, `payload`) has a single responsibility and is imported by the two scenario scripts (`load.js`, `smoke.js`). Thresholds are externalised to `gate.json` so they can be adjusted without touching test logic. Two ADO pipeline YAMLs wire everything into PR-gate and nightly runs.

**Tech Stack:** k6 OSS (plain JS, no extensions), Azure AD OAuth2, Azure Blob Storage REST API, Azure Data Factory REST API, Azure DevOps pipelines.

---

## File Map

| File | Responsibility |
|---|---|
| `tests/lib/payload.js` | Generate synthetic transaction records (no network) |
| `tests/lib/auth.js` | Exchange SP credentials for a bearer token via Azure AD |
| `tests/lib/blob.js` | PUT a JSON blob to Azure Blob Storage REST API |
| `tests/lib/adf.js` | Trigger an ADF pipeline run and poll its status |
| `tests/thresholds/gate.json` | k6 threshold definitions (imported by scenario options) |
| `tests/scenarios/smoke.js` | 1 VU × 1 iteration sanity check |
| `tests/scenarios/load.js` | 5 VU × 5 min load test with JUnit summary |
| `.pipelines/perf-gate.yml` | ADO PR-gate pipeline (installs k6, runs load.js, publishes results) |
| `.pipelines/perf-nightly.yml` | ADO scheduled nightly pipeline (runs smoke.js) |
| `README.md` | Repo docs: local run, variable group setup, branch policy |

---

## Task 1: Create directory skeleton

**Files:**
- Create: `tests/lib/.gitkeep`
- Create: `tests/scenarios/.gitkeep`
- Create: `tests/thresholds/.gitkeep`
- Create: `.pipelines/.gitkeep`
- Create: `results/.gitkeep`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p tests/lib tests/scenarios tests/thresholds .pipelines results
touch tests/lib/.gitkeep tests/scenarios/.gitkeep tests/thresholds/.gitkeep .pipelines/.gitkeep results/.gitkeep
```

- [ ] **Step 2: Verify**

```bash
find . -type d | sort
```

Expected output includes: `./.pipelines`, `./results`, `./tests/lib`, `./tests/scenarios`, `./tests/thresholds`

- [ ] **Step 3: Commit**

```bash
git init
git add .
git commit -m "chore: initialise repo directory structure"
```

---

## Task 2: Implement `tests/lib/payload.js`

**Files:**
- Create: `tests/lib/payload.js`

- [ ] **Step 1: Create the file**

```javascript
// tests/lib/payload.js

const STATUSES = ['pending', 'completed', 'failed', 'refunded', 'processing'];
const SOURCES  = ['web', 'mobile', 'pos', 'api', 'batch'];

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export function generatePayload(count) {
  const records = [];
  for (let i = 0; i < count; i++) {
    records.push({
      id:        uuid(),
      timestamp: new Date(Date.now() - Math.floor(Math.random() * 86400000)).toISOString(),
      amount:    Math.round(Math.random() * 10000) / 100,
      status:    STATUSES[Math.floor(Math.random() * STATUSES.length)],
      source:    SOURCES[Math.floor(Math.random() * SOURCES.length)],
    });
  }
  return records;
}
```

- [ ] **Step 2: Write a minimal k6 smoke script to validate payload shape**

```javascript
// tests/lib/_payload_check.js  (delete after verification)
import { generatePayload } from './payload.js';
import { check } from 'k6';

export const options = { vus: 1, iterations: 1 };

export default function () {
  const records = generatePayload(5);
  check(records, {
    'returns 5 records':          (r) => r.length === 5,
    'each has id':                (r) => r.every(x => typeof x.id === 'string' && x.id.length === 36),
    'each has ISO timestamp':     (r) => r.every(x => !isNaN(Date.parse(x.timestamp))),
    'each has numeric amount':    (r) => r.every(x => typeof x.amount === 'number'),
    'each has valid status':      (r) => r.every(x => ['pending','completed','failed','refunded','processing'].includes(x.status)),
    'each has valid source':      (r) => r.every(x => ['web','mobile','pos','api','batch'].includes(x.source)),
  });
}
```

- [ ] **Step 3: Run validation**

```bash
k6 run tests/lib/_payload_check.js
```

Expected: all checks PASS, 0 failures.

- [ ] **Step 4: Remove the temporary check file**

```bash
rm tests/lib/_payload_check.js
```

- [ ] **Step 5: Commit**

```bash
git add tests/lib/payload.js
git commit -m "feat: add synthetic payload generator"
```

---

## Task 3: Implement `tests/lib/auth.js`

**Files:**
- Create: `tests/lib/auth.js`

- [ ] **Step 1: Create the file**

```javascript
// tests/lib/auth.js
import http from 'k6/http';
import { check } from 'k6';

/**
 * Exchange service-principal credentials for a bearer token.
 *
 * @param {string} tenantId
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} [scope='https://management.azure.com/.default']
 * @returns {string} access_token
 */
export function getServicePrincipalToken(
  tenantId,
  clientId,
  clientSecret,
  scope = 'https://management.azure.com/.default',
) {
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const payload = {
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
    scope,
  };

  const res = http.post(url, payload, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  check(res, {
    'auth: token endpoint returned 200': (r) => r.status === 200,
  });

  if (res.status !== 200) {
    console.error(`auth failed (${res.status}): ${res.body}`);
    return null;
  }

  return JSON.parse(res.body).access_token;
}
```

Note: scope is a 4th optional parameter so `load.js` can request `https://storage.azure.com/.default` for blob calls and `https://management.azure.com/.default` for ADF calls.

- [ ] **Step 2: Validate syntax only (no live credentials needed)**

```bash
k6 inspect tests/lib/auth.js 2>&1 | head -20
```

Expected: `k6 inspect` exits cleanly or reports the exported function (it will warn about no `default` export — that is fine for a lib file, k6 inspect will error on syntax issues).

- [ ] **Step 3: Commit**

```bash
git add tests/lib/auth.js
git commit -m "feat: add Azure AD service-principal token helper"
```

---

## Task 4: Implement `tests/lib/blob.js`

**Files:**
- Create: `tests/lib/blob.js`

- [ ] **Step 1: Create the file**

```javascript
// tests/lib/blob.js
import http from 'k6/http';
import { check } from 'k6';

/**
 * Upload a JSON payload as a block blob.
 *
 * @param {string} accountName   - Storage account name
 * @param {string} containerName - Container name
 * @param {string} blobName      - Blob path/name (e.g. "run-123.json")
 * @param {string} payload       - JSON string to upload
 * @param {string} token         - Bearer token (storage.azure.com scope)
 */
export function uploadBlob(accountName, containerName, blobName, payload, token) {
  const url = `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}`;

  const res = http.put(url, payload, {
    headers: {
      'Authorization':    `Bearer ${token}`,
      'Content-Type':     'application/json',
      'x-ms-blob-type':   'BlockBlob',
      'x-ms-version':     '2020-10-02',
    },
  });

  check(res, {
    'blob: upload returned 201': (r) => r.status === 201,
  });

  if (res.status !== 201) {
    console.error(`blob upload failed (${res.status}): ${res.body}`);
  }
}
```

- [ ] **Step 2: Syntax check**

```bash
k6 inspect tests/lib/blob.js 2>&1 | head -20
```

Expected: no syntax errors.

- [ ] **Step 3: Commit**

```bash
git add tests/lib/blob.js
git commit -m "feat: add Azure Blob Storage upload helper"
```

---

## Task 5: Implement `tests/lib/adf.js`

**Files:**
- Create: `tests/lib/adf.js`

- [ ] **Step 1: Create the file**

```javascript
// tests/lib/adf.js
import http from 'k6/http';
import { check } from 'k6';

const API_VERSION = '2018-06-01';

/**
 * Trigger an ADF pipeline run and return the runId.
 *
 * @param {string} subscriptionId
 * @param {string} resourceGroup
 * @param {string} factoryName
 * @param {string} pipelineName
 * @param {string} token  - Bearer token (management.azure.com scope)
 * @returns {string} runId
 */
export function triggerPipeline(subscriptionId, resourceGroup, factoryName, pipelineName, token) {
  const url = [
    'https://management.azure.com',
    'subscriptions', subscriptionId,
    'resourceGroups', resourceGroup,
    'providers/Microsoft.DataFactory/factories', factoryName,
    `pipelines/${pipelineName}/createRun?api-version=${API_VERSION}`,
  ].join('/');

  const res = http.post(url, '{}', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
  });

  check(res, {
    'adf: pipeline triggered (200)': (r) => r.status === 200,
  });

  if (res.status !== 200) {
    console.error(`triggerPipeline failed (${res.status}): ${res.body}`);
    return null;
  }

  return JSON.parse(res.body).runId;
}

/**
 * Fetch the current status of an ADF pipeline run.
 *
 * @param {string} subscriptionId
 * @param {string} resourceGroup
 * @param {string} factoryName
 * @param {string} runId
 * @param {string} token  - Bearer token (management.azure.com scope)
 * @returns {{ status: string, durationInMs?: number }} run info object
 */
export function getPipelineRunStatus(subscriptionId, resourceGroup, factoryName, runId, token) {
  const url = [
    'https://management.azure.com',
    'subscriptions', subscriptionId,
    'resourceGroups', resourceGroup,
    'providers/Microsoft.DataFactory/factories', factoryName,
    `pipelineruns/${runId}?api-version=${API_VERSION}`,
  ].join('/');

  const res = http.get(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  check(res, {
    'adf: run status retrieved (200)': (r) => r.status === 200,
  });

  if (res.status !== 200) {
    console.error(`getPipelineRunStatus failed (${res.status}): ${res.body}`);
    return { status: 'Unknown' };
  }

  return JSON.parse(res.body);
}
```

- [ ] **Step 2: Syntax check**

```bash
k6 inspect tests/lib/adf.js 2>&1 | head -20
```

Expected: no syntax errors.

- [ ] **Step 3: Commit**

```bash
git add tests/lib/adf.js
git commit -m "feat: add ADF pipeline trigger and status helpers"
```

---

## Task 6: Create `tests/thresholds/gate.json`

**Files:**
- Create: `tests/thresholds/gate.json`

k6 thresholds format: each key maps to an array of threshold strings.

- [ ] **Step 1: Create the file**

```json
{
  "http_req_failed":              ["rate<0.01"],
  "http_req_duration":            ["p(95)<2000"],
  "adf_pipeline_duration_ms":     ["p(95)<600000"]
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/thresholds/gate.json
git commit -m "feat: add externalised k6 threshold definitions"
```

---

## Task 7: Implement `tests/scenarios/smoke.js`

**Files:**
- Create: `tests/scenarios/smoke.js`

- [ ] **Step 1: Create the file**

```javascript
// tests/scenarios/smoke.js
import { Trend }  from 'k6/metrics';
import { sleep, check } from 'k6';
import { getServicePrincipalToken } from '../lib/auth.js';
import { uploadBlob }               from '../lib/blob.js';
import { triggerPipeline, getPipelineRunStatus } from '../lib/adf.js';
import { generatePayload }          from '../lib/payload.js';
import gate from '../thresholds/gate.json';

const adfPipelineDuration = new Trend('adf_pipeline_duration_ms');

export const options = {
  vus:        1,
  iterations: 1,
  thresholds: gate,
};

export default function () {
  const tenantId       = __ENV.TENANT_ID;
  const clientId       = __ENV.CLIENT_ID;
  const clientSecret   = __ENV.CLIENT_SECRET;
  const subscriptionId = __ENV.SUBSCRIPTION_ID;
  const resourceGroup  = __ENV.RESOURCE_GROUP;
  const factoryName    = __ENV.ADF_FACTORY_NAME;
  const pipelineName   = __ENV.ADF_PIPELINE_NAME;
  const storageAccount = __ENV.STORAGE_ACCOUNT_NAME;
  const containerName  = __ENV.BLOB_CONTAINER_NAME;

  // Step 1 — authenticate (two scopes: management for ADF, storage for blob)
  const mgmtToken    = getServicePrincipalToken(tenantId, clientId, clientSecret);
  const storageToken = getServicePrincipalToken(
    tenantId, clientId, clientSecret,
    'https://storage.azure.com/.default',
  );

  if (!mgmtToken || !storageToken) {
    console.error('Authentication failed — aborting iteration');
    return;
  }

  // Step 2 — upload synthetic payload
  const records  = generatePayload(10);
  const blobName = `smoke-${Date.now()}.json`;
  uploadBlob(storageAccount, containerName, blobName, JSON.stringify(records), storageToken);

  // Step 3 — trigger pipeline
  const runId = triggerPipeline(subscriptionId, resourceGroup, factoryName, pipelineName, mgmtToken);

  if (!runId) {
    console.error('Pipeline trigger failed — aborting iteration');
    return;
  }

  // Step 4 — poll until terminal state (max 10 minutes)
  const startTime  = Date.now();
  const timeoutMs  = 10 * 60 * 1000;
  const TERMINAL   = new Set(['Succeeded', 'Failed', 'Cancelled']);
  let   runStatus  = 'InProgress';

  while (Date.now() - startTime < timeoutMs) {
    sleep(10);
    const run = getPipelineRunStatus(subscriptionId, resourceGroup, factoryName, runId, mgmtToken);
    runStatus  = run.status || 'Unknown';
    if (TERMINAL.has(runStatus)) break;
  }

  // Step 5 — record duration and assert
  adfPipelineDuration.add(Date.now() - startTime);

  check(runStatus, {
    'adf pipeline succeeded': (s) => s === 'Succeeded',
  });
}
```

- [ ] **Step 2: Syntax-check via k6 inspect**

```bash
k6 inspect tests/scenarios/smoke.js 2>&1 | head -30
```

Expected: lists `options` export and `default` export, no errors.

- [ ] **Step 3: Commit**

```bash
git add tests/scenarios/smoke.js
git commit -m "feat: add smoke scenario (1 VU × 1 iteration)"
```

---

## Task 8: Implement `tests/scenarios/load.js`

**Files:**
- Create: `tests/scenarios/load.js`

This is identical flow to smoke.js but 5 VUs × 5 min, plus a `handleSummary` that outputs JUnit XML. The JUnit generator is written inline to avoid remote JS imports (works in air-gapped environments).

- [ ] **Step 1: Create the file**

```javascript
// tests/scenarios/load.js
import { Trend }  from 'k6/metrics';
import { sleep, check } from 'k6';
import { getServicePrincipalToken } from '../lib/auth.js';
import { uploadBlob }               from '../lib/blob.js';
import { triggerPipeline, getPipelineRunStatus } from '../lib/adf.js';
import { generatePayload }          from '../lib/payload.js';
import gate from '../thresholds/gate.json';

const adfPipelineDuration = new Trend('adf_pipeline_duration_ms');

export const options = {
  vus:       5,
  duration:  '5m',
  thresholds: gate,
};

export default function () {
  const tenantId       = __ENV.TENANT_ID;
  const clientId       = __ENV.CLIENT_ID;
  const clientSecret   = __ENV.CLIENT_SECRET;
  const subscriptionId = __ENV.SUBSCRIPTION_ID;
  const resourceGroup  = __ENV.RESOURCE_GROUP;
  const factoryName    = __ENV.ADF_FACTORY_NAME;
  const pipelineName   = __ENV.ADF_PIPELINE_NAME;
  const storageAccount = __ENV.STORAGE_ACCOUNT_NAME;
  const containerName  = __ENV.BLOB_CONTAINER_NAME;

  const mgmtToken    = getServicePrincipalToken(tenantId, clientId, clientSecret);
  const storageToken = getServicePrincipalToken(
    tenantId, clientId, clientSecret,
    'https://storage.azure.com/.default',
  );

  if (!mgmtToken || !storageToken) {
    console.error('Authentication failed — aborting iteration');
    return;
  }

  const records  = generatePayload(100);
  const blobName = `load-${Date.now()}-${__VU}.json`;
  uploadBlob(storageAccount, containerName, blobName, JSON.stringify(records), storageToken);

  const runId = triggerPipeline(subscriptionId, resourceGroup, factoryName, pipelineName, mgmtToken);

  if (!runId) {
    console.error('Pipeline trigger failed — aborting iteration');
    return;
  }

  const startTime = Date.now();
  const timeoutMs = 10 * 60 * 1000;
  const TERMINAL  = new Set(['Succeeded', 'Failed', 'Cancelled']);
  let   runStatus = 'InProgress';

  while (Date.now() - startTime < timeoutMs) {
    sleep(10);
    const run = getPipelineRunStatus(subscriptionId, resourceGroup, factoryName, runId, mgmtToken);
    runStatus  = run.status || 'Unknown';
    if (TERMINAL.has(runStatus)) break;
  }

  adfPipelineDuration.add(Date.now() - startTime);

  check(runStatus, {
    'adf pipeline succeeded': (s) => s === 'Succeeded',
  });
}

// ---------------------------------------------------------------------------
// JUnit XML summary — inline so no remote imports are required
// ---------------------------------------------------------------------------
function buildJUnit(data) {
  const checks   = data.metrics['checks'] || {};
  const passed   = checks.values ? (checks.values.passes || 0) : 0;
  const failed   = checks.values ? (checks.values.fails  || 0) : 0;
  const total    = passed + failed;
  const duration = (data.state.testRunDurationMs / 1000).toFixed(3);

  const failureXml = failed > 0
    ? `<failure message="${failed} check(s) failed">See k6 stdout for details</failure>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="k6" tests="${total}" failures="${failed}" time="${duration}">
    <testcase name="k6 checks" classname="k6.load" time="${duration}">
      ${failureXml}
    </testcase>
    <testcase name="threshold: http_req_failed rate&lt;0.01" classname="k6.thresholds" time="0">
      ${(data.metrics['http_req_failed'] && data.metrics['http_req_failed'].thresholds)
          ? Object.entries(data.metrics['http_req_failed'].thresholds)
              .filter(([, v]) => !v.ok)
              .map(([k]) => `<failure message="threshold violated: ${k}"/>`)
              .join('\n      ')
          : ''}
    </testcase>
    <testcase name="threshold: http_req_duration p(95)&lt;2000" classname="k6.thresholds" time="0">
      ${(data.metrics['http_req_duration'] && data.metrics['http_req_duration'].thresholds)
          ? Object.entries(data.metrics['http_req_duration'].thresholds)
              .filter(([, v]) => !v.ok)
              .map(([k]) => `<failure message="threshold violated: ${k}"/>`)
              .join('\n      ')
          : ''}
    </testcase>
    <testcase name="threshold: adf_pipeline_duration_ms p(95)&lt;600000" classname="k6.thresholds" time="0">
      ${(data.metrics['adf_pipeline_duration_ms'] && data.metrics['adf_pipeline_duration_ms'].thresholds)
          ? Object.entries(data.metrics['adf_pipeline_duration_ms'].thresholds)
              .filter(([, v]) => !v.ok)
              .map(([k]) => `<failure message="threshold violated: ${k}"/>`)
              .join('\n      ')
          : ''}
    </testcase>
  </testsuite>
</testsuites>`;
}

export function handleSummary(data) {
  return {
    'results/summary.xml': buildJUnit(data),
  };
}
```

- [ ] **Step 2: Syntax-check**

```bash
k6 inspect tests/scenarios/load.js 2>&1 | head -30
```

Expected: lists `options`, `default`, and `handleSummary` exports, no errors.

- [ ] **Step 3: Commit**

```bash
git add tests/scenarios/load.js
git commit -m "feat: add load scenario (5 VUs × 5 min) with JUnit handleSummary"
```

---

## Task 9: Implement `.pipelines/perf-gate.yml`

**Files:**
- Create: `.pipelines/perf-gate.yml`

- [ ] **Step 1: Create the file**

```yaml
# .pipelines/perf-gate.yml
#
# Required variable group "perf-tests-secrets" must contain:
#   TENANT_ID           — Azure AD tenant ID (AAD > Overview > Tenant ID)
#   CLIENT_ID           — App registration client / application ID
#   CLIENT_SECRET       — App registration client secret value
#   SUBSCRIPTION_ID     — Azure subscription ID
#   RESOURCE_GROUP      — Resource group containing the ADF instance
#   ADF_FACTORY_NAME    — Data Factory name
#   ADF_PIPELINE_NAME   — Pipeline name to trigger
#   STORAGE_ACCOUNT_NAME — Storage account name ("TMH source" container's account)
#   BLOB_CONTAINER_NAME  — Container name (e.g. "tmh-source")

trigger: none   # only runs as a PR branch policy check

pr:
  branches:
    include:
      - main

# NOTE: Switch pool to a self-hosted agent if ADF/storage endpoints are on a
# private network (VNet-injected ADF, private endpoints, etc.).
# Replace the pool block below with:
#   pool:
#     name: <YOUR-SELF-HOSTED-POOL-NAME>   # TODO: set pool name
pool:
  vmImage: ubuntu-latest

variables:
  - group: perf-tests-secrets

steps:
  - script: |
      curl -fsSL https://dl.k6.io/key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg
      echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
        | sudo tee /etc/apt/sources.list.d/k6.list
      sudo apt-get update -qq
      sudo apt-get install -y k6
    displayName: Install k6

  - script: mkdir -p results
    displayName: Create results directory

  - script: |
      k6 run tests/scenarios/load.js
    displayName: Run k6 load test
    env:
      TENANT_ID:            $(TENANT_ID)
      CLIENT_ID:            $(CLIENT_ID)
      CLIENT_SECRET:        $(CLIENT_SECRET)
      SUBSCRIPTION_ID:      $(SUBSCRIPTION_ID)
      RESOURCE_GROUP:       $(RESOURCE_GROUP)
      ADF_FACTORY_NAME:     $(ADF_FACTORY_NAME)
      ADF_PIPELINE_NAME:    $(ADF_PIPELINE_NAME)
      STORAGE_ACCOUNT_NAME: $(STORAGE_ACCOUNT_NAME)
      BLOB_CONTAINER_NAME:  $(BLOB_CONTAINER_NAME)

  - task: PublishTestResults@2
    displayName: Publish JUnit results
    condition: always()
    inputs:
      testResultsFormat:     JUnit
      testResultsFiles:      results/summary.xml
      failTaskOnFailedTests: true
```

- [ ] **Step 2: Validate YAML syntax**

```bash
python3 -c "import yaml, sys; yaml.safe_load(open('.pipelines/perf-gate.yml'))" && echo "YAML OK"
```

Expected: `YAML OK`

- [ ] **Step 3: Commit**

```bash
git add .pipelines/perf-gate.yml
git commit -m "ci: add PR-gate performance pipeline"
```

---

## Task 10: Implement `.pipelines/perf-nightly.yml`

**Files:**
- Create: `.pipelines/perf-nightly.yml`

- [ ] **Step 1: Create the file**

```yaml
# .pipelines/perf-nightly.yml
#
# Required variable group "perf-tests-secrets" must contain:
#   (same set as perf-gate.yml — see that file for the full list)
#
# This pipeline runs the smoke scenario nightly for visibility.
# Switch to tests/scenarios/load.js if you want a full nightly soak test.

trigger: none

schedules:
  - cron: "0 2 * * *"
    displayName: Nightly 02:00 UTC
    branches:
      include:
        - main
    always: true   # run even if no new commits

# NOTE: Switch to a self-hosted pool if ADF/storage are behind private endpoints.
#   pool:
#     name: <YOUR-SELF-HOSTED-POOL-NAME>   # TODO: set pool name
pool:
  vmImage: ubuntu-latest

variables:
  - group: perf-tests-secrets

steps:
  - script: |
      curl -fsSL https://dl.k6.io/key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg
      echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
        | sudo tee /etc/apt/sources.list.d/k6.list
      sudo apt-get update -qq
      sudo apt-get install -y k6
    displayName: Install k6

  - script: mkdir -p results
    displayName: Create results directory

  - script: |
      k6 run tests/scenarios/smoke.js
    displayName: Run k6 smoke test (nightly)
    env:
      TENANT_ID:            $(TENANT_ID)
      CLIENT_ID:            $(CLIENT_ID)
      CLIENT_SECRET:        $(CLIENT_SECRET)
      SUBSCRIPTION_ID:      $(SUBSCRIPTION_ID)
      RESOURCE_GROUP:       $(RESOURCE_GROUP)
      ADF_FACTORY_NAME:     $(ADF_FACTORY_NAME)
      ADF_PIPELINE_NAME:    $(ADF_PIPELINE_NAME)
      STORAGE_ACCOUNT_NAME: $(STORAGE_ACCOUNT_NAME)
      BLOB_CONTAINER_NAME:  $(BLOB_CONTAINER_NAME)

  - task: PublishTestResults@2
    displayName: Publish JUnit results
    condition: always()
    inputs:
      testResultsFormat:     JUnit
      testResultsFiles:      results/summary.xml
      failTaskOnFailedTests: false   # visibility only — does not block nightly
```

- [ ] **Step 2: Validate YAML syntax**

```bash
python3 -c "import yaml, sys; yaml.safe_load(open('.pipelines/perf-nightly.yml'))" && echo "YAML OK"
```

Expected: `YAML OK`

- [ ] **Step 3: Commit**

```bash
git add .pipelines/perf-nightly.yml
git commit -m "ci: add nightly smoke pipeline"
```

---

## Task 11: Write `README.md`

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create the file**

```markdown
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

JUnit XML is written to `results/summary.xml` at the end of each run.

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

1. In Azure DevOps go to **Pipelines → New pipeline → Azure Repos Git** (or
   GitHub).
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
```

- [ ] **Step 2: Verify the file exists and is non-empty**

```bash
wc -l README.md
```

Expected: > 100 lines.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README with local-run guide and ADO setup instructions"
```

---

## Task 12: Final wiring check

- [ ] **Step 1: Verify the full file tree**

```bash
find . -not -path './.git/*' -not -name '.gitkeep' | sort
```

Expected output (order may vary):
```
./.pipelines/perf-gate.yml
./.pipelines/perf-nightly.yml
./README.md
./results
./tests/lib/adf.js
./tests/lib/auth.js
./tests/lib/blob.js
./tests/lib/payload.js
./tests/scenarios/load.js
./tests/scenarios/smoke.js
./tests/thresholds/gate.json
```

- [ ] **Step 2: k6 inspect both scenarios to catch import resolution errors**

```bash
k6 inspect tests/scenarios/smoke.js 2>&1
k6 inspect tests/scenarios/load.js  2>&1
```

Expected: both exit cleanly, each listing `default` and (for load.js) `handleSummary` exports. No `Error` lines.

- [ ] **Step 3: Confirm YAML files are valid**

```bash
python3 -c "
import yaml
for f in ['.pipelines/perf-gate.yml', '.pipelines/perf-nightly.yml']:
    yaml.safe_load(open(f))
    print(f, 'OK')
"
```

Expected:
```
.pipelines/perf-gate.yml OK
.pipelines/perf-nightly.yml OK
```

- [ ] **Step 4: Tag the initial release**

```bash
git tag v0.1.0
```

---

## Self-Review Checklist

- [x] `getServicePrincipalToken` accepts optional `scope` parameter so `load.js` can request both management and storage tokens
- [x] `uploadBlob` sets `x-ms-blob-type: BlockBlob` and `Content-Type: application/json`
- [x] `triggerPipeline` uses `api-version=2018-06-01`
- [x] `getPipelineRunStatus` uses `api-version=2018-06-01`
- [x] Polling loop uses `while` + `sleep(10)`, not `setTimeout`
- [x] All HTTP calls have `check()` assertions
- [x] `__ENV` used throughout for environment variable access
- [x] `gate.json` keys match k6 threshold metric names exactly
- [x] `handleSummary` outputs to `results/summary.xml` (inline, no remote imports)
- [x] Both pipeline YAMLs link `perf-tests-secrets` variable group
- [x] `perf-gate.yml` has `failTaskOnFailedTests: true`, `perf-nightly.yml` has `false`
- [x] Self-hosted pool comment present in both pipeline files
- [x] Secret list comment block at top of both pipeline files
- [x] `adf_pipeline_duration_ms` Trend metric name matches `gate.json` key exactly
- [x] `blobName` includes `__VU` in `load.js` to avoid concurrent-write collisions
