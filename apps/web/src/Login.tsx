import { type FormEvent, useState } from 'react';
import { post, setCsrfToken } from './dashboard/api';

interface LoginResult { csrfToken: string; expiresAt: string; }
const demoEnabled = ((import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_ENABLE_DEMO_AUTH === 'true');

export function Login({ onLogin }: { onLogin: () => void }) {
  const [login, setLogin] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const authenticate = async (path: '/auth/login' | '/auth/demo', body: unknown) => {
    setBusy(true); setError('');
    try { const result = await post<LoginResult>(path, body); setCsrfToken(result.csrfToken); onLogin(); }
    catch (value) { setError(value instanceof Error ? value.message : 'Login failed.'); }
    finally { setBusy(false); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void authenticate('/auth/login', { login, password }); };
  return <main className="onboarding-shell"><div className="onboarding-main"><div className="intro"><p className="kicker">Private access</p><h1>Sign in to Huddle.</h1><p>Your Sleeper username is linked only after application authentication.</p></div><form className="connect-card panel" onSubmit={submit}><label htmlFor="login">Login</label><input id="login" autoComplete="username" value={login} onChange={event => setLogin(event.target.value)}/><label htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)}/><button disabled={busy || !login || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>{demoEnabled && <button type="button" disabled={busy} onClick={() => void authenticate('/auth/demo', {})}>Development demo</button>}{error && <p role="alert">{error}</p>}</form></div></main>;
}
