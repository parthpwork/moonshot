export function validateRecord(input) {
  const { key, data, revision, operationId } = input;
  const validKey = /^(profile|anchors|settings|timer|meta)$/.test(key) || /^(day|week):\d{4}-\d{2}-\d{2}$/.test(key) || /^session:[\w-]{1,100}$/.test(key);
  if (!validKey || typeof key !== 'string' || !Number.isSafeInteger(revision) || revision < 0 || typeof operationId !== 'string' || !/^[\w-]{16,100}$/.test(operationId)) throw Object.assign(new Error('Invalid record.'), { status: 400 });
  if (data !== null && (typeof data !== 'object' || data === undefined)) throw Object.assign(new Error('Invalid record data.'), { status: 400 });
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 1024 * 1024) throw Object.assign(new Error('This entry is too large to sync. Export a backup and split it into smaller entries.'), { status: 413 });
  return input;
}
