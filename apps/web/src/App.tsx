import { useState } from 'react';
import { Login } from './Login';
import { ConnectSleeper } from './ConnectSleeper';
import { Dashboard } from './dashboard/Dashboard';
import type { ConnectedLeague, DashboardConnection } from './dashboard/types';
import type { SleeperUser } from '@sleeper/sleeper-client';

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connection, setConnection] = useState<DashboardConnection | null>(null);
  const openLeague = (league: ConnectedLeague, user: SleeperUser, leagues: ConnectedLeague[]) => {
    setConnection({ user, leagues: [league, ...leagues.filter(item => item.league.league_id !== league.league.league_id && item.roster && !item.error)] });
    setConnecting(false);
  };
  if (!authenticated) return <Login onLogin={() => setAuthenticated(true)}/>;
  return connecting
    ? <ConnectSleeper onOpen={openLeague} onBack={() => setConnecting(false)}/>
    : <Dashboard key={connection?.leagues[0]?.league.league_id ?? 'demo'} connection={connection} onConnect={() => setConnecting(true)} onDemo={() => setConnection(null)}/>;
}
