import { InMemoryWebStorage, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { apiClient } from '../api/apiClient';
export interface AuthConfig {
  mode: 'development' | 'oidc';
  durable?: boolean;
  issuer?: string;
  client_id?: string;
  audience?: string;
}
let manager: UserManager | null = null;
export async function initialize(config: AuthConfig): Promise<boolean> {
  if (config.mode !== 'oidc' || !config.issuer || !config.client_id) return false;
  manager = new UserManager({
    authority: config.issuer,
    client_id: config.client_id,
    redirect_uri: `${location.origin}${import.meta.env.BASE_URL}operator.html`,
    post_logout_redirect_uri: `${location.origin}${import.meta.env.BASE_URL}operator.html`,
    response_type: 'code',
    response_mode: 'fragment',
    scope: 'openid profile',
    automaticSilentRenew: true,
    monitorSession: false,
    loadUserInfo: false,
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    stateStore: new WebStorageStateStore({ store: sessionStorage }),
  });
  manager.events.addUserLoaded((user) => apiClient.setAccessToken(user.access_token));
  manager.events.addAccessTokenExpired(() => {
    apiClient.clearApiKey();
    location.reload();
  });
  manager.events.addSilentRenewError(() => {
    apiClient.clearApiKey();
    location.reload();
  });
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has('state') && (fragment.has('code') || fragment.has('error'))) {
    const callback = location.href;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    const user = await manager.signinRedirectCallback(callback);
    apiClient.setAccessToken(user.access_token);
    return true;
  }
  return false;
}
export async function signIn(): Promise<void> {
  if (!manager) throw new Error('Sign-in is not configured.');
  await manager.signinRedirect();
}
export async function signOut(): Promise<void> {
  apiClient.clearApiKey();
  if (manager) await manager.signoutRedirect();
}
