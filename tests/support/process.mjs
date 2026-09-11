export async function eventually(fn, timeout = 15_000) {
  const end = Date.now() + timeout; let error;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (e) { error = e; } await new Promise(r => setTimeout(r, 100)); }
  throw error ?? new Error('Timed out waiting for test condition');
}
