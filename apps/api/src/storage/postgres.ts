import pg from 'pg';
import { scoringSnapshotId, type ScoringConfiguration } from '@sleeper/domain';
import { JsonStore, emptyStore, type StoreShape } from '../store.js';

// The existing domain operations remain the authority for atomic replacements, session rotation,
// citations and retention. This adapter maps their state onto the production relational schema.
// One SELECT reads a consistent MVCC snapshot. A transaction-level lock serializes read/modify/write
// operations across processes; only changed rows are written. This intentionally favors correctness
// for small installations over write throughput. No in-memory state is retained between operations.
type Row = Record<string, any>;
interface Table { name: string; key: string[]; fields: string[]; json: string[]; immutable?: boolean }
const table = (name: string, key: string, fields: string, json = '', immutable = false): Table =>
  ({ name, key: key.split(' '), fields: fields.split(' '), json: json ? json.split(' ') : [], immutable });
const tables = [
  table('app_user', 'id', 'id login password_hash created_at'),
  table('sleeper_account', 'user_id', 'user_id sleeper_user_id sleeper_username linked_at'),
  table('app_user_league', 'user_id sleeper_league_id', 'user_id sleeper_league_id linked_at'),
  table('app_session', 'id_hash', 'id_hash user_id family_id created_at expires_at absolute_expires_at last_rotated_at last_seen_at superseded_at revoked_at revoked_reason'),
  table('app_session_csrf', 'session_id_hash csrf_hash', 'session_id_hash csrf_hash issued_at'),
  table('league_connection', 'league_id', 'league_id demo status linked season week created_at updated_at archived_at archived_reason last_attempted_at last_synced_at last_status last_category last_duration_ms last_refreshed resource_freshness consecutive_failures next_attempt_at', 'resource_freshness'),
  table('league', 'id', 'id name season status previous_league_id total_rosters roster_positions settings season_type scoring_snapshot_id source_updated_at synchronized_at', 'roster_positions settings'),
  table('league_scoring_snapshot', 'league_id id', 'id league_id kind observed_at last_attempted_at settings raw_settings issues recorded_at', 'settings raw_settings issues', true),
  table('sleeper_user', 'id', 'id username display_name avatar_id source_updated_at synchronized_at'),
  table('player', 'id', 'id first_name last_name full_name team position fantasy_positions status injury_status source_updated_at synchronized_at'),
  table('player_directory_state', 'singleton', 'singleton synchronized_at last_attempted_at next_attempt_at last_error'),
  table('player_alias', 'source alias_key', 'source alias_key player_id alias_kind display_name team position observed_at'),
  table('roster', 'id', 'id league_id roster_id owner_id player_ids starter_ids reserve_ids taxi_ids settings source_updated_at synchronized_at', 'settings'),
  table('roster_owner', 'roster_id sleeper_user_id', 'roster_id sleeper_user_id role synchronized_at'),
  table('matchup', 'id', 'id league_id season week matchup_id roster_id points custom_points player_ids starter_ids player_points source_updated_at synchronized_at', 'player_points'),
  table('league_transaction', 'id', 'id league_id week type status roster_ids waiver_budget source_updated_at synchronized_at', 'waiver_budget'),
  table('transaction_player', 'transaction_id player_id action', 'transaction_id player_id action roster_id'),
  table('transaction_draft_pick', 'transaction_id season round roster_id', 'transaction_id season round roster_id previous_owner_id owner_id'),
  table('traded_draft_pick', 'id', 'id league_id season round roster_id previous_owner_id owner_id source_updated_at synchronized_at'),
  table('weekly_snapshot', 'id', 'id league_id season week scoring_snapshot_id source_updated_at synchronized_at payload', 'payload', true),
  table('roster_history', 'id', 'id league_id roster_id season week observed_at owner_id co_owner_ids player_ids starter_ids reserve_ids taxi_ids settings weekly_snapshot_id', 'settings', true),
  table('forecast_snapshot', 'id', 'id source season week source_updated_at ingested_at player_count identity_match_rate derived_fields coverage licenses report', 'coverage licenses report', true),
  table('recommendation', 'id', 'id league_id season week roster_id kind subject_player_id counterpart_player_id title rationale confidence projected_points scoring_snapshot_id forecast_snapshot_id generated_at payload', 'payload'),
  table('recommendation_explanation', 'recommendation_id ordinal', 'recommendation_id ordinal kind label detail points'),
  table('recommendation_outcome', 'id', 'id recommendation_id observed_at resolution projected_points actual_points counterfactual_points scoring_snapshot_id note recorded_at', '', true),
  table('sync_run', 'id', 'id league_id kind status category season week started_at finished_at duration_ms refreshed next_attempt_at worker_id'),
  table('resource_freshness', 'resource_key', 'resource_key league_id resource season week synchronized_at'),
  table('sync_lease', 'key', 'key owner acquired_at expires_at'),
  table('dashboard_snapshot', 'league_id', 'league_id payload', 'payload'),
];
const snake = (s: string) => s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const row = (value: Row): Row => Object.fromEntries(Object.entries(value).map(([k, v]) => [snake(k), v]));
const record = (value: Row): Row => Object.fromEntries(Object.entries(value).map(([k, v]) =>
  [camel(k), v !== null && k.endsWith('_at') ? new Date(v).toISOString() : v]));
const optional = (value: Row, keys: string) => { for (const k of keys.split(' ')) if (value[k] == null) delete value[k]; return value; };
const keyed = (values: Row[], key = 'id') => Object.fromEntries(values.map(v => [v[key], v]));
const values = (v: object): Row[] => Object.values(v);
const scoring = (r?: Row): ScoringConfiguration | undefined => r ? ({ kind: r.kind, synchronizedAt: r.observedAt,
  lastAttemptedAt: r.lastAttemptedAt, settings: r.settings, rawSettings: r.rawSettings, issues: r.issues }) as ScoringConfiguration : undefined;

function decode(raw: Record<string, Row[]>): StoreShape {
  const d = emptyStore();
  const get = (name: string) => raw[name].map(record);
  d.applicationUsers = keyed(get('app_user').map(u => {
    const a = get('sleeper_account').find(a => a.userId === u.id);
    return { ...u, ...(a ? { sleeperUserId: a.sleeperUserId, sleeperUsername: a.sleeperUsername, sleeperLinkedAt: a.linkedAt } : {}),
      sleeperLeagueIds: get('app_user_league').filter(l => l.userId === u.id).map(l => l.sleeperLeagueId).sort() };
  })) as StoreShape['applicationUsers'];
  d.sessions = keyed(get('app_session').map(s => ({ ...optional(s, 'supersededAt revokedAt revokedReason'),
    csrfHashes: get('app_session_csrf').filter(c => c.sessionIdHash === s.idHash).sort((a,b) => a.issuedAt.localeCompare(b.issuedAt)).map(c => c.csrfHash) })), 'idHash') as StoreShape['sessions'];
  d.leagueConnections = keyed(get('league_connection').map(r => optional(r, 'archivedAt archivedReason lastAttemptedAt lastSyncedAt lastStatus lastCategory lastDurationMs nextAttemptAt')), 'leagueId') as StoreShape['leagueConnections'];
  for (const r of get('league_scoring_snapshot').sort((a,b) => a.recordedAt.localeCompare(b.recordedAt))) (d.scoringSnapshots[r.leagueId] ??= []).push(optional(r, 'lastAttemptedAt') as any);
  d.leagues = keyed(get('league').map(l => { const { scoringSnapshotId: id, ...rest } = l; return { ...optional(rest, 'seasonType'), scoringSettings: [], scoring: scoring(d.scoringSnapshots[l.id]?.find(s => s.id === id)) }; })) as StoreShape['leagues'];
  d.users = keyed(get('sleeper_user')) as StoreShape['users'];
  d.players = keyed(get('player')) as StoreShape['players'];
  const metadata = get('player_directory_state')[0];
  if (metadata) { delete metadata.singleton; d.playerMetadata = metadata as any; }
  d.playerAliases = get('player_alias').map(({ aliasKind, ...r }) => ({ ...r, kind: aliasKind })) as StoreShape['playerAliases'];
  d.rosters = keyed(get('roster').map(r => ({ ...r, coOwnerIds: get('roster_owner').filter(o => o.rosterId === r.id && o.role === 'co-owner').map(o => o.sleeperUserId).sort() }))) as StoreShape['rosters'];
  d.matchups = keyed(get('matchup')) as StoreShape['matchups'];
  d.transactions = keyed(get('league_transaction').map(t => ({ ...t,
    adds: Object.fromEntries(get('transaction_player').filter(p => p.transactionId === t.id && p.action === 'add').map(p => [p.playerId, p.rosterId])),
    drops: Object.fromEntries(get('transaction_player').filter(p => p.transactionId === t.id && p.action === 'drop').map(p => [p.playerId, p.rosterId])),
    draftPicks: get('transaction_draft_pick').filter(p => p.transactionId === t.id).map(({ transactionId, ...p }) => p),
  }))) as StoreShape['transactions'];
  d.draftPicks = keyed(get('traded_draft_pick')) as StoreShape['draftPicks'];
  d.weeklySnapshots = get('weekly_snapshot').map(({ payload, scoringSnapshotId: id, ...w }) => ({ ...w,
    rosters: payload?.rosters ?? [], matchups: payload?.matchups ?? [],
    rosterIds: (payload?.rosters ?? []).map((r: Row) => r.id), matchupIds: (payload?.matchups ?? []).map((m: Row) => m.id),
    scoring: scoring(d.scoringSnapshots[w.leagueId]?.find(s => s.id === id)),
  })) as StoreShape['weeklySnapshots'];
  d.rosterHistory = get('roster_history').map(r => optional(r, 'weeklySnapshotId')) as StoreShape['rosterHistory'];
  d.forecastSnapshots = get('forecast_snapshot') as StoreShape['forecastSnapshots'];
  d.recommendations = keyed(get('recommendation').map(r => ({ ...r, explanations: get('recommendation_explanation').filter(e => e.recommendationId === r.id).map(({ recommendationId, ...e }) => e).sort((a,b) => a.ordinal-b.ordinal) }))) as StoreShape['recommendations'];
  d.recommendationOutcomes = get('recommendation_outcome') as StoreShape['recommendationOutcomes'];
  d.syncLog = get('sync_run').sort((a,b) => b.startedAt.localeCompare(a.startedAt)).map(({ startedAt, ...r }) => ({ ...optional(r, 'category nextAttemptAt workerId'), syncedAt: startedAt })) as StoreShape['syncLog'];
  d.freshness = Object.fromEntries(get('resource_freshness').map(r => [r.resourceKey, r.synchronizedAt]));
  d.leases = keyed(get('sync_lease'), 'key') as StoreShape['leases'];
  d.snapshots = Object.fromEntries(get('dashboard_snapshot').map(r => [r.leagueId, r.payload]));
  return d;
}

function encode(d: StoreShape): Record<string, Row[]> {
  const out: Record<string, Row[]> = Object.fromEntries(tables.map(t => [t.name, []]));
  const put = (name: string, records: Row[]) => { out[name] = records.map(row); };
  const users = values(d.applicationUsers);
  put('app_user', users);
  put('sleeper_account', users.filter(u => u.sleeperUserId).map(u => ({ userId: u.id, sleeperUserId: u.sleeperUserId, sleeperUsername: u.sleeperUsername ?? u.sleeperUserId, linkedAt: u.sleeperLinkedAt ?? u.createdAt })));
  put('app_user_league', users.flatMap(u => [...new Set(u.sleeperLeagueIds)].map(id => ({ userId: u.id, sleeperLeagueId: id, linkedAt: u.sleeperLinkedAt ?? u.createdAt }))));
  put('app_session', values(d.sessions));
  put('app_session_csrf', values(d.sessions).flatMap(s => s.csrfHashes.map((hash: string, i: number) => ({ sessionIdHash: s.idHash, csrfHash: hash, issuedAt: new Date(Date.parse(s.createdAt) + i).toISOString() }))));
  put('league_connection', values(d.leagueConnections).map(c => ({ ...c, lastRefreshed: c.lastRefreshed ?? [], resourceFreshness: c.resourceFreshness ?? {} })));
  put('league', values(d.leagues).map(l => ({ ...l, scoringSnapshotId: l.scoring ? scoringSnapshotId(l.scoring) : null })));
  put('league_scoring_snapshot', Object.values(d.scoringSnapshots).flat());
  put('sleeper_user', values(d.users)); put('player', values(d.players));
  put('player_directory_state', d.playerMetadata ? [{ singleton: true, ...d.playerMetadata }] : []);
  put('player_alias', d.playerAliases.map(a => ({ ...a, aliasKind: a.kind })));
  put('roster', values(d.rosters));
  put('roster_owner', values(d.rosters).flatMap(r => [
    ...(r.ownerId ? [{ rosterId: r.id, sleeperUserId: r.ownerId, role: 'owner', synchronizedAt: r.synchronizedAt }] : []),
    ...[...new Set(r.coOwnerIds)].filter(id => id !== r.ownerId).map(id => ({ rosterId: r.id, sleeperUserId: id, role: 'co-owner', synchronizedAt: r.synchronizedAt })),
  ]));
  put('matchup', values(d.matchups)); put('league_transaction', values(d.transactions));
  put('transaction_player', values(d.transactions).flatMap(t => ['add', 'drop'].flatMap(action => Object.entries(t[`${action}s`]).map(([id, rosterId]) => ({ transactionId: t.id, playerId: id, action, rosterId })))));
  put('transaction_draft_pick', values(d.transactions).flatMap(t => t.draftPicks.map((p: Row) => ({ ...p, transactionId: t.id }))));
  put('traded_draft_pick', values(d.draftPicks));
  put('weekly_snapshot', d.weeklySnapshots.map(w => ({ ...w, scoringSnapshotId: w.scoring ? scoringSnapshotId(w.scoring) : null, payload: { rosters: w.rosters, matchups: w.matchups } })));
  put('roster_history', d.rosterHistory);
  put('forecast_snapshot', d.forecastSnapshots.map(f => ({ ...f, derivedFields: f.derivedFields ?? [], coverage: f.coverage ?? {}, licenses: f.licenses ?? [] })));
  put('recommendation', values(d.recommendations).map(r => ({ ...r, payload: r.payload ?? {} })));
  put('recommendation_explanation', values(d.recommendations).flatMap(r => (r.explanations ?? []).map((e: Row) => ({ ...e, recommendationId: r.id }))));
  put('recommendation_outcome', d.recommendationOutcomes);
  put('sync_run', d.syncLog.map(r => ({ ...r, id: r.id ?? `${r.leagueId}:${r.syncedAt}`, kind: r.kind ?? 'league', startedAt: r.syncedAt,
    finishedAt: r.finishedAt ?? new Date(Date.parse(r.syncedAt) + (r.durationMs ?? 0)).toISOString(), durationMs: r.durationMs ?? 0, refreshed: r.refreshed ?? [] })));
  put('resource_freshness', Object.entries(d.freshness).map(([key, at]) => { const [resource, leagueId, season, week] = key.split(':'); return { resourceKey: key, resource, leagueId: d.leagues[leagueId] ? leagueId : null, season: season ?? null, week: week ? Number(week) : null, synchronizedAt: at }; }));
  put('sync_lease', values(d.leases));
  put('dashboard_snapshot', Object.entries(d.snapshots).map(([id, payload]) => ({ leagueId: id, payload })));
  // Nulls, rather than omitted keys, make comparison independent of optional TypeScript fields.
  for (const t of tables) out[t.name] = out[t.name].map(r => Object.fromEntries(t.fields.map(k => [k, r[k] ?? null])));
  return out;
}
const readSql = `SELECT jsonb_build_object(${tables.map(t => `'${t.name}', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM ${t.name} t)`).join(',')}) AS data`;
const rowKey = (t: Table, r: Row) => JSON.stringify(t.key.map(k => r[k]));
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class PostgresStore extends JsonStore {
  override readonly adapter = 'postgres' as const;
  protected override readonly syncLogLimit = Infinity;
  private readonly pool: pg.Pool;
  constructor(databaseUrl: string) {
    super('');
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5_000, statement_timeout: 15_000 });
    // A disconnected idle connection should not crash the process; the next request checks storage.
    this.pool.on('error', () => {});
  }
  protected override async read(): Promise<StoreShape> {
    return decode((await this.pool.query(readSql)).rows[0].data);
  }
  protected override async write(mutator: (data: StoreShape) => void): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query('SELECT pg_advisory_xact_lock(778811223345)');
      const data = decode((await client.query(readSql)).rows[0].data);
      const before = encode(data);
      mutator(data);
      const after = encode(data);
      // Child rows disappear before parents; insertions run in the opposite order. Deferred scoring
      // citations permit league + scoring to be committed as one unit despite the circular reference.
      for (const t of [...tables].reverse()) {
        const next = new Set(after[t.name].map(r => rowKey(t, r)));
        for (const r of before[t.name]) if (!next.has(rowKey(t, r)))
          await client.query(`DELETE FROM ${t.name} WHERE ${t.key.map((k,i) => `${k}=$${i+1}`).join(' AND ')}`, t.key.map(k => r[k]));
      }
      for (const t of tables) {
        const prior = new Map(before[t.name].map(r => [rowKey(t, r), r]));
        for (const r of after[t.name]) {
          const old = prior.get(rowKey(t, r));
          if (old && equal(old, r)) continue;
          if (old && t.immutable) throw new Error(`Cannot rewrite an observation in ${t.name}.`);
          const changed = t.fields.filter(k => !t.key.includes(k));
          const conflict = t.immutable || !changed.length ? 'DO NOTHING' : `DO UPDATE SET ${changed.map(k => `${k}=EXCLUDED.${k}`).join(',')}`;
          await client.query(`INSERT INTO ${t.name} (${t.fields.join(',')}) VALUES (${t.fields.map((_,i) => `$${i+1}`).join(',')}) ON CONFLICT (${t.key.join(',')}) ${conflict}`,
            t.fields.map(k => t.json.includes(k) && r[k] !== null ? JSON.stringify(r[k]) : r[k]));
        }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  override async close() { await this.pool.end(); }
}
