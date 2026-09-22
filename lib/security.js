import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';
const scrypt = promisify(scryptCallback);
export const digest = value => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password) {
  const salt = randomBytes(32).toString('hex');
  const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [type, salt, hash] = String(stored).split(':');
  if (type !== 'scrypt' || !/^[a-f0-9]{64}$/.test(salt) || !/^[a-f0-9]{128}$/.test(hash)) return false;
  const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(key, Buffer.from(hash, 'hex'));
}
export function secretMatches(value, expected) {
  return typeof value === 'string' && typeof expected === 'string' && expected.length >= 32 && timingSafeEqual(Buffer.from(digest(value)), Buffer.from(digest(expected)));
}
export function checkOrigin(req) {
  const expected = `${process.env.VERCEL ? 'https' : 'http'}://${req.headers.host}`;
  if (req.headers.origin !== expected || req.headers['sec-fetch-site'] === 'cross-site') throw Object.assign(new Error('Request origin not allowed.'), { status: 403 });
}
export async function authorized(req) {
  const cookie = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('moonshot_session='));
  const token = cookie?.slice('moonshot_session='.length);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
  const rows = await db()`SELECT token_hash FROM moonshot_sessions WHERE token_hash = ${digest(token)} AND expires_at > now()`;
  return rows.length > 0;
}
export async function newSession(res) {
  const token = randomBytes(32).toString('hex');
  await db()`INSERT INTO moonshot_sessions(token_hash, expires_at) VALUES (${digest(token)}, now() + interval '30 days')`;
  res.setHeader('Set-Cookie', `moonshot_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${process.env.VERCEL ? '; Secure' : ''}`);
}
export async function rateLimit(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const key = digest(ip);
  const rows = await db()`INSERT INTO moonshot_login_limits(key, attempts, expires_at) VALUES (${key}, 1, now() + interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts = CASE WHEN moonshot_login_limits.expires_at <= now() THEN 1 ELSE moonshot_login_limits.attempts + 1 END, expires_at = CASE WHEN moonshot_login_limits.expires_at <= now() THEN now() + interval '15 minutes' ELSE moonshot_login_limits.expires_at END RETURNING attempts`;
  if (rows[0].attempts > 10) throw Object.assign(new Error('Too many attempts. Try again in 15 minutes.'), { status: 429 });
}
export function respondError(res, error) {
  const status = [400,401,403,409,413,429,503].includes(error.status) ? error.status : 500;
  // Never log request bodies, passwords, journals, database URLs, or provider errors.
  if (status === 500) console.error('Moonshot request failed', error.code || 'server_error');
  return res.status(status).json({ error: status === 500 ? 'Cloud storage is temporarily unavailable. Your device copy has been kept.' : error.message });
}
export function apiHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
export function body(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('JSON required.'), { status: 400 });
  let value;
  try { value = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Invalid request.'), { status: 400 });
  return value;
}
