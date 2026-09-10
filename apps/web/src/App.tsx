import { useEffect, useState } from 'react';
import { Login } from './Login';
import { ConnectSleeper } from './ConnectSleeper';
import { Dashboard } from './dashboard/Dashboard';
import { onSessionEnded, resumeSession, signOut } from './dashboard/api';
import type { ConnectedLeague, DashboardConnection } from './dashboard/types';
import type { SleeperUser } from '@sleeper/sleeper-client';

export function App() {
  // 'checking' exists so a reload does not flash the sign-in form before the cookie has been resolved.
  const [access, setAccess] = useState<'checking' | 'signed-out' | 'signed-in'>('checking');
  const [connecting, setConnecting] = useState(false);
  const [connection, setConnection] = useState<DashboardConnection | null>(null);
  useEffect(() => {
    let live = true;
    onSessionEnded(() => { if (live) { setAccess('signed-out'); setConnection(null); setConnecting(false); } });
    void resumeSession().then(user => { if (live) setAccess(user ? 'signed-in' : 'signed-out'); });
    return () => { live = false; onSessionEnded(() => undefined); };
  }, []);
  const openLeague = (league: ConnectedLeague, user: SleeperUser, leagues: ConnectedLeague[]) => {
    setConnection({ user, leagues: [league, ...leagues.filter(item => item.league.league_id !== league.league.league_id && item.roster && !item.error)] });
    setConnecting(false);
  };
  const endSession = async () => {
    await signOut().catch(() => undefined);
    setConnection(null); setConnecting(false); setAccess('signed-out');
  };
  if (access === 'checking') return <main className="onboarding-shell"><div className="onboarding-main"><p role="status">Restoring your session…</p></div></main>;
  if (access === 'signed-out') return <Login onLogin={() => setAccess('signed-in')}/>;
  return connecting
    ? <ConnectSleeper onOpen={openLeague} onBack={() => setConnecting(false)}/>
    : <Dashboard key={connection?.leagues[0]?.league.league_id ?? 'demo'} connection={connection} onConnect={() => setConnecting(true)} onDemo={() => setConnection(null)} onSignOut={() => void endSession()}/>;
}
