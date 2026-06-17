// tests/scenarios/smoke.js
import { Trend }  from 'k6/metrics';
import { sleep, check } from 'k6';
import { getServicePrincipalToken } from '../lib/auth.js';
import { uploadBlob }               from '../lib/blob.js';
import { triggerPipeline, getPipelineRunStatus } from '../lib/adf.js';
import { generatePayload }          from '../lib/payload.js';

const gate = JSON.parse(open('../thresholds/gate.json'));

const adfPipelineDuration = new Trend('adf_pipeline_duration_ms');

export const options = {
  vus:        1,
  iterations: 1,
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

  // Step 3 — trigger pipeline
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
  adfPipelineDuration.add(Date.now() - startTime);

  check(runStatus, {
    'adf pipeline succeeded': (s) => s === 'Succeeded',
  });
}
