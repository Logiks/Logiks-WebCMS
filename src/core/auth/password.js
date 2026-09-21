import argon2 from 'argon2';

// OWASP-recommended argon2id profile (19 MiB, t=2, p=1).
/** @type {Parameters<typeof argon2.hash>[1]} */
const OPTS = {
  type: /** @type {2} */ (argon2.argon2id),
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export const hashPassword = (plain) => argon2.hash(plain, OPTS);
export const verifyPassword = (hash, plain) => argon2.verify(hash, plain).catch(() => false);
export const needsRehash = (hash) => argon2.needsRehash(hash, OPTS);

let dummy;
/** Burn the same CPU as a real check so unknown emails can't be told apart by timing. */
export async function verifyDummy(plain) {
  dummy ??= await hashPassword('timing-equalizer');
  await verifyPassword(dummy, plain);
}
