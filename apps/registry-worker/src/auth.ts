import { Env, GitHubUser } from './types';

export async function verifyGitHubToken(request: Request): Promise<GitHubUser | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'costume-registry/1.0',
    },
  });

  if (!response.ok) return null;
  return response.json() as Promise<GitHubUser>;
}

export async function getInstallationToken(env: Env): Promise<string> {
  const jwt = await makeGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);

  const response = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'costume-registry/1.0',
      },
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { token: string };
  return data.token;
}

async function makeGitHubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iss: appId, iat: now - 60, exp: now + 600 }),
  );
  const signingInput = `${header}.${payload}`;

  const key = await importPrivateKey(privateKeyPem);
  const signatureBuffer = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64url(signatureBuffer)}`;
}

function base64url(data: string | ArrayBuffer): string {
  let binary = '';
  const bytes =
    typeof data === 'string'
      ? new TextEncoder().encode(data)
      : new Uint8Array(data);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // GitHub App private keys are PKCS#1 ("BEGIN RSA PRIVATE KEY").
  // Web Crypto requires PKCS#8 ("BEGIN PRIVATE KEY"), so we wrap if needed.
  const isPkcs1 = pem.includes('BEGIN RSA PRIVATE KEY');
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const pkcs8Der = isPkcs1 ? wrapPkcs1InPkcs8(der) : der;

  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8Der.buffer as ArrayBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/**
 * Wraps a PKCS#1 RSA private key DER into a PKCS#8 DER structure so that
 * the Web Crypto API can import it.
 *
 * PKCS#8 = SEQUENCE { INTEGER 0, AlgorithmIdentifier, OCTET STRING { PKCS#1 } }
 */
function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
  // AlgorithmIdentifier for rsaEncryption (OID 1.2.840.113549.1.1.1 + NULL)
  const algId = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ]);
  const ver = new Uint8Array([0x02, 0x01, 0x00]); // INTEGER 0

  const octetHdr = new Uint8Array([0x04, ...derLen(pkcs1.length)]);
  const innerLen = ver.length + algId.length + octetHdr.length + pkcs1.length;
  const outerHdr = new Uint8Array([0x30, ...derLen(innerLen)]);

  const out = new Uint8Array(outerHdr.length + innerLen);
  let off = 0;
  for (const part of [outerHdr, ver, algId, octetHdr, pkcs1]) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  if (n < 0x100) return [0x81, n];
  return [0x82, (n >> 8) & 0xff, n & 0xff];
}
