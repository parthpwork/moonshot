import { db, schema } from '../lib/db.js';
import { apiHeaders, authorized, respondError } from '../lib/security.js';
export default async function handler(req, res) {
  apiHeaders(res);
  try {
    await schema();
    if (!(await authorized(req))) return res.status(401).json({ error: 'Sign in to view saved history.' });
    if (req.method !== 'GET') return res.status(405).end();
    const key = typeof req.query?.key === 'string' ? req.query.key : '';
    const hour = typeof req.query?.hour === 'string' ? req.query.hour : '';
    if (key && hour) {
      const rows = await db()`SELECT key,hour,data,revision FROM moonshot_history WHERE key=${key} AND hour::text=${hour}`;
      return res.json({ records: rows });
    }
    const before = typeof req.query?.before === 'string' ? req.query.before : '9999-12-31';
    const rows = await db()`SELECT key,hour::text AS hour,revision FROM moonshot_history WHERE key=${key} AND hour < ${before}::timestamptz ORDER BY hour DESC LIMIT 100`;
    return res.json({ records: rows });
  } catch (error) { return respondError(res, error); }
}
