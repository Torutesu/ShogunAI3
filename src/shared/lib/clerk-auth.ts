import { ShogunIpcClient } from '@/shared/ipc/ipc-client';

function hasTauriInvoke() {
  return Boolean((window as any).__TAURI__ && (window as any).__TAURI__.core && typeof (window as any).__TAURI__.core.invoke === 'function');
}

let clerkLoaded = false;

async function getConfig() {
  if (!ShogunIpcClient || !ShogunIpcClient.createIpcClient) {
    return { enabled: false };
  }
  const ipc = ShogunIpcClient.createIpcClient();
  const res = await ipc.invoke('auth_clerk_config', {});
  if (!res.ok) return { enabled: false };
  return res.data || { enabled: false };
}

function loadScript(src: any, publishableKey: any) {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.src = src;
    if (publishableKey) s.setAttribute('data-clerk-publishable-key', publishableKey);
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Clerk script'));
    document.head.appendChild(s);
  });
}

let sessionListenerAttached = false;

function attachClerkSessionListener() {
  if (sessionListenerAttached || !(window as any).Clerk || typeof (window as any).Clerk.addListener !== 'function') {
    return;
  }
  (window as any).Clerk.addListener(
    (resources: any) => {
      try {
        if (resources && resources.user) {
          void persistSnapshotFromClerk();
          window.dispatchEvent(new CustomEvent('shogun-clerk-auth-changed'));
        }
      } catch (e) {
        console.warn('[ShogunClerkAuth] addListener', e);
      }
    },
    { skipInitialEmit: true },
  );
  sessionListenerAttached = true;
}

async function ensureClerk(config: any) {
  if (clerkLoaded && (window as any).Clerk) {
    attachClerkSessionListener();
    return;
  }
  if (!config || !config.clerkJsUrl || !config.publishableKey) {
    throw new Error('Clerk is not configured');
  }
  await loadScript(config.clerkJsUrl, config.publishableKey);
  if (!(window as any).Clerk || typeof (window as any).Clerk.load !== 'function') {
    throw new Error('Clerk global missing after load');
  }
  await (window as any).Clerk.load({ publishableKey: config.publishableKey });
  clerkLoaded = true;
  attachClerkSessionListener();
}

async function persistSnapshotFromClerk() {
  if (!ShogunIpcClient) return;
  const ipc = ShogunIpcClient.createIpcClient();
  const u = (window as any).Clerk && (window as any).Clerk.user;
  if (!u) return;
  await ipc.invoke('auth_session_save', {
    clerkUserId: u.id,
    primaryEmail: u.primaryEmailAddress ? u.primaryEmailAddress.emailAddress : null,
    displayName: u.fullName || u.username || null,
    imageUrl: u.imageUrl || null,
  });
}

async function handleDeepLinkUrls(urls: any) {
  const list = Array.isArray(urls) ? urls : urls != null ? [urls] : [];
  for (const raw of list) {
    const url = typeof raw === 'string' ? raw : raw != null ? String(raw) : '';
    if (!url || url.indexOf('shogun-ai://clerk-callback') !== 0) continue;
    const config = await getConfig();
    if (!config.enabled) continue;
    try {
      await ensureClerk(config);
    } catch (e) {
      console.warn('[ShogunClerkAuth] ensureClerk', e);
      continue;
    }
    const path = window.location.pathname || '/';
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    const qs = parsed.search || '';
    const h = parsed.hash || '';
    window.history.replaceState(null, '', path + qs + h);
    try {
      if (typeof (window as any).Clerk.handleRedirectCallback === 'function') {
        await (window as any).Clerk.handleRedirectCallback({});
      }
    } catch (e) {
      console.warn('[ShogunClerkAuth] handleRedirectCallback', e);
    } finally {
      window.history.replaceState(null, '', path);
    }
    await persistSnapshotFromClerk();
    window.dispatchEvent(new CustomEvent('shogun-clerk-auth-changed'));
  }
}

async function registerDeepLink() {
  if (!hasTauriInvoke()) return;
  try {
    const mod: any = await import('https://cdn.jsdelivr.net/npm/@tauri-apps/plugin-deep-link@2.4.7/+esm' as any);
    if (typeof mod.onOpenUrl === 'function') {
      await mod.onOpenUrl(handleDeepLinkUrls);
    }
  } catch (e) {
    console.warn('[ShogunClerkAuth] deep-link', e);
  }
}

async function init() {
  (window as any).__SHOGUN_CLERK__ = { ready: false, enabled: false };
  if (!hasTauriInvoke()) return;
  const config = await getConfig();
  (window as any).__SHOGUN_CLERK__.enabled = !!config.enabled;
  if (!config.enabled) return;
  await registerDeepLink();
  try {
    await ensureClerk(config);
    (window as any).__SHOGUN_CLERK__.ready = true;
    if ((window as any).Clerk && (window as any).Clerk.session) {
      await persistSnapshotFromClerk();
    }
  } catch (e) {
    console.warn('[ShogunClerkAuth] init', e);
  }
}

async function openSignInBrowser() {
  const ipc = ShogunIpcClient.createIpcClient();
  return ipc.invoke('auth_open_browser_sign_in', {});
}

async function openSignUpBrowser() {
  const ipc = ShogunIpcClient.createIpcClient();
  return ipc.invoke('auth_open_browser_sign_up', {});
}

/** In-app Clerk modal (same WebView). Uses Clerk free-tier methods (email, OAuth, etc.). Falls back to system browser on error. */
async function openSignIn() {
  try {
    const config = await getConfig();
    if (!config.enabled) {
      return { ok: false, error: { message: 'Clerk is not configured' } };
    }
    await ensureClerk(config);
    if (!(window as any).Clerk || typeof (window as any).Clerk.openSignIn !== 'function') {
      throw new Error('Clerk.openSignIn is not available');
    }
    const returnUrl = window.location.href.split('#')[0];
    await Promise.resolve(
      (window as any).Clerk.openSignIn({
        fallbackRedirectUrl: returnUrl,
      }),
    );
    return { ok: true, data: { embedded: true } };
  } catch (e) {
    console.warn('[ShogunClerkAuth] embedded sign-in failed, using browser', e);
    if (ShogunIpcClient && hasTauriInvoke()) {
      return openSignInBrowser();
    }
    return { ok: false, error: { message: (e as any).message || 'Sign-in failed' } };
  }
}

async function openSignUp() {
  try {
    const config = await getConfig();
    if (!config.enabled) {
      return { ok: false, error: { message: 'Clerk is not configured' } };
    }
    await ensureClerk(config);
    if (!(window as any).Clerk || typeof (window as any).Clerk.openSignUp !== 'function') {
      throw new Error('Clerk.openSignUp is not available');
    }
    const returnUrl = window.location.href.split('#')[0];
    await Promise.resolve(
      (window as any).Clerk.openSignUp({
        fallbackRedirectUrl: returnUrl,
      }),
    );
    return { ok: true, data: { embedded: true } };
  } catch (e) {
    console.warn('[ShogunClerkAuth] embedded sign-up failed, using browser', e);
    if (ShogunIpcClient && hasTauriInvoke()) {
      return openSignUpBrowser();
    }
    return { ok: false, error: { message: (e as any).message || 'Sign-up failed' } };
  }
}

async function signOut() {
  if ((window as any).Clerk && typeof (window as any).Clerk.signOut === 'function') {
    await (window as any).Clerk.signOut();
  }
  let out: any = { ok: true, data: { signedOut: true } };
  if (ShogunIpcClient) {
    const ipc = ShogunIpcClient.createIpcClient();
    out = await ipc.invoke('auth_sign_out', {});
  }
  window.dispatchEvent(new CustomEvent('shogun-clerk-auth-changed'));
  return out;
}

function getClerkUser() {
  return (window as any).Clerk && (window as any).Clerk.user ? (window as any).Clerk.user : null;
}

function isSignedIn() {
  return Boolean((window as any).Clerk && (window as any).Clerk.session);
}

export const ShogunClerkAuth = {
  init: init,
  openSignIn: openSignIn,
  openSignUp: openSignUp,
  openSignInBrowser: openSignInBrowser,
  openSignUpBrowser: openSignUpBrowser,
  signOut: signOut,
  getClerkUser: getClerkUser,
  isSignedIn: isSignedIn,
  getConfig: getConfig,
};

