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
 * @returns {string|null} runId
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

  try {
    return JSON.parse(res.body).runId;
  } catch (e) {
    console.error(`adf: failed to parse triggerPipeline response: ${e.message}`);
    return null;
  }
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

  try {
    return JSON.parse(res.body);
  } catch (e) {
    console.error(`adf: failed to parse getPipelineRunStatus response: ${e.message}`);
    return { status: 'Unknown' };
  }
}
