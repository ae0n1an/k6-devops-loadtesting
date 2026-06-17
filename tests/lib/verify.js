// tests/lib/verify.js
import http from 'k6/http';
import { check } from 'k6';

// TODO: Replace with your actual output blob naming convention.
// The pipeline writes timestamp-based filenames — examples to guide you:
//   /^TMH_\d{8}_\d{6}\.csv\.esfx$/   matches  TMH_20240617_143022.csv.esfx
//   /^output_\d{14}\.csv$/            matches  output_20240617143022.csv
//   /^[^/]+\.(csv|esfx)$/             matches  any .csv or .esfx file
const OUTPUT_BLOB_NAME_PATTERN = /^.+_\d{8}.*\.(csv|esfx)$/i;

/**
 * Verify the pipeline wrote an output blob to the destination container.
 *
 * Checks performed:
 *  - Output container is listable (200)
 *  - At least one blob exists with Last-Modified >= afterTimestamp
 *  - That blob's name matches OUTPUT_BLOB_NAME_PATTERN
 *  - That blob's Content-Length > 0
 *
 * @param {string} accountName    - Output storage account name
 * @param {string} containerName  - Output container name
 * @param {number} afterTimestamp - Unix ms — only consider blobs modified after this time
 * @param {string} token          - Bearer token (storage.azure.com scope)
 * @returns {{ found: boolean, blobName: string|null, size: number }}
 */
export function checkOutputBlob(accountName, containerName, afterTimestamp, token) {
  const url = `https://${accountName}.blob.core.windows.net/${containerName}` +
              `?restype=container&comp=list&maxresults=200`;

  const res = http.get(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-ms-version':  '2020-10-02',
    },
  });

  check(res, {
    'verify: output container listed (200)': (r) => r.status === 200,
  });

  if (res.status !== 200) {
    console.error(`checkOutputBlob: failed to list container ${containerName} (${res.status}): ${res.body}`);
    return { found: false, blobName: null, size: 0 };
  }

  // Parse Azure Blob Storage list XML response with a simple exec loop.
  // Each <Blob> block contains <Name>, <Last-Modified>, and <Content-Length>.
  const body     = res.body;
  const blobRe   = /<Blob>([\s\S]*?)<\/Blob>/g;
  let   match;
  let   matchedBlob = null;
  let   matchedSize = 0;

  while ((match = blobRe.exec(body)) !== null) {
    const blobXml  = match[1];
    const namePart = blobXml.match(/<Name>([^<]+)<\/Name>/);
    const sizePart = blobXml.match(/<Content-Length>(\d+)<\/Content-Length>/);
    const modPart  = blobXml.match(/<Last-Modified>([^<]+)<\/Last-Modified>/);

    if (!namePart) continue;

    const name         = namePart[1];
    const size         = sizePart  ? parseInt(sizePart[1],  10) : 0;
    const lastModified = modPart   ? new Date(modPart[1]).getTime() : 0;

    if (lastModified < afterTimestamp)          continue;
    if (!OUTPUT_BLOB_NAME_PATTERN.test(name))  continue;

    matchedBlob = name;
    matchedSize = size;
    break;
  }

  check(matchedBlob, {
    'verify: output blob exists':               (b) => b !== null,
    'verify: output blob name matches pattern': (b) => b !== null && OUTPUT_BLOB_NAME_PATTERN.test(b),
  });

  check(matchedSize, {
    'verify: output blob size > 0': (s) => s > 0,
  });

  if (matchedBlob) {
    console.log(`verify: output blob found — ${matchedBlob} (${matchedSize} bytes)`);
  } else {
    console.error(`verify: no matching output blob in ${containerName} after ${new Date(afterTimestamp).toISOString()}`);
  }

  return { found: matchedBlob !== null, blobName: matchedBlob, size: matchedSize };
}

/**
 * Query ADF activity runs and return aggregated record counts from Copy Activities.
 *
 * ADF Copy Activity output exposes rowsRead (source) and rowsWritten/rowsCopied (sink).
 * Checks performed:
 *  - Activity runs endpoint returns 200
 *  - Total rows read > 0  (pipeline actually consumed your source blob)
 *  - Total rows written > 0 (pipeline actually wrote output)
 *  - Rows written <= rows read (filter behaviour: output cannot exceed input)
 *
 * @param {string} subscriptionId
 * @param {string} resourceGroup
 * @param {string} factoryName
 * @param {string} runId
 * @param {string} token - Bearer token (management.azure.com scope)
 * @returns {{ rowsRead: number, rowsWritten: number, activityCount: number }}
 */
export function getActivityRunCounts(subscriptionId, resourceGroup, factoryName, runId, token) {
  const url = [
    'https://management.azure.com',
    'subscriptions', subscriptionId,
    'resourceGroups', resourceGroup,
    'providers/Microsoft.DataFactory/factories', factoryName,
    `pipelineruns/${runId}/queryActivityruns?api-version=2018-06-01`,
  ].join('/');

  const res = http.post(url, '{}', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
  });

  check(res, {
    'verify: activity runs retrieved (200)': (r) => r.status === 200,
  });

  if (res.status !== 200) {
    console.error(`getActivityRunCounts failed (${res.status}): ${res.body}`);
    return { rowsRead: 0, rowsWritten: 0, activityCount: 0 };
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    console.error(`getActivityRunCounts: failed to parse response: ${e.message}`);
    return { rowsRead: 0, rowsWritten: 0, activityCount: 0 };
  }

  const activities    = data.value || [];
  let   totalRead     = 0;
  let   totalWritten  = 0;

  for (const activity of activities) {
    const output = activity.output || {};
    // ADF Copy Activity uses rowsRead + rowsCopied; some versions use dataRead + dataWritten
    totalRead    += output.rowsRead    || 0;
    totalWritten += output.rowsCopied  || output.rowsWritten || 0;
  }

  check(totalRead, {
    'verify: rows read > 0': (n) => n > 0,
  });

  check(totalWritten, {
    'verify: rows written > 0': (n) => n > 0,
  });

  check(null, {
    'verify: rows written <= rows read': () => totalWritten <= totalRead,
  });

  console.log(`verify: ${activities.length} activities — rows read: ${totalRead}, rows written: ${totalWritten}`);

  return { rowsRead: totalRead, rowsWritten: totalWritten, activityCount: activities.length };
}
