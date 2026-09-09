import { referenceScoring } from '@sleeper/domain';
import { checklistFor, syncAlert } from './model';
import type { DashboardAlert, DashboardData, DashboardPlayer, ProposedAction, StartDecision, WaiverTarget } from './types';

// A self-contained, deliberately fictional scenario. Never mixed with a connected league.
export function createDemo(): DashboardData {
  const player = (id: string, name: string, position: string, team: string, illustrativePoints: number): DashboardPlayer => ({ id, name, position, team, illustrativePoints });
  const reed = player('sample-1', 'Marcus Reed', 'WR', 'SEA', 15.8);
  const cole = player('sample-2', 'Jordan Cole', 'WR', 'DEN', 11.2);
  const brooks = player('sample-3', 'Devin Brooks', 'RB', 'ATL', 14.6);
  const mills = player('sample-4', 'Aaron Mills', 'RB', 'CHI', 10.9);
  const weakest = player('sample-5', 'Evan Price', 'RB', 'NYJ', 5.7);
  const action = (id: string, kind: ProposedAction['kind'], title: string, reason: string, confidence?: number): ProposedAction => ({ id, kind, title, reason, confidence, checklist: checklistFor(kind), caution: 'This scenario uses fictional players and illustrative estimates. Check current information in your own league.' });
  const starts: StartDecision[] = [
    { ...action('start-reed', 'start', 'Start Marcus Reed over Jordan Cole', 'Reed’s larger expected target share gives him more chances to score. Cole’s role is less certain this week.', 84), start: reed, sit: cole, slot: 'WR2', advantage: 4.6 },
    { ...action('start-brooks', 'start', 'Start Devin Brooks over Aaron Mills', 'Brooks is expected to handle more carries near the goal line. Mills shares touches and has a lower projected workload.', 76), start: brooks, sit: mills, slot: 'FLEX', advantage: 3.7 },
  ];
  const alert = (id: string, kind: DashboardAlert['kind'], title: string, detail: string): DashboardAlert => ({ id, kind, title, detail, action: action(id, 'start', title, detail) });
  const waivers: WaiverTarget[] = [
    { ...action('waiver-hayes', 'waiver', 'Consider adding Chris Hayes', 'Your RB depth is thin. Hayes has the clearest expected workload among available backs and projects 6.4 points above Evan Price this week.', 79), player: player('sample-6', 'Chris Hayes', 'RB', 'HOU', 12.1), drop: weakest, fit: 94, fitLabel: 'Strong fit', advantage: 6.4 },
    { ...action('waiver-bell', 'waiver', 'Consider adding Darius Bell', 'Bell adds receiving depth for upcoming byes. Compare his weekly role with the value of keeping your last bench running back.', 72), player: player('sample-7', 'Darius Bell', 'WR', 'GB', 11.0), drop: weakest, fit: 87, fitLabel: 'Strong fit', advantage: 5.3 },
    { ...action('waiver-walker', 'waiver', 'Consider adding Noah Walker', 'Walker is a possible tight-end backup, but that roster spot could be more useful for running-back coverage.', 65), player: player('sample-8', 'Noah Walker', 'TE', 'ARI', 9.2), drop: weakest, fit: 73, fitLabel: 'Useful depth', advantage: 3.5 },
  ];
  return {
    scoring: referenceScoring(), demo: true, week: 8, teamName: 'Fourth & Fabulous', format: '12 teams · PPR · Redraft', lastSyncedAt: null,
    alerts: [
      alert('inactive', 'inactive', 'Tyler Grant is out', 'Your starting WR is unavailable in this scenario. Review an eligible replacement.'),
      alert('bye', 'bye', 'Sam Ellis has a bye', 'Your starting TE has no game in Week 8. Check your bench or the waiver wire.'),
      alert('injury', 'injury', 'Aaron Mills is questionable', 'His role may be limited. Keep a backup ready and check the final status.'),
      alert('empty', 'empty', 'Your K slot is empty', 'An open starting slot leaves points on the table. Review available kickers.'),
      syncAlert('Sample sync failure: the latest refresh did not complete. Verify freshness before using recommendations.'),
    ], starts, waivers,
    trades: [action('trade-depth', 'trade', 'Turn receiver depth into RB cover', 'Red Zone Rebels have extra running backs and need a WR. Consider Jordan Cole for their backup RB, Miles Carter, after comparing roles and rest-of-season value.', 68)],
    needs: [{ position: 'QB', status: 'Covered', tone: 'good' }, { position: 'RB', status: 'Needs depth', tone: 'warning' }, { position: 'WR', status: 'Surplus', tone: 'good' }, { position: 'TE', status: 'Bye cover', tone: 'warning' }],
    matchup: { opponent: 'Gridiron Guild', illustrativeFor: 126.8, illustrativeAgainst: 119.4, winChance: 58, paths: ['The two start/sit changes offer a combined 8.3 projected points if both remain eligible.', 'Fill the empty kicker slot and replace the bye-week starter before their games lock.'], risks: ['A limited workload for Mills could reduce your running-back scoring.', 'Your opponent’s receivers have a wide scoring range. A 7.4-point projected lead is far from secure.'] },
    standings: [
      { id: '1', name: 'Red Zone Rebels', wins: 6, losses: 1, ties: 0, points: 971.4, isUser: false },
      { id: '2', name: 'The Sunday Club', wins: 5, losses: 2, ties: 0, points: 945.8, isUser: false },
      { id: '3', name: 'Fourth & Fabulous', wins: 5, losses: 2, ties: 0, points: 923.6, isUser: true },
      { id: '4', name: 'Gridiron Guild', wins: 4, losses: 3, ties: 0, points: 889.1, isUser: false },
      ...['End Zone Society', 'Sunday Scaries', 'The Goal Line', 'Bench Mob', 'No Punt Intended', 'First Down Crew', 'Overtime', 'Waiver Wonders'].map((name, i) => ({ id: String(i + 5), name, wins: Math.max(0, 4 - Math.floor(i / 2)), losses: 7 - Math.max(0, 4 - Math.floor(i / 2)), ties: 0, points: 870 - i * 18.2, isUser: false })),
    ],
    activity: [
      { id: 'a1', type: 'waiver', title: 'Red Zone Rebels added Miles Carter', detail: 'Dropped Ben Ross · $12 waiver bid', time: '2 hours ago' },
      { id: 'a2', type: 'trade', title: 'The Sunday Club ↔ Bench Mob', detail: 'Alex King traded for James Ford', time: '5 hours ago' },
      { id: 'a3', type: 'free_agent', title: 'Gridiron Guild added Luke Davis', detail: 'Dropped Owen Scott · Free agent pickup', time: 'Yesterday' },
    ], playoffChance: 74, playoffSpots: 6,
    playoffNote: 'At 5–2, you’re inside the six-team playoff field. Another win adds breathing room; a loss keeps the chasing teams close. The percentage is illustrative, not a calculated forecast.',
  };
}
