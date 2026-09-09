import type { DefenseBreakdown, DefenseStreamerProfile } from '@sleeper/domain';

const pointsAllowedLabels: Record<string, string> = {
  '0': 'Shutout', '1_6': '1–6 points', '7_13': '7–13 points', '14_20': '14–20 points',
  '21_27': '21–27 points', '28_34': '28–34 points', '35p': '35+ points',
};
const yardsAllowedLabels: Record<string, string> = {
  '0_100': 'Under 100 yards', '100_199': '100–199 yards', '200_299': '200–299 yards', '300_349': '300–349 yards',
  '350_399': '350–399 yards', '400_449': '400–449 yards', '450_499': '450–499 yards', '500_549': '500–549 yards', '550p': '550+ yards',
};
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

function Tiers({ caption, labels, tiers }: { caption: string; labels: Record<string, string>; tiers: Array<{ bucket: string; stat: string; probability: number; rate: number; points: number }> }) {
  return <div className="table-scroll"><table>
    <caption>{caption}</caption>
    <thead><tr><th scope="col">Tier</th><th scope="col">Sleeper rule</th><th scope="col">Probability</th><th scope="col">Rate</th><th scope="col">Expected points</th></tr></thead>
    <tbody>{tiers.map(t => <tr key={t.bucket}><th scope="row">{labels[t.bucket] ?? t.bucket}</th><td><code>{t.stat}</code></td><td>{pct(t.probability)}</td><td>{t.rate}</td><td>{t.points.toFixed(2)}</td></tr>)}</tbody>
  </table></div>;
}

export function DefenseDetail({ forecast, profile, context }: { forecast?: DefenseBreakdown; profile?: DefenseStreamerProfile; context?: string }) {
  const d = forecast ?? profile?.forecast;
  if (!d) return null;
  return <div className="quarterback-detail">
    <p><strong>{context ? `${context}: ` : ''}{d.expectedPoints.toFixed(2)} expected points · {pct(d.pointsAllowed.shutoutProbability)} shutout chance · {pct(d.yardsAllowed.under100Probability)} chance of under 100 yards allowed.</strong></p>
    {d.availabilityNote && <p>{d.availabilityNote}</p>}
    <p>Pressure {d.pressurePoints.toFixed(2)} · Takeaways {d.turnoverPoints.toFixed(2)} · Defensive touchdowns {d.touchdownPoints.toFixed(2)} · Safeties and blocked kicks {d.situationalPoints.toFixed(2)} · Special teams {d.specialTeamsPoints.toFixed(2)} · Points and yards allowed {d.thresholdPoints.toFixed(2)}.</p>
    <details><summary>Team defense forecast, component scoring and threshold probabilities</summary>
      <div className="table-scroll"><table>
        <caption>Expected counts and your league’s scoring</caption>
        <thead><tr><th scope="col">Category</th><th scope="col">Sleeper rule</th><th scope="col">Expected count</th><th scope="col">Rate</th><th scope="col">Points</th></tr></thead>
        <tbody>{d.components.map(c => <tr key={c.stat}><th scope="row">{c.label}</th><td><code>{c.stat}</code></td><td>{c.amount.toFixed(2)}</td><td>{c.rate}</td><td>{c.points.toFixed(2)}</td></tr>)}</tbody>
      </table></div>
      <p>Forced fumbles and fumble recoveries are separate Sleeper events: a fumble this unit forces and recovers scores both. Defensive touchdowns score <code>def_td</code> and the unit’s return touchdowns score <code>def_st_td</code>; the individual <code>st_*</code> rules belong to a rostered returner’s own line, never to the team.</p>
      <Tiers caption="Points allowed: probability of each Sleeper tier" labels={pointsAllowedLabels} tiers={d.pointsAllowed.tiers}/>
      <Tiers caption="Yards allowed: probability of each Sleeper tier" labels={yardsAllowedLabels} tiers={d.yardsAllowed.tiers}/>
      <p>{d.pointsAllowed.explanation} {d.yardsAllowed.explanation} Threshold bonuses are weighted by probability, so a favorable matchup raises what a shutout is worth without paying the whole bonus.</p>
      {d.drivers.length > 0 && <><p>Largest drivers of this total:</p><ul>{d.drivers.map(v => <li key={v.label}><strong>{v.label} ({v.points > 0 ? '+' : ''}{v.points.toFixed(2)}): </strong>{v.explanation}</li>)}</ul></>}
      {profile && <><p>Streamer ranking adjustment: {profile.rankingAdjustment > 0 ? '+' : ''}{profile.rankingAdjustment.toFixed(2)}. These preferences change priority, not expected fantasy points.</p><ul>{profile.factors.map(f => <li key={f.label}><strong>{f.label} ({f.value > 0 ? '+' : ''}{f.value.toFixed(2)}): </strong>{f.explanation}</li>)}</ul>{profile.missingContext.length > 0 && <ul>{profile.missingContext.map(note => <li key={note}>{note}</li>)}</ul>}</>}
    </details>
  </div>;
}
