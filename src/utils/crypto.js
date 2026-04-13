import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) throw new Error('ENCRYPTION_KEY must be a 64-char hex string');
  return Buffer.from(key, 'hex');
}

export function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('hex'), data: encrypted.toString('hex'), tag: tag.toString('hex') };
}

export function decrypt(encryptedHex, ivHex, tagHex) {
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function generateProxyKey() {
  return `vix_${crypto.randomBytes(24).toString('base64url')}`;
}

export function generateInviteCode() {
  return crypto.randomBytes(16).toString('hex');
}

export function generateId() {
  return crypto.randomUUID();
}

export function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}
