/**
 * Lambda authorizer on the webhook route. It passes only requests shaped
 * like a GitHub webhook delivery and rejects the rest before they reach
 * the receiver.
 *
 * It is not the authentication. An HTTP API authorizer does not see the
 * request body, so it cannot check the HMAC. The receiver verifies
 * X-Hub-Signature-256 over the raw body (src/delivery.ts) and stays the
 * only check that proves a delivery came from GitHub.
 */

export interface AuthorizerEvent {
  readonly headers?: Readonly<Record<string, string | undefined>>;
}

const SIGNATURE = /^sha256=[0-9a-f]{64}$/;
const EVENT_NAME = /^[a-z_]{1,64}$/;
const DELIVERY_ID = /^[0-9a-f-]{1,64}$/i;

/** True when the headers carry what GitHub sends with every delivery. */
export function isGitHubDeliveryShape(headers: Readonly<Record<string, string | undefined>> = {}): boolean {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v ?? '']));
  return SIGNATURE.test(h['x-hub-signature-256'] ?? '')
    && EVENT_NAME.test(h['x-github-event'] ?? '')
    && DELIVERY_ID.test(h['x-github-delivery'] ?? '')
    && (h['user-agent'] ?? '').startsWith('GitHub-Hookshot/');
}

export async function handler(event: AuthorizerEvent): Promise<{ isAuthorized: boolean }> {
  return { isAuthorized: isGitHubDeliveryShape(event.headers) };
}
