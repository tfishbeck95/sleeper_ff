import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { League, LeagueSnapshot, Matchup, NflPlayer, Roster, TradedDraftPick, Transaction, User, WeeklySnapshot } from '@sleeper/domain';

export interface StoreShape {
  snapshots: Record<string, LeagueSnapshot>;
  leagues: Record<string, League>; users: Record<string, User>; players: Record<string, NflPlayer>;
  rosters: Record<string, Roster>; matchups: Record<string, Matchup>; transactions: Record<string, Transaction>;
  draftPicks: Record<string, TradedDraftPick>; weeklySnapshots: WeeklySnapshot[];
  freshness: Record<string, string>;
  syncLog: { leagueId: string; syncedAt: string; status: 'success' | 'failed'; category?: string; durationMs?: number }[];
}
const empty = (): StoreShape => ({ snapshots: {}, leagues: {}, users: {}, players: {}, rosters: {}, matchups: {}, transactions: {}, draftPicks: {}, weeklySnapshots: [], freshness: {}, syncLog: [] });
export interface SyncWrite { league?: League; users?: User[]; players?: NflPlayer[]; rosters?: Roster[]; matchups?: Matchup[]; transactions?: Transaction[]; draftPicks?: TradedDraftPick[]; replaceDraftPicksForLeague?: string; weeklySnapshot?: WeeklySnapshot; freshness?: Record<string, string>; }

export class JsonStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async read(): Promise<StoreShape> {
    try { return { ...empty(), ...JSON.parse(await readFile(this.path, 'utf8')) as StoreShape }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; return empty(); }
  }
  private write(mutator: (data: StoreShape) => void): Promise<void> {
    const operation = this.writes.then(async () => { const data = await this.read(); mutator(data); await mkdir(dirname(this.path), { recursive: true }); const temp = `${this.path}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(data, null, 2)); await rename(temp, this.path); });
    this.writes = operation.catch(() => undefined); return operation;
  }
  async snapshot(id: string) { return (await this.read()).snapshots[id]; }
  async save(snapshot: LeagueSnapshot) { await this.write(data => { data.snapshots[snapshot.leagueId] = snapshot; data.syncLog.unshift({ leagueId: snapshot.leagueId, syncedAt: snapshot.lastSyncedAt, status: 'success' }); data.syncLog = data.syncLog.slice(0, 100); }); }
  async resourceSyncedAt(key: string) { return (await this.read()).freshness[key]; }
  async league(id: string) { return (await this.read()).leagues[id]; }
  async rosters(leagueId: string) { return Object.values((await this.read()).rosters).filter(value => value.leagueId === leagueId); }
  async waiverContext(leagueId: string) {
    const data = await this.read();
    return { league: data.leagues[leagueId], rosters: Object.values(data.rosters).filter(r => r.leagueId === leagueId), players: Object.values(data.players) };
  }
  async tradeContext(leagueId: string) {
    const data = await this.read();
    const pickAge = Date.now() - Date.parse(data.freshness[`draftPicks:${leagueId}`]);
    return { league: data.leagues[leagueId], rosters: Object.values(data.rosters).filter(r => r.leagueId === leagueId), players: Object.values(data.players), users: Object.values(data.users), tradedPicks: Number.isFinite(pickAge) && pickAge >= -5 * 60_000 && pickAge <= 10 * 60_000 ? Object.values(data.draftPicks).filter(p => p.leagueId === leagueId) : undefined };
  }
  async applySync(write: SyncWrite) { await this.write(data => {
    const upsert = <T extends { id: string }>(target: Record<string, T>, values?: T[]) => { for (const value of values ?? []) target[value.id] = value; };
    if (write.league) data.leagues[write.league.id] = write.league;
    // Transfers are an authoritative snapshot: returned/native picks must not retain old owners.
    if (write.replaceDraftPicksForLeague && write.draftPicks) for (const [id, pick] of Object.entries(data.draftPicks)) if (pick.leagueId === write.replaceDraftPicksForLeague) delete data.draftPicks[id];
    upsert(data.users, write.users); upsert(data.players, write.players); upsert(data.rosters, write.rosters); upsert(data.matchups, write.matchups); upsert(data.transactions, write.transactions); upsert(data.draftPicks, write.draftPicks);
    // Weekly observations are append-only; a caller-generated id makes retrying the same observation idempotent.
    if (write.weeklySnapshot && !data.weeklySnapshots.some(snapshot => snapshot.id === write.weeklySnapshot!.id)) data.weeklySnapshots.push(write.weeklySnapshot);
    Object.assign(data.freshness, write.freshness);
  }); }
  async recordSync(leagueId: string, status: 'success' | 'failed', syncedAt: string, durationMs: number, category?: string) { await this.write(data => { data.syncLog.unshift({ leagueId, status, syncedAt, durationMs, ...(category ? { category } : {}) }); data.syncLog = data.syncLog.slice(0, 100); }); }
}
