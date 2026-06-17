// tests/scenarios/load.js
import { Trend }  from 'k6/metrics';
import { sleep, check } from 'k6';
import { getServicePrincipalToken } from '../lib/auth.js';
import { uploadBlob }               from '../lib/blob.js';
import { triggerPipeline, getPipelineRunStatus } from '../lib/adf.js';
import { generatePayload }          from '../lib/payload.js';

const gate = JSON.parse(open('../thresholds/gate.json'));

const adfPipelineDuration = new Trend('adf_pipeline_duration_ms');

export const options = {
  vus:      5,
  duration: '5m',
  thresholds: gate,
};

const TERMINAL = new Set(['Succeeded', 'Failed', 'Cancelled']);

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
  const blobRes = uploadBlob(storageAccount, containerName, blobName, JSON.stringify(records), storageToken);
  if (!blobRes || blobRes.status !== 201) {
    console.error('Blob upload failed — aborting iteration');
    return;
  }

  const runId = triggerPipeline(subscriptionId, resourceGroup, factoryName, pipelineName, mgmtToken);
  if (!runId) {
    console.error('Pipeline trigger failed — aborting iteration');
    return;
  }

  const startTime  = Date.now();
  const timeoutMs  = 10 * 60 * 1000;
  let   runStatus  = 'InProgress';

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
    <testcase name="k6 checks" classname="k6.load" time="${duration}">
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
