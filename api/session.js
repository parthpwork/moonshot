import { db, schema } from '../lib/db.js';
import { apiHeaders, authorized, body, checkOrigin, digest, hashPassword, newSession, rateLimit, respondError, secretMatches, verifyPassword } from '../lib/security.js';
export default async function handler(req, res) {
  apiHeaders(res);
  try {
    await schema();
    if (req.method === 'GET') {
      const owner = await db()`SELECT id FROM moonshot_owner WHERE id = 1`;
      return res.json({ authenticated: await authorized(req), setupRequired: !owner.length });
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
    const password = input.password;
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) return res.status(400).json({ error: 'Use a password between 12 and 256 characters.' });
    if (input.action === 'setup') {
      if (!secretMatches(input.setupToken, process.env.MOONSHOT_SETUP_TOKEN)) return res.status(403).json({ error: 'The private setup code is incorrect.' });
      const hash = await hashPassword(password);
      const inserted = await db()`INSERT INTO moonshot_owner(id, password_hash) VALUES (1, ${hash}) ON CONFLICT DO NOTHING RETURNING id`;
      if (!inserted.length) return res.status(409).json({ error: 'Moonshot is already set up. Sign in instead.' });
    } else if (input.action === 'login') {
      const owner = await db()`SELECT password_hash FROM moonshot_owner WHERE id = 1`;
      if (!owner.length || !(await verifyPassword(password, owner[0].password_hash))) return res.status(401).json({ error: 'That password did not match.' });
    } else return res.status(400).json({ error: 'Unknown action.' });
    await newSession(res);
    return res.json({ authenticated: true });
  } catch (error) { return respondError(res, error); }
}
