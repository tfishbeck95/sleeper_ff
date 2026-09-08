import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DraftPick, League, LeagueSnapshot, Matchup, NflPlayer, Roster, Transaction, User, WeeklySnapshot } from '@sleeper/domain';
export interface SyncRun { leagueId: string; syncedAt: string; status: 'success' | 'failed'; category?: string; durationMs?: number; }
export interface StoreShape {
  snapshots: Record<string, LeagueSnapshot>;
  users: Record<string, User>; leagues: Record<string, League>; players: Record<string, NflPlayer>; rosters: Record<string, Roster>;
  matchups: Record<string, Matchup>; transactions: Record<string, Transaction>; draftPicks: Record<string, DraftPick>;
  weeklySnapshots: Record<string, WeeklySnapshot>; freshness: Record<string, string>; syncLog: SyncRun[];
}
const empty = (): StoreShape => ({ snapshots: {}, users: {}, leagues: {}, players: {}, rosters: {}, matchups: {}, transactions: {}, draftPicks: {}, weeklySnapshots: {}, freshness: {}, syncLog: [] });
export class JsonStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async read(): Promise<StoreShape> { try { return { ...empty(), ...JSON.parse(await readFile(this.path, 'utf8')) as Partial<StoreShape> }; } catch { return empty(); } }
  private mutate(fn: (data: StoreShape) => void): Promise<void> { const operation = this.writes.then(async () => { const data = await this.read(); fn(data); await mkdir(dirname(this.path), { recursive: true }); const temp = `${this.path}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(data, null, 2)); await rename(temp, this.path); }); this.writes = operation.catch(() => undefined); return operation; }
  async snapshot(id: string) { await this.writes; return (await this.read()).snapshots[id]; }
  async data() { await this.writes; return this.read(); }
  async save(snapshot: LeagueSnapshot) { await this.mutate(data => { data.snapshots[snapshot.leagueId] = snapshot; data.syncLog.unshift({ leagueId: snapshot.leagueId, syncedAt: snapshot.lastSyncedAt, status: 'success' }); data.syncLog = data.syncLog.slice(0, 100); }); }
  async persistSync(resources: { users: User[]; league: League; players?: NflPlayer[]; rosters: Roster[]; matchups: Matchup[]; transactions: Transaction[]; draftPicks: DraftPick[]; weeklySnapshots: WeeklySnapshot[]; freshness: Record<string, string> }, run: SyncRun) {
    await this.mutate(data => {
      const upsert = <T extends { id: string }>(target: Record<string, T>, values: T[]) => values.forEach(value => { target[value.id] = value; });
      upsert(data.users, resources.users); upsert(data.leagues, [resources.league]); if (resources.players) upsert(data.players, resources.players); upsert(data.rosters, resources.rosters); upsert(data.matchups, resources.matchups); upsert(data.transactions, resources.transactions); upsert(data.draftPicks, resources.draftPicks);
      // A season/week/roster key is write-once: later syncs cannot rewrite historical evidence.
      resources.weeklySnapshots.forEach(snapshot => { data.weeklySnapshots[snapshot.id] ??= snapshot; });
      Object.assign(data.freshness, resources.freshness); data.syncLog.unshift(run); data.syncLog = data.syncLog.slice(0, 100);
    });
  }
  async recordFailure(run: SyncRun) { await this.mutate(data => { data.syncLog.unshift(run); data.syncLog = data.syncLog.slice(0, 100); }); }
}
