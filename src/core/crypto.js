import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Envelope for secrets stored in the DB.
 *   enc:v1:<keyId>:<iv b64>:<tag b64>:<ciphertext b64>
 * AES-256-GCM, random IV per value. `aad` binds the ciphertext to its setting
 * (namespace.key) so encrypted values can't be swapped between rows.
 * Keys come from APP_MASTER_KEY (current) and APP_MASTER_KEY_OLD (rotation).
 */
const PREFIX = 'enc:v1:';

function deriveKey(secret) {
  return Buffer.from(hkdfSync('sha256', secret, 'cms-secrets-salt', 'cms-aes-256-gcm', 32));
}
const keyIdOf = (secret) => createHash('sha256').update(secret).digest('hex').slice(0, 8);

/** @param {{APP_MASTER_KEY:string, APP_MASTER_KEY_OLD?:string}} env */
export function createCrypto(env) {
  const secrets = [
    env.APP_MASTER_KEY,
    ...(env.APP_MASTER_KEY_OLD || '').split(',').map((s) => s.trim()),
  ].filter(Boolean);
  const keys = new Map(secrets.map((s) => [keyIdOf(s), deriveKey(s)]));
  const currentId = keyIdOf(secrets[0]);

  return {
    currentKeyId: currentId,
    isEncrypted: (v) => typeof v === 'string' && v.startsWith(PREFIX),
    /** @param {string} plaintext @param {string} aad */
    encrypt(plaintext, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', keys.get(currentId), iv);
      cipher.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return `${PREFIX}${currentId}:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
    },
    /** @param {string} envelope @param {string} aad */
    decrypt(envelope, aad) {
      const [keyId, iv, tag, ct] = envelope.slice(PREFIX.length).split(':');
      const key = keys.get(keyId);
      if (!key)
        throw new Error(
          `No master key available for key id ${keyId} (rotation: add it to APP_MASTER_KEY_OLD)`,
        );
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
    },
    /** True when the envelope was written with a non-current key (candidate for re-encryption). */
    needsRotation: (envelope) => envelope.slice(PREFIX.length).split(':')[0] !== currentId,
  };
}

/** @typedef {ReturnType<typeof createCrypto>} Crypto */
