import { db, schema } from '../lib/db.js';
import { apiHeaders, authorized, body, checkOrigin, digest, hashPassword, newSession, rateLimit, respondError, verifyPassword } from '../lib/security.js';
export default async function handler(req, res) {
  apiHeaders(res);
  try {
    await schema();
    if (req.method === 'GET') {
      const owner = await db()`SELECT id, username FROM moonshot_owner WHERE id = 1`;
      return res.json({ authenticated: await authorized(req), setupRequired: !owner.length || !owner[0].username });
    }
    if (req.method !== 'POST') return res.status(405).end();
    checkOrigin(req);
    const input = body(req);
    if (input.action === 'logout') {
      const token = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('moonshot_session='))?.slice(17);
      if (token) await db()`DELETE FROM moonshot_sessions WHERE token_hash = ${digest(token)}`;
      res.setHeader('Set-Cookie', `moonshot_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.VERCEL ? '; Secure' : ''}`);
      return res.json({ ok: true });
    }
    await rateLimit(req);
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    const password = input.password;
    if (username.length < 6 || username.length > 64) return res.status(400).json({ error: 'Use a username between 6 and 64 characters.' });
    if (typeof password !== 'string' || password.length < 6 || password.length > 256) return res.status(400).json({ error: 'Use a password between 6 and 256 characters.' });
    if (input.action === 'setup') {
      const hash = await hashPassword(password);
      const inserted = await db()`INSERT INTO moonshot_owner(id, username, password_hash) VALUES (1, ${username}, ${hash}) ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, password_hash = EXCLUDED.password_hash WHERE moonshot_owner.username IS NULL RETURNING id`;
      if (!inserted.length) return res.status(409).json({ error: 'Moonshot is already set up. Sign in instead.' });
    } else if (input.action === 'login') {
      const owner = await db()`SELECT password_hash FROM moonshot_owner WHERE id = 1 AND lower(username) = ${username}`;
      if (!owner.length || !(await verifyPassword(password, owner[0].password_hash))) return res.status(401).json({ error: 'That username or password did not match.' });
    } else return res.status(400).json({ error: 'Unknown action.' });
    await newSession(res);
    return res.json({ authenticated: true });
  } catch (error) { return respondError(res, error); }
}
