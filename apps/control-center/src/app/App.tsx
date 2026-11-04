import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiClient } from '../core/api/apiClient';
import type { AuthConfig } from '../core/auth/oidc';
import { Shell } from './Shell';
import { SignIn } from './SignIn';

export interface Identity {
  readonly subject: string;
  readonly roles: readonly string[];
  readonly mode: string;
}

export function App() {
  const queryClient = useQueryClient();
  const [auth, setAuth] = useState<AuthConfig | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [health, setHealth] = useState<'checking' | 'online' | 'offline'>('checking');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    async function initialize(): Promise<void> {
      try {
        const response = await fetch('/api/v1/auth/config', { cache: 'no-store' });
        if (!response.ok) throw new Error('The core is unavailable.');
        const config = (await response.json()) as AuthConfig;
        if (!active) return;
        setAuth(config);
        setHealth('online');
        if (
          config.mode === 'oidc' &&
          (await (await import('../core/auth/oidc')).initialize(config))
        ) {
          const user = await apiClient.identity();
          if (active) setIdentity(user);
        }
      } catch (cause) {
        if (active) {
          setHealth('offline');
          setError(cause instanceof Error ? cause.message : 'Sign-in failed.');
        }
      }
    }
    void initialize();
    return () => {
      active = false;
    };
  }, []);

  async function connect(apiKey: string): Promise<void> {
    setError('');
    if (apiKey.trim().length < 32) {
      setError('The development API key must contain at least 32 characters.');
      return;
    }
    apiClient.setApiKey(apiKey);
    try {
      await Promise.all([apiClient.listBodies(), apiClient.listMissions()]);
      setIdentity(await apiClient.identity());
    } catch (cause) {
      apiClient.clearApiKey();
      setError(cause instanceof Error ? cause.message : 'The core did not accept the key.');
    }
  }

  function signIn(): void {
    void import('../core/auth/oidc')
      .then((m) => m.signIn())
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Sign-in failed.'));
  }

  function signOut(): void {
    apiClient.clearApiKey();
    setIdentity(null);
    // Nothing fetched for this operator outlives the session.
    queryClient.clear();
    if (auth?.mode === 'oidc')
      void import('../core/auth/oidc').then((m) => m.signOut()).catch(() => location.reload());
  }

  if (auth === null || identity === null)
    return (
      <SignIn
        mode={auth?.mode ?? null}
        health={health}
        error={error}
        onConnect={connect}
        onSignIn={signIn}
      />
    );
  return (
    <Shell
      mode={auth.mode}
      durable={auth.durable === true}
      identity={identity}
      onSignOut={signOut}
    />
  );
}
