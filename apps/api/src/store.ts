import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LeagueSnapshot } from '@sleeper/domain';
export interface StoreShape { snapshots: Record<string, LeagueSnapshot>; syncLog: { leagueId: string; syncedAt: string; status: 'success' | 'failed' }[]; }
export class JsonStore {
  constructor(private readonly path: string) {}
  private async read(): Promise<StoreShape> { try { return JSON.parse(await readFile(this.path, 'utf8')) as StoreShape; } catch { return { snapshots: {}, syncLog: [] }; } }
  async snapshot(id: string) { return (await this.read()).snapshots[id]; }
  async save(snapshot: LeagueSnapshot) { const data = await this.read(); data.snapshots[snapshot.leagueId] = snapshot; data.syncLog.unshift({ leagueId: snapshot.leagueId, syncedAt: snapshot.lastSyncedAt, status: 'success' }); data.syncLog = data.syncLog.slice(0, 100); await mkdir(dirname(this.path), { recursive: true }); const temp = `${this.path}.tmp`; await writeFile(temp, JSON.stringify(data, null, 2)); await rename(temp, this.path); }
}
