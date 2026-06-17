# Performance Test Plan — ADF Pipeline

## 1. Purpose

This document describes the performance testing strategy for the Azure Data Factory (ADF) pipeline. The goal is to establish a measurable, automated quality gate that answers one question before any code change reaches production:

> **Does the pipeline still complete successfully within acceptable time under concurrent load?**

This is not a stress test or capacity-planning exercise. It is a regression gate — a baseline that must hold on every PR and that is monitored nightly for drift.

---

## 2. Scope

### In scope

- End-to-end pipeline execution time from trigger to terminal state
- HTTP reliability of the three Azure API surfaces: Azure AD token endpoint, Blob Storage REST API, ADF REST API
- Concurrent execution behaviour under 5 simultaneous virtual users
- Single end-to-end sanity verification (smoke)

### Out of scope

- Internal ADF activity performance (individual activity durations are not observable via the REST API at this level)
- Data quality or correctness of pipeline output
- Network throughput or storage I/O benchmarking
- Stress testing / finding the breaking point
- Cost analysis

---

## 3. Testing Approach

### Why end-to-end rather than unit/component testing

ADF pipelines are orchestration logic. The interesting failure modes are not in any single API call but in the interaction between them: a blob that uploads successfully but lands in the wrong path; a pipeline trigger that returns a runId but silently queues behind a resource lock; a pipeline that completes in 2 minutes normally but degrades to 8 minutes under concurrent load because of shared Spark cluster cold-start. Unit testing individual HTTP calls cannot surface these.

The test therefore exercises the full chain on each iteration:

```
Azure AD → Blob Storage → ADF trigger → ADF poll loop → terminal state
```

If any step in that chain degrades, the final duration metric captures it.

### Why plain JavaScript with no dependencies

The test runner executes plain JavaScript with no runtime dependencies — no JVM, no npm, no container image requirements beyond the binary itself. This makes it trivial to install on any agent and eliminates dependency management as a maintenance surface. It also exposes HTTP-level metrics (latency, failure rate) as first-class citizens without any instrumentation code.

### Why synthetic data

The pipeline consumes source data from Blob Storage. Using synthetic data means:

1. The test is self-contained — no dependency on a data generator, a source system, or a production export
2. Each test run starts from a clean, known state
3. Volume is controllable (10 records for smoke, 100 for load) without touching production data

The synthetic records include `id`, `timestamp`, `amount`, `status`, and `source` fields that mimic the shape of real transaction data. The ADF pipeline treats them identically to real data from the perspective of triggering and completing.

---

## 4. Test Architecture

```
tests/
  lib/
    auth.js      ← Azure AD OAuth2 client-credentials token exchange
    blob.js      ← Azure Blob Storage REST PUT (BlockBlob)
    adf.js       ← ADF REST API: createRun + pipelineruns/{runId}
    payload.js   ← Synthetic record generator (no network)
  scenarios/
    smoke.js     ← 1 VU, 1 iteration
    load.js      ← 5 VUs, 5 minutes
  thresholds/
    gate.json    ← shared pass/fail thresholds
```

Each library module has a single responsibility. Scenarios import from all four and compose the full test flow. Thresholds are externalised so they can be tightened over time without touching test logic.

### Per-iteration flow

Each virtual user executes this sequence once per iteration:

1. **Authenticate** — two separate token requests:
   - `management.azure.com` scope → used for ADF API calls
   - `storage.azure.com` scope → used for Blob Storage calls
   - Two scopes are required because Azure RBAC operates per-resource-provider; a single token cannot authorise both
2. **Generate payload** — create N synthetic records in memory (no I/O)
3. **Upload blob** — PUT JSON to `https://{account}.blob.core.windows.net/{container}/{name}` with `x-ms-blob-type: BlockBlob`
4. **Trigger pipeline** — POST to ADF `createRun` endpoint; capture `runId`
5. **Poll for completion** — GET `pipelineruns/{runId}` every 10 seconds until status is `Succeeded`, `Failed`, or `Cancelled`, or 10 minutes elapses
6. **Record and assert** — add elapsed duration to `adf_pipeline_duration_ms` Trend; assert status is `Succeeded`

If any step produces an error (auth failure, blob 4xx/5xx, trigger failure), the iteration aborts early. This prevents meaningless downstream assertions and keeps failure signals clean.

---

## 5. Test Scenarios

### Smoke (`tests/scenarios/smoke.js`)

| Parameter | Value |
|---|---|
| Virtual users | 1 |
| Iterations | 1 |
| Payload size | 10 records |
| Blob name pattern | `smoke-{timestamp}.json` |
| Trigger | Nightly pipeline (02:00 UTC) |
| Failure mode | Visibility only — does not block |

**Purpose:** Verify the full end-to-end flow works once, from a single user, with minimal data. This is the canary — it catches configuration drift (rotated secrets, changed pipeline names, revoked RBAC) before anyone notices in production. It runs nightly rather than on PRs because a single iteration does not produce statistically meaningful latency data.

### Load (`tests/scenarios/load.js`)

| Parameter | Value |
|---|---|
| Virtual users | 5 |
| Duration | 5 minutes |
| Payload size | 100 records |
| Blob name pattern | `load-{timestamp}-{VU}.json` |
| Trigger | PR branch policy gate on `main` |
| Failure mode | Blocks merge |

**Purpose:** Exercise the pipeline under concurrent load to detect resource contention, queuing delays, and throughput degradation that would not appear in a single-user run. Five concurrent VUs was chosen as a realistic approximation of parallel CI pipelines or concurrent ETL jobs during a busy release period — not an extreme stress scenario, but enough to surface shared-resource bottlenecks (connection limits, Spark cluster saturation, storage throttling).

The VU number in the blob name (`load-{timestamp}-{VU}.json`) prevents write collisions when multiple VUs attempt to upload simultaneously within the same millisecond.

---

## 6. Metrics and Thresholds

Thresholds are defined in `tests/thresholds/gate.json` and shared by both scenarios.

### `http_req_failed` — rate < 1%

**What it measures:** The fraction of all HTTP requests (across auth, blob upload, ADF trigger, and status polls) that returned a non-2xx response or experienced a network error.

**Why 1%:** Zero tolerance is too brittle — transient Azure AD throttles or brief management-plane hiccups are common in shared environments. 1% allows for occasional noise without masking real problems. If the pipeline is genuinely broken, this metric will spike well above 1% (all auth calls fail → no downstream calls → 100% failure rate).

**What trips it:** Expired service principal, revoked RBAC, ADF/storage region outage, network connectivity to Azure.

---

### `http_req_duration` — p(95) < 2000 ms

**What it measures:** The 95th percentile response time across all HTTP requests in the test run. This includes the fast calls (auth token exchange, status polls — typically 100–500 ms) and the slower ones (blob upload — typically 200–800 ms for a 10–100 record JSON file).

**Why p(95):** The mean would mask outliers; the max is too sensitive to single slow requests. p(95) represents the experience of 19 out of every 20 requests and is the standard SLO metric for API response times.

**Why 2000 ms:** The individual API calls in this suite (Azure AD, Blob Storage, ADF REST) are all straightforward management-plane operations. Sub-2-second response is well within normal operating bounds. A degradation beyond 2 seconds at p(95) suggests something systemic — management-plane throttling, network routing issues, or overloaded authentication infrastructure.

**Note:** This threshold aggregates all HTTP calls in the run. If ADF status polls are consistently slow (management plane under load) this will trip even if auth and blob calls are fast. That is intentional — it surfaces Azure infrastructure degradation that affects the whole test.

---

### `adf_pipeline_duration_ms` — p(95) < 600,000 ms (10 minutes)

**What it measures:** The wall-clock time from pipeline trigger to terminal state (`Succeeded`, `Failed`, or `Cancelled`), measured per iteration. This is the primary business metric — how long does the pipeline take to run?

**Why p(95):** Same reasoning as above. Individual runs may vary due to cluster cold-start; p(95) over 5 minutes of concurrent runs gives a stable aggregate.

**Why 600,000 ms (10 minutes):** This is the current timeout ceiling, not a performance target. It says "the pipeline must complete within 10 minutes." This threshold should be tightened once baseline measurements are collected. A reasonable target for a healthy pipeline might be p(95) < 180,000 ms (3 minutes) or p(95) < 300,000 ms (5 minutes) depending on observed behaviour. The 10-minute value is deliberately conservative for the initial rollout.

**Recommended action:** Run the load scenario in a non-blocking mode for two weeks to collect baseline data, then tighten this threshold to observed p(95) + 20% headroom.

---

## 7. Pass / Fail Criteria

A test run **passes** when all three thresholds hold AND every `check()` assertion passes:

| Check | Pass condition |
|---|---|
| `auth: token endpoint returned 200` | Azure AD returns a valid token |
| `blob: upload returned 201` | Blob Storage accepted the file |
| `adf: pipeline triggered (200)` | ADF accepted the trigger and returned a runId |
| `adf: run status retrieved (200)` | Status polls return valid responses |
| `adf pipeline succeeded` | Pipeline reached `Succeeded` state |

A single failed check does not immediately trip the threshold — the test runner aggregates checks across all VUs and iterations. However, a run where the ADF pipeline consistently fails (`Succeeded` check fails) will produce 100% failure on `http_req_failed` for the downstream polls, which will trip the rate threshold.

---

## 8. Pipeline Integration

### PR gate (`perf-gate.yml`)

Wired to `main` via Azure DevOps branch policy. Every PR to `main` must pass the load scenario before merge is permitted. This ensures no change that degrades pipeline performance (or breaks the end-to-end flow) can reach production.

`failTaskOnFailedTests: true` on the `PublishTestResults` step means ADO marks the pipeline task as failed if the JUnit XML contains failures, which in turn blocks the PR policy.

`condition: always()` on `PublishTestResults` ensures the JUnit XML is published even when the test runner exits non-zero — giving the reviewer a detailed failure report regardless of outcome.

### Nightly (`perf-nightly.yml`)

Runs at 02:00 UTC daily on `main`, even with no new commits (`always: true`). This catches:

- Credential / secret expiry (client secrets rotate on fixed schedules)
- RBAC drift (permissions removed without touching the code)
- ADF infrastructure degradation that is not triggered by a code change
- Quota or throttling issues that accumulate over time

`failTaskOnFailedTests: false` means failures are visible in the ADO pipeline history but do not create noise in unrelated work.

---

## 9. Infrastructure Requirements

| Requirement | Detail |
|---|---|
| Test runner binary | Pre-installed on agent, or uncomment the install step in the YAML |
| Agent network access | Must reach `login.microsoftonline.com`, `management.azure.com`, `{account}.blob.core.windows.net` — use a self-hosted agent if these are behind a private endpoint |
| Service principal | Must exist in the Azure AD tenant; needs `Data Factory Contributor` on the ADF instance and `Storage Blob Data Contributor` on the container |
| Variable group | `perf-tests-secrets` in ADO Library with all 9 secrets linked to both pipelines |
| `results/` directory | Created at runtime by `mkdir -p results` before the test runs |

---

## 10. Risks and Limitations

**Shared ADF instance:** All VUs trigger the same pipeline concurrently. If the ADF instance has a concurrency limit set, some trigger calls will be queued or rejected, artificially inflating duration. This is observable (check failures on `adf: pipeline triggered`) but should be factored into threshold calibration.

**Token lifetime:** Tokens are fetched fresh at the start of each VU iteration. The load scenario runs for 5 minutes, well within the 60-minute token lifetime. If `duration` is extended beyond 60 minutes, tokens will expire mid-run and the test will fail with 401s. A token-refresh strategy would be needed for longer soak tests.

**Clock skew in duration metric:** `adf_pipeline_duration_ms` measures wall clock time on the test agent, not ADF-reported execution time. Network latency to the management plane (typically < 200 ms) is included. This is acceptable for a regression gate but should be noted if comparing against ADF Studio's reported durations.

**No teardown / cleanup:** Blobs written to the container during the test are not deleted. Over time this accumulates test artefacts. A lifecycle management policy on the container (e.g., delete blobs older than 7 days with the `smoke-` or `load-` prefix) is recommended.

**Synthetic data vs real data:** The pipeline is tested with synthetic records that have the correct schema but random values. If the pipeline has conditional logic (e.g., different paths for `status: failed` records), the synthetic data may not exercise all branches proportionally.

---

## 11. Future Considerations

- **Tighten `adf_pipeline_duration_ms` threshold** after collecting two weeks of baseline data
- **Parameterise VU count and duration** via environment variables so the same script can serve both a quick PR check and a longer soak test without code changes
- **Add a ramp-up stage** (e.g., 0→5 VUs over 30 seconds) to better simulate realistic load patterns and avoid cold-start spikes skewing the first iteration
- **Separate thresholds by request type** using tags or named groups, so blob upload latency and ADF poll latency are reported independently
- **Pipeline parameter testing** — extend `triggerPipeline` to accept optional parameters for testing different pipeline execution paths
- **Alert on nightly failures** via ADO notification rules or a webhook to a Slack/Teams channel
