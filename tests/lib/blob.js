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
