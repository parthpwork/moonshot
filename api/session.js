import { db, schema } from '../lib/db.js';
import { apiHeaders, authorized, body, checkOrigin, digest, hashPassword, newSession, rateLimit, respondError, verifyPassword } from '../lib/security.js';
export default async function handler(req, res) {
  apiHeaders(res);
  try {
    await schema();
    if (req.method === 'GET') {
      const user = await authorized(req);
      return res.json({ authenticated:!!user, user:user ? { id:user.id, username:user.username } : null });
    }
    if (req.method !== 'POST') return res.status(405).end();
    checkOrigin(req);
    const input = body(req);
    if (input.action === 'logout') {
      const token = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('moonshot_session='))?.slice(17);
      if (token) await db()`DELETE FROM moonshot_user_sessions WHERE token_hash=${digest(token)}`;
      res.setHeader('Set-Cookie', `moonshot_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.VERCEL ? '; Secure' : ''}`);
      return res.json({ ok:true });
    }
    await rateLimit(req);
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    const password = input.password;
    if (username.length < 6 || username.length > 64) return res.status(400).json({ error:'Use a username between 6 and 64 characters.' });
    if (typeof password !== 'string' || password.length < 6 || password.length > 256) return res.status(400).json({ error:'Use a password between 6 and 256 characters.' });
    let user;
    if (input.action === 'register') {
      const hash = await hashPassword(password);
      const rows = await db()`INSERT INTO moonshot_users(username,password_hash) SELECT ${username},${hash} WHERE NOT EXISTS(SELECT 1 FROM moonshot_users WHERE lower(username)=${username}) ON CONFLICT DO NOTHING RETURNING id,username`;
      if (!rows.length) return res.status(409).json({ error:'That username is already taken.' });
      user = rows[0];
    } else if (input.action === 'login') {
      const rows = await db()`SELECT id,username,password_hash FROM moonshot_users WHERE lower(username)=${username}`;
      if (!rows.length || !(await verifyPassword(password, rows[0].password_hash))) return res.status(401).json({ error:'That username or password did not match.' });
      user = rows[0];
    } else return res.status(400).json({ error:'Unknown action.' });
    await newSession(res, user.id);
    return res.json({ authenticated:true, user:{ id:user.id, username:user.username } });
  } catch (error) { return respondError(res, error); }
}
