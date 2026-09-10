import { useEffect, useState } from 'react';
import { Login } from './Login';
import { ConnectSleeper } from './ConnectSleeper';
import { Dashboard } from './dashboard/Dashboard';
import { clearCsrfToken, post, request, setCsrfToken } from './dashboard/api';
import type { ConnectedLeague, DashboardConnection } from './dashboard/types';
import type { SleeperUser } from '@sleeper/sleeper-client';

export function App() {
  const [authentication, setAuthentication] = useState<'loading' | 'authenticated' | 'anonymous'>('loading');
  const [connecting, setConnecting] = useState(false);
  const [connection, setConnection] = useState<DashboardConnection | null>(null);
  useEffect(() => { request<{ csrfToken: string }>('/auth/session').then(result => { setCsrfToken(result.csrfToken); setAuthentication('authenticated'); }).catch(() => setAuthentication('anonymous')); }, []);
  const openLeague = (league: ConnectedLeague, user: SleeperUser, leagues: ConnectedLeague[]) => {
    setConnection({ user, leagues: [league, ...leagues.filter(item => item.league.league_id !== league.league.league_id && item.roster && !item.error)] });
    setConnecting(false);
  };
  const logout = async () => { try { await post('/auth/logout', {}); } finally { clearCsrfToken(); setConnection(null); setAuthentication('anonymous'); } };
  if (authentication === 'loading') return <main className="onboarding-shell"><p role="status">Checking your session…</p></main>;
  if (authentication === 'anonymous') return <Login onLogin={() => setAuthentication('authenticated')}/>;
  return connecting
    ? <ConnectSleeper onOpen={openLeague} onBack={() => setConnecting(false)}/>
    : <Dashboard key={connection?.leagues[0]?.league.league_id ?? 'demo'} connection={connection} onConnect={() => setConnecting(true)} onDemo={() => setConnection(null)} onLogout={() => void logout()}/>;
}
