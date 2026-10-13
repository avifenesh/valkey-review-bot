import * as crypto from 'node:crypto';

export interface ApiGatewayEvent {
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
}

/**
 * The request body exactly as GitHub sent it. GitHub signs the raw bytes,
 * so the signature is checked against these bytes and not a decoded
 * string, which would replace invalid UTF-8 sequences.
 */
export function rawBody(event: ApiGatewayEvent): Buffer {
  if (!event.body) return Buffer.alloc(0);
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body, 'utf8');
}

/** Header names lowercased; API Gateway passes them through in any case. */
export function lowercaseHeaders(event: ApiGatewayEvent): Record<string, string> {
  return Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v ?? '']),
  );
}

/** Checks an X-Hub-Signature-256 header ("sha256=<hex HMAC of the body>"). */
export function verifySignature(body: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=') || !secret) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`);
  const actual = Buffer.from(signatureHeader);
  // timingSafeEqual throws on different lengths. The length of a valid
  // signature is public, so checking it first leaks nothing.
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}
