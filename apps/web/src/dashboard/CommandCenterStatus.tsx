import type { CommandCenterResponse } from '@sleeper/domain';

export function CommandCenterStatus({ command }: { command: CommandCenterResponse }) {
  return <div className="surface" aria-label="Command center readiness">
    <p>Scoring snapshot: {command.provenance.scoringSnapshotId ?? 'Unavailable'} · Forecast: {command.provenance.forecastUpdatedAt ?? 'Unavailable'}</p>
    <ul>{Object.entries(command.sections).map(([name, section]) => <li key={name}><strong>{name}: {section.state}</strong>{section.warnings.length > 0 && <details><summary>{name} warnings</summary><ul>{section.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}</li>)}</ul>
    <details><summary>Data-source freshness</summary><ul>{command.sections.freshness.data?.map(source => <li key={source.source}>{source.source}: {source.state} · {source.updatedAt ?? 'Unknown'}</li>)}</ul></details>
  </div>;
}
