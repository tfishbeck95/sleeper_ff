/** Expected screenshot values only. Never use this partial reference to score a league. */
export const EXPECTED_SCORING = Object.freeze({
  pass_yd: .04, pass_td: 4, pass_2pt: 2, pass_int: -2,
  rush_yd: .1, rush_td: 6, rush_2pt: 2,
  rec: 1, rec_yd: .1, rec_td: 6, rec_2pt: 2,
  xpm: 1, fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50_59: 5, fgm_60p: 6, xpmiss: -1, fgmiss: -1,
  int: 2, fum_rec: 1, ff: 1, safe: 2, blk_kick: 2, def_td: 6, sack: 1, pts_allow_0: 8, yds_allow_0_100: 3,
  def_st_td: 6, def_st_ff: 1, def_st_fum_rec: 1,
  st_td: 6, st_ff: 1, st_fum_rec: 2,
  fum_lost: -2, fum_rec_td: 6,
});
export interface ScoringIssue {
  kind: 'missing' | 'unexpected' | 'mismatched' | 'invalid' | 'load';
  key: string; expected?: number; actual?: unknown; message: string;
}
interface ScoringObservation {
  synchronizedAt: string | null;
  lastAttemptedAt?: string;
  issues: ScoringIssue[];
  /** Exact upstream representation, including unrecognized keys or invalid values. */
  rawSettings: unknown;
}
export type ScoringConfiguration = ScoringObservation & (
  | { kind: 'complete-live'; settings: Readonly<Record<string, number>> }
  | { kind: 'partial-reference'; settings: Readonly<Record<string, number>> }
  | { kind: 'unavailable'; settings: null }
);
export const scoringUnavailable = (message = 'Live scoring settings have not been synchronized.', at: string | null = null): ScoringConfiguration => ({
  kind: 'unavailable', settings: null, rawSettings: null, synchronizedAt: at,
  issues: [{ kind: 'load', key: 'scoring_settings', message }],
});
export function referenceScoring(settings: Readonly<Record<string, number>> = EXPECTED_SCORING): ScoringConfiguration {
  return { kind: 'partial-reference', settings: { ...settings }, rawSettings: null, synchronizedAt: null, issues: [] };
}
/** Only a complete response from the selected league endpoint belongs here. Extras are informational. */
export function liveScoring(raw: unknown, synchronizedAt: string): ScoringConfiguration {
  const issues: ScoringIssue[] = [];
  const object = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
  const settings = object ? raw as Record<string, unknown> : {};
  if (!object || !Object.keys(settings).length) issues.push({ kind: 'invalid', key: 'scoring_settings', message: 'Live scoring_settings must be a nonempty numeric object.' });
  if (!Number.isFinite(Date.parse(synchronizedAt))) issues.push({ kind: 'invalid', key: 'synchronizedAt', message: 'Scoring synchronization timestamp is invalid.' });
  for (const [key, actual] of Object.entries(settings)) {
    if (typeof actual !== 'number' || !Number.isFinite(actual)) issues.push({ kind: 'invalid', key, actual, message: `${key}: expected a finite number.` });
    else if (!Object.hasOwn(EXPECTED_SCORING, key)) issues.push({ kind: 'unexpected', key, actual, message: `${key}: additional Sleeper rule (${actual}), not shown in the reference; preserved.` });
  }
  for (const [key, expected] of Object.entries(EXPECTED_SCORING)) {
    if (!Object.hasOwn(settings, key)) issues.push({ kind: 'missing', key, expected, message: `${key}: missing from Sleeper; documented ${expected}.` });
    else if (settings[key] !== expected) issues.push({ kind: 'mismatched', key, expected, actual: settings[key], message: `${key}: documented ${expected}, Sleeper ${String(settings[key])}.` });
  }
  const valid = issues.every(issue => issue.kind === 'unexpected');
  const observation = { rawSettings: raw ?? null, synchronizedAt, issues };
  return valid
    ? { ...observation, kind: 'complete-live', settings: { ...settings } as Record<string, number> }
    : { ...observation, kind: 'unavailable', settings: null };
}
export function scoringSummary(config: ScoringConfiguration): string {
  if (config.kind === 'unavailable') return 'Scoring unavailable · lineup, waiver and trade rankings disabled';
  const s = config.settings;
  const rec = s.rec === 1 ? 'PPR' : s.rec === .5 ? 'Half PPR' : s.rec === 0 ? 'Non-PPR' : s.rec == null ? 'Reception scoring unknown' : `${s.rec} per reception`;
  return `${config.kind === 'partial-reference' ? 'Partial reference · ' : ''}${rec} · Pass TD ${s.pass_td ?? '?'} · Rush/rec TD ${s.rush_td ?? '?'}/${s.rec_td ?? '?'} · ${Object.keys(s).length} rules`;
}
/** Reception-format label used wherever a league-scored total is explained to a manager. */
export function scoringFormatLabel(config: ScoringConfiguration): string {
  if (config.kind === 'unavailable') return 'unscored';
  const rec = config.settings.rec;
  return rec == null ? 'custom' : rec === 1 ? 'full-PPR' : rec === .5 ? 'half-PPR' : rec === 0 ? 'non-PPR' : `${rec}-point-reception`;
}
/**
 * Stable identifier for one scoring observation. Every scored projection carries it, so a ranking can
 * prove which snapshot produced its points and a commissioner's change invalidates earlier scoring.
 */
export function scoringSnapshotId(config: ScoringConfiguration): string {
  const rules = config.settings ? Object.keys(config.settings).sort().map(key => `${key}=${config.settings![key]}`).join('|') : '';
  const material = `${config.kind} ${config.synchronizedAt ?? ''} ${rules}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < material.length; index++) { hash ^= material.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `${config.kind}:${config.synchronizedAt ?? 'unsynchronized'}:${hash.toString(16).padStart(8, '0')}`;
}
