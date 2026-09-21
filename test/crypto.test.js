import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrypto } from '../src/core/crypto.js';

const A = 'key-A-key-A-key-A-key-A-1234';
const B = 'key-B-key-B-key-B-key-B-5678';

test('round-trips and never repeats ciphertext', () => {
  const c = createCrypto({ APP_MASTER_KEY: A });
  const e1 = c.encrypt('"hunter2"', 'mail.password');
  const e2 = c.encrypt('"hunter2"', 'mail.password');
  assert.match(e1, /^enc:v1:/);
  assert.notEqual(e1, e2);
  assert.equal(c.decrypt(e1, 'mail.password'), '"hunter2"');
});

test('ciphertext is bound to its setting (AAD): swapping rows fails', () => {
  const c = createCrypto({ APP_MASTER_KEY: A });
  const e = c.encrypt('"x"', 'mail.password');
  assert.throws(() => c.decrypt(e, 'security.session_secret'));
});

test('tampering is detected', () => {
  const c = createCrypto({ APP_MASTER_KEY: A });
  const e = c.encrypt('"x"', 'a.b');
  const parts = e.split(':');
  parts[5] = Buffer.from('tampered').toString('base64');
  assert.throws(() => c.decrypt(parts.join(':'), 'a.b'));
});

test('key rotation: old key still decrypts, new writes use the new key', () => {
  const old = createCrypto({ APP_MASTER_KEY: A });
  const e = old.encrypt('"v"', 'a.b');
  const rotated = createCrypto({ APP_MASTER_KEY: B, APP_MASTER_KEY_OLD: A });
  assert.equal(rotated.decrypt(e, 'a.b'), '"v"');
  assert.ok(rotated.needsRotation(e));
  assert.ok(!rotated.needsRotation(rotated.encrypt('"v"', 'a.b')));
  assert.throws(() => createCrypto({ APP_MASTER_KEY: B }).decrypt(e, 'a.b'), /No master key/);
});
