// A tab can close between an async check and a browser UI update.
export async function ignoreClosedTab(action) {
  try { return await action(); } catch { return null; }
}
