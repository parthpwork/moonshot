import { db, schema } from '../lib/db.js';
import { apiHeaders, authorized, body, checkOrigin, respondError } from '../lib/security.js';
import { validateRecord } from '../lib/records.js';
export default async function handler(req, res) {
  apiHeaders(res);
  try {
    await schema();
    if (!(await authorized(req))) return res.status(401).json({ error: 'Sign in to continue cloud saving.' });
    if (req.method === 'GET') {
      const cursor = typeof req.query?.cursor === 'string' ? req.query.cursor : '';
      // Pages stay below Vercel's response size limit, even with large journals.
      const rows = await db()`WITH page AS (SELECT key, data, revision, operation_id, updated_at, sum(octet_length(coalesce(data::text,'null')) + 400) OVER (ORDER BY key) AS size FROM moonshot_records WHERE key > ${cursor} ORDER BY key LIMIT 100) SELECT key, data, revision, operation_id, updated_at FROM page WHERE size <= 2200000 ORDER BY key`;
      return res.json({ records: rows, cursor: rows.at(-1)?.key || null });
    }
    if (req.method !== 'PUT') return res.status(405).end();
    checkOrigin(req);
    const { key, data, revision, operationId } = validateRecord(body(req));
    const sql = db();
    // Atomic compare-and-swap; retrying the same operation never creates a new revision.
    // The previous version is retained once per hour per record, without an expiry.
    const rows = await sql`WITH prior AS MATERIALIZED (SELECT * FROM moonshot_records WHERE key = ${key}), changed AS (
      INSERT INTO moonshot_records(key,data,revision,operation_id) SELECT ${key},${JSON.stringify(data)}::jsonb,1,${operationId} WHERE ${revision} = 0
      ON CONFLICT(key) DO NOTHING RETURNING *
    ), updated AS (
      UPDATE moonshot_records SET data = ${JSON.stringify(data)}::jsonb, revision = moonshot_records.revision + 1, operation_id = ${operationId}, updated_at = now()
      WHERE key = ${key} AND revision = ${revision} AND operation_id <> ${operationId} AND ${revision} > 0 RETURNING *
    ), applied AS (SELECT * FROM changed UNION ALL SELECT * FROM updated), snapshot AS (
      INSERT INTO moonshot_history(key,hour,data,revision) SELECT prior.key,date_trunc('hour',now()),prior.data,prior.revision FROM prior WHERE EXISTS(SELECT 1 FROM applied) ON CONFLICT DO NOTHING RETURNING key
    ) SELECT * FROM applied UNION ALL SELECT * FROM prior WHERE operation_id = ${operationId} AND NOT EXISTS(SELECT 1 FROM applied)`;
    if (rows.length) return res.json({ record: rows[0] });
    const latest = await sql`SELECT key,data,revision,operation_id,updated_at FROM moonshot_records WHERE key = ${key}`;
    return res.status(409).json({ error: 'This entry changed on another device.', record: latest[0] || null });
  } catch (error) { return respondError(res, error); }
}
