import type { OpportunityProfile } from '@sleeper/domain';

const percent = (value: number | null) => value == null ? null : `${Math.round(value * 100)}%`;
const archetypeLabels: Record<OpportunityProfile['archetype'], string> = {
  'volume-driven': 'Volume-driven', 'touchdown-dependent': 'Touchdown-dependent',
  balanced: 'Balanced', 'non-receiving': 'No receiving role',
};

/**
 * Receiving role behind a projection: the workload that produced it, and what this league's
 * reception rule is worth to it in points. None of these numbers are added to the projection — the
 * league scored the receptions once already — so they are presented as context, not as value.
 */
export function OpportunityDetail({ profile, compact = false }: { profile: OpportunityProfile | null; compact?: boolean }) {
  if (!profile) return null;
  const rows: Array<[string, string | null]> = [
    ['Targets per week', profile.targets == null ? null : String(profile.targets)],
    ['Targets per route run', profile.targetsPerRouteRun == null ? null : String(profile.targetsPerRouteRun)],
    ['Route participation', percent(profile.routeParticipation)],
    ['Share of team targets', percent(profile.targetShare)],
    ['Red-zone targets', profile.redZoneTargets == null ? null : String(profile.redZoneTargets)],
    ['Reception points', `${profile.receptionPoints}${profile.receptionShare == null ? '' : ` (${percent(profile.receptionShare)} of the total)`}`],
    ['Target stability', profile.stability == null ? null : `${profile.stability} of 1`],
    ['Recent target trend', profile.trend == null ? null : `${profile.trend > 0 ? '+' : ''}${profile.trend} per game`],
  ];
  const known = rows.filter((row): row is [string, string] => row[1] !== null);
  return <div className="opportunity-detail">
    <p className="opportunity-tags">
      <span className={`opportunity-tag archetype-${profile.archetype}`}>{archetypeLabels[profile.archetype]}</span>
      {profile.passCatchingBack && <span className="opportunity-tag pass-catching">Pass-catching back</span>}
      {profile.floorLift > 0 && <span className="opportunity-tag floor-lift">Floor lifted {Math.round(profile.floorLift * 100)}%</span>}
    </p>
    {!compact && <details className="opportunity-breakdown">
      <summary>Receiving role and what {archetypeLabels[profile.archetype].toLowerCase()} means here</summary>
      <dl>{known.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p>{profile.explanation}</p>
      {profile.receptionPoints > 0 && <p>{profile.receptionExplanation}</p>}
      <p className="opportunity-note">Opportunity is workload, not scoring. Receptions are scored once by your league; these measures explain and bound that projection rather than adding to it.</p>
    </details>}
  </div>;
}
