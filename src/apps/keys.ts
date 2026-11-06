import { createHash } from 'node:crypto';

import { calculateJwkThumbprint, exportJWK, generateKeyPair, importPKCS8, type CryptoKey, type JWK } from 'jose';

import { ENTITLEMENT_PRIVATE_KEY, SESSION_SECRET } from '../config.js';

interface SigningKey {
  privateKey: CryptoKey;
  publicJwk: JWK & { kid: string };
}

let signing: Promise<SigningKey> | null = null;

/** The ES256 key behind entitlement tokens. Its public half is published for the apps. */
export const entitlementKey = () =>
  (signing ??= (async () => {
    let privateKey: CryptoKey;
    if (ENTITLEMENT_PRIVATE_KEY) {
      privateKey = await importPKCS8(ENTITLEMENT_PRIVATE_KEY, 'ES256', { extractable: true });
    } else {
      privateKey = (await generateKeyPair('ES256', { extractable: true })).privateKey;
    }
    const { d: _private, ...publicJwk } = await exportJWK(privateKey);
    const kid = await calculateJwkThumbprint(publicJwk);
    return { privateKey, publicJwk: { ...publicJwk, kid, alg: 'ES256', use: 'sig' } };
  })());

/** Access tokens are only ever checked by this server, so a symmetric key derived from the session secret is enough. */
export const accessTokenKey = createHash('sha256').update(`${SESSION_SECRET}:app-access-token`).digest();
