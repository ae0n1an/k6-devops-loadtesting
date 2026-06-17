// tests/scenarios/smoke.js
import { Trend }  from 'k6/metrics';
import { sleep, check } from 'k6';
import { getServicePrincipalToken } from '../lib/auth.js';
import { uploadBlob }               from '../lib/blob.js';
import { triggerPipeline, getPipelineRunStatus } from '../lib/adf.js';
import { generatePayload }          from '../lib/payload.js';
import { checkOutputBlob, getActivityRunCounts } from '../lib/verify.js';

const gate = JSON.parse(open('../thresholds/gate.json'));

const adfPipelineDuration = new Trend('adf_pipeline_duration_ms');

export const options = {
  vus:        1,
  iterations: 1,
  thresholds: gate,
};

const TERMINAL = new Set(['Succeeded', 'Failed', 'Cancelled']);

export default function () {
  const tenantId            = __ENV.TENANT_ID;
  const clientId            = __ENV.CLIENT_ID;
  const clientSecret        = __ENV.CLIENT_SECRET;
  const subscriptionId      = __ENV.SUBSCRIPTION_ID;
  const resourceGroup       = __ENV.RESOURCE_GROUP;
  const factoryName         = __ENV.ADF_FACTORY_NAME;
  const pipelineName        = __ENV.ADF_PIPELINE_NAME;
  const storageAccount      = __ENV.STORAGE_ACCOUNT_NAME;
  const containerName       = __ENV.BLOB_CONTAINER_NAME;
  const outputStorageAccount = __ENV.OUTPUT_STORAGE_ACCOUNT_NAME;
  const outputContainerName  = __ENV.OUTPUT_BLOB_CONTAINER_NAME;

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
  const blobRes = uploadBlob(storageAccount, containerName, blobName, JSON.stringify(records), storageToken);
  if (!blobRes || blobRes.status !== 201) {
    console.error('Blob upload failed — aborting iteration');
    return;
  }

  // Step 3 — trigger pipeline (record time so output blob search has a lower bound)
  const triggerTime = Date.now();
  const runId = triggerPipeline(subscriptionId, resourceGroup, factoryName, pipelineName, mgmtToken);

  if (!runId) {
    console.error('Pipeline trigger failed — aborting iteration');
    return;
  }

  // Step 4 — poll until terminal state (max 10 minutes)
  const startTime  = Date.now();
  const timeoutMs  = 10 * 60 * 1000;
  let   runStatus  = 'InProgress';

  while (Date.now() - startTime < timeoutMs) {
    sleep(10);
    const run = getPipelineRunStatus(subscriptionId, resourceGroup, factoryName, runId, mgmtToken);
    runStatus  = run.status || 'Unknown';
    if (TERMINAL.has(runStatus)) break;
  }

  // Step 5 — record duration and assert
  if (!TERMINAL.has(runStatus)) {
    console.error(`Pipeline ${runId} did not reach terminal state within ${timeoutMs}ms (last status: ${runStatus})`);
  }
  adfPipelineDuration.add(Date.now() - startTime);

  check(runStatus, {
    'adf pipeline succeeded': (s) => s === 'Succeeded',
  });

  // Step 6 — validate output only when pipeline succeeded
  if (runStatus === 'Succeeded') {
    checkOutputBlob(outputStorageAccount, outputContainerName, triggerTime, storageToken);
    getActivityRunCounts(subscriptionId, resourceGroup, factoryName, runId, mgmtToken);
  }
}

// ---------------------------------------------------------------------------
// JUnit XML summary — inline so no remote imports are required
// ---------------------------------------------------------------------------
function buildJUnit(data) {
  const checks  = data.metrics['checks'] || {};
  const passed  = checks.values ? (checks.values.passes || 0) : 0;
  const failed  = checks.values ? (checks.values.fails  || 0) : 0;
  const total   = passed + failed;
  const duration = (data.state.testRunDurationMs / 1000).toFixed(3);

  const failureXml = failed > 0
    ? `<failure message="${failed} check(s) failed">See k6 stdout for details</failure>`
    : '';

  function thresholdCases(metricName) {
    const m = data.metrics[metricName];
    if (!m || !m.thresholds) return '';
    return Object.entries(m.thresholds)
      .filter(([, v]) => !v.ok)
      .map(([k]) => `<failure message="threshold violated: ${k}"/>`)
      .join('\n      ');
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="k6" tests="${total}" failures="${failed}" time="${duration}">
    <testcase name="k6 checks" classname="k6.smoke" time="${duration}">
      ${failureXml}
    </testcase>
    <testcase name="threshold: http_req_failed rate&lt;0.01" classname="k6.thresholds" time="0">
      ${thresholdCases('http_req_failed')}
    </testcase>
    <testcase name="threshold: http_req_duration p(95)&lt;2000" classname="k6.thresholds" time="0">
      ${thresholdCases('http_req_duration')}
    </testcase>
    <testcase name="threshold: adf_pipeline_duration_ms p(95)&lt;600000" classname="k6.thresholds" time="0">
      ${thresholdCases('adf_pipeline_duration_ms')}
    </testcase>
  </testsuite>
</testsuites>`;
}

export function handleSummary(data) {
  return {
    'results/summary.xml': buildJUnit(data),
  };
}
