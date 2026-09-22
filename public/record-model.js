// Storage format is independent of the UI. Deleted records are tombstones.
export function splitWorkspace(state) {
  const records = {
    meta: { version: 1, createdAt: state.createdAt },
    profile: state.profile, anchors: state.anchors, settings: state.settings,
    timer: state.timer || null
  };
  for (const [key, value] of Object.entries(state.days)) records[`day:${key}`] = value;
  for (const [key, value] of Object.entries(state.weeks)) records[`week:${key}`] = value;
  for (const session of state.sessions) records[`session:${session.id}`] = session;
  return records;
}
export function joinWorkspace(records, empty) {
  const state = empty();
  for (const [key, value] of Object.entries(records)) {
    if (value === null || value === undefined) continue;
    if (key === 'meta') Object.assign(state, value);
    else if (['profile', 'anchors', 'settings', 'timer'].includes(key)) state[key] = value;
    else if (key.startsWith('day:')) state.days[key.slice(4)] = value;
    else if (key.startsWith('week:')) state.weeks[key.slice(5)] = value;
    else if (key.startsWith('session:')) state.sessions.push(value);
  }
  state.sessions.sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)));
  return state;
}
export const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
