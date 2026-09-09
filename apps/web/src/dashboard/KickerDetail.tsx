import type { KickerBreakdown, KickerStreamerProfile } from '@sleeper/domain';

const labels = { '0_19': '0–19 yards', '20_29': '20–29 yards', '30_39': '30–39 yards', '40_49': '40–49 yards', '50_59': '50–59 yards', '60p': '60+ yards' };
export function KickerDetail({ forecast, profile, context }: { forecast?: KickerBreakdown; profile?: KickerStreamerProfile; context?: string }) {
  const k = forecast ?? profile?.forecast;
  if (!k) return null;
  return <div className="quarterback-detail">
    <p><strong>{context ? `${context}: ` : ''}{k.expectedPoints.toFixed(2)} expected points · Miss downside {k.missDownside.toFixed(2)} pts already deducted.</strong></p>
    {k.availabilityNote && <p>{k.availabilityNote}</p>}
    <p>{k.expectedAttempts.toFixed(2)} expected FG attempts · {k.accuracy === null ? 'Accuracy unknown' : `${(k.accuracy * 100).toFixed(1)}% expected accuracy`} · {(k.longAttemptProbability * 100).toFixed(1)}% chance of a 50+ yard attempt.</p>
    <details><summary>Kicker distance forecast and miss downside</summary>
      <div className="table-scroll"><table>
        <caption>Expected counts and your league’s scoring</caption>
        <thead><tr><th scope="col">Distance</th><th scope="col">Attempts</th><th scope="col">Makes</th><th scope="col">Misses</th><th scope="col">Make points</th><th scope="col">Miss points</th></tr></thead>
        <tbody>{k.distances.map(d => <tr key={d.band}><th scope="row">{labels[d.band]}</th><td>{d.attempts.toFixed(2)}</td><td>{d.makes.toFixed(2)}</td><td>{d.misses.toFixed(2)}</td><td>{d.makePoints.toFixed(2)}</td><td>{d.missPoints.toFixed(2)}</td></tr>)}
          <tr><th scope="row">PAT</th><td>{(k.patMakes + k.patMisses).toFixed(2)}</td><td>{k.patMakes.toFixed(2)}</td><td>{k.patMisses.toFixed(2)}</td><td>{(k.patPoints - k.patMissPoints).toFixed(2)}</td><td>{k.patMissPoints.toFixed(2)}</td></tr>
        </tbody>
      </table></div>
      <p>Miss downside is the expected deduction, not a worst-case floor. Field-goal misses include blocked kicks. Aggregate and distance-specific league rules each apply once. Made-kick yardage and other custom contributions, when configured, appear in the full scoring breakdown.</p>
      {profile && <><p>Streamer ranking adjustment: {profile.rankingAdjustment > 0 ? '+' : ''}{profile.rankingAdjustment.toFixed(2)}. These preferences change priority, not expected fantasy points.</p><ul>{profile.factors.map(f => <li key={f.label}><strong>{f.label} ({f.value > 0 ? '+' : ''}{f.value.toFixed(2)}): </strong>{f.explanation}</li>)}</ul>{profile.missingContext.length > 0 && <ul>{profile.missingContext.map(note => <li key={note}>{note}</li>)}</ul>}</>}
    </details>
  </div>;
}
