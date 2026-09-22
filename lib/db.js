import { neon } from '@neondatabase/serverless';
let client;
export function db() {
  if (!process.env.DATABASE_URL) throw Object.assign(new Error('Cloud storage is not configured yet.'), { status: 503 });
  return client ||= neon(process.env.DATABASE_URL);
}
// Idempotent schema creation; no user records are seeded or overwritten.
let ready;
export async function schema() {
  if (!ready) ready = db().transaction([
    db()`CREATE TABLE IF NOT EXISTS moonshot_owner (id integer PRIMARY KEY CHECK (id = 1), password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    db()`ALTER TABLE moonshot_owner ADD COLUMN IF NOT EXISTS username text`,
    db()`CREATE UNIQUE INDEX IF NOT EXISTS moonshot_owner_username_idx ON moonshot_owner (lower(username)) WHERE username IS NOT NULL`,
    db()`CREATE TABLE IF NOT EXISTS moonshot_sessions (token_hash text PRIMARY KEY, expires_at timestamptz NOT NULL)`,
    db()`CREATE TABLE IF NOT EXISTS moonshot_login_limits (key text PRIMARY KEY, attempts integer NOT NULL, expires_at timestamptz NOT NULL)`,
    db()`CREATE TABLE IF NOT EXISTS moonshot_records (key text PRIMARY KEY, data jsonb, revision integer NOT NULL DEFAULT 1, operation_id text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
    db()`CREATE TABLE IF NOT EXISTS moonshot_history (key text NOT NULL, hour timestamptz NOT NULL, data jsonb, revision integer NOT NULL, PRIMARY KEY (key, hour))`
  ]).catch(error => { ready = undefined; throw error; });
  return ready;
}
