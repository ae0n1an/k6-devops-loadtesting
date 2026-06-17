import http from 'k6/http';
import { check } from 'k6';

/**
 * Exchange service-principal credentials for a bearer token.
 *
 * @param {string} tenantId
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} [scope='https://management.azure.com/.default']
 * @returns {string|null} access_token
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

  try {
    return JSON.parse(res.body).access_token;
  } catch (e) {
    console.error(`auth: failed to parse token response: ${e.message}`);
    return null;
  }
}
