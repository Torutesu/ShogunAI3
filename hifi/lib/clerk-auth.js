/* global window */
(function initClerkAuth(global) {
  function hasTauriInvoke() {
    return Boolean(global.__TAURI__ && global.__TAURI__.core && typeof global.__TAURI__.core.invoke === 'function');
  }

  let clerkLoaded = false;

  async function getConfig() {
    if (!global.ShogunIpcClient || !global.ShogunIpcClient.createIpcClient) {
      return { enabled: false };
    }
    const ipc = global.ShogunIpcClient.createIpcClient();
    const res = await ipc.invoke('auth_clerk_config', {});
    if (!res.ok) return { enabled: false };
    return res.data || { enabled: false };
  }

  function loadScript(src, publishableKey) {
    return new Promise((resolve, reject) => {
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
    if (sessionListenerAttached || !global.Clerk || typeof global.Clerk.addListener !== 'function') {
      return;
    }
    global.Clerk.addListener(
      (resources) => {
        try {
          if (resources && resources.user) {
            void persistSnapshotFromClerk();
            global.dispatchEvent(new CustomEvent('shogun-clerk-auth-changed'));
          }
        } catch (e) {
          console.warn('[ShogunClerkAuth] addListener', e);
        }
      },
      { skipInitialEmit: true },
    );
    sessionListenerAttached = true;
  }

  async function ensureClerk(config) {
    if (clerkLoaded && global.Clerk) {
      attachClerkSessionListener();
      return;
    }
    if (!config || !config.clerkJsUrl || !config.publishableKey) {
      throw new Error('Clerk is not configured');
    }
    await loadScript(config.clerkJsUrl, config.publishableKey);
    if (!global.Clerk || typeof global.Clerk.load !== 'function') {
      throw new Error('Clerk global missing after load');
    }
    await global.Clerk.load({ publishableKey: config.publishableKey });
    clerkLoaded = true;
    attachClerkSessionListener();
  }

  async function persistSnapshotFromClerk() {
    if (!global.ShogunIpcClient) return;
    const ipc = global.ShogunIpcClient.createIpcClient();
    const u = global.Clerk && global.Clerk.user;
    if (!u) return;
    await ipc.invoke('auth_session_save', {
      clerkUserId: u.id,
      primaryEmail: u.primaryEmailAddress ? u.primaryEmailAddress.emailAddress : null,
      displayName: u.fullName || u.username || null,
      imageUrl: u.imageUrl || null,
    });
  }

  async function handleDeepLinkUrls(urls) {
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
      const path = global.location.pathname || '/';
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        continue;
      }
      const qs = parsed.search || '';
      const h = parsed.hash || '';
      global.history.replaceState(null, '', path + qs + h);
      try {
        if (typeof global.Clerk.handleRedirectCallback === 'function') {
          await global.Clerk.handleRedirectCallback({});
        }
      } catch (e) {
        console.warn('[ShogunClerkAuth] handleRedirectCallback', e);
      } finally {
        global.history.replaceState(null, '', path);
      }
      await persistSnapshotFromClerk();
      global.dispatchEvent(new CustomEvent('shogun-clerk-auth-changed'));
    }
  }

  async function registerDeepLink() {
    if (!hasTauriInvoke()) return;
    try {
      const mod = await import('https://cdn.jsdelivr.net/npm/@tauri-apps/plugin-deep-link@2.4.7/+esm');
      if (typeof mod.onOpenUrl === 'function') {
        await mod.onOpenUrl(handleDeepLinkUrls);
      }
    } catch (e) {
      console.warn('[ShogunClerkAuth] deep-link', e);
    }
  }

  async function init() {
    global.__SHOGUN_CLERK__ = { ready: false, enabled: false };
    if (!hasTauriInvoke()) return;
    const config = await getConfig();
    global.__SHOGUN_CLERK__.enabled = !!config.enabled;
    if (!config.enabled) return;
    await registerDeepLink();
    try {
      await ensureClerk(config);
      global.__SHOGUN_CLERK__.ready = true;
      if (global.Clerk && global.Clerk.session) {
        await persistSnapshotFromClerk();
      }
    } catch (e) {
      console.warn('[ShogunClerkAuth] init', e);
    }
  }

  async function openSignInBrowser() {
    const ipc = global.ShogunIpcClient.createIpcClient();
    return ipc.invoke('auth_open_browser_sign_in', {});
  }

  async function openSignUpBrowser() {
    const ipc = global.ShogunIpcClient.createIpcClient();
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
      if (!global.Clerk || typeof global.Clerk.openSignIn !== 'function') {
        throw new Error('Clerk.openSignIn is not available');
      }
      const returnUrl = global.location.href.split('#')[0];
      await Promise.resolve(
        global.Clerk.openSignIn({
          fallbackRedirectUrl: returnUrl,
        }),
      );
      return { ok: true, data: { embedded: true } };
    } catch (e) {
      console.warn('[ShogunClerkAuth] embedded sign-in failed, using browser', e);
      if (global.ShogunIpcClient && hasTauriInvoke()) {
        return openSignInBrowser();
      }
      return { ok: false, error: { message: e.message || 'Sign-in failed' } };
    }
  }

  async function openSignUp() {
    try {
      const config = await getConfig();
      if (!config.enabled) {
        return { ok: false, error: { message: 'Clerk is not configured' } };
      }
      await ensureClerk(config);
      if (!global.Clerk || typeof global.Clerk.openSignUp !== 'function') {
        throw new Error('Clerk.openSignUp is not available');
      }
      const returnUrl = global.location.href.split('#')[0];
      await Promise.resolve(
        global.Clerk.openSignUp({
          fallbackRedirectUrl: returnUrl,
        }),
      );
      return { ok: true, data: { embedded: true } };
    } catch (e) {
      console.warn('[ShogunClerkAuth] embedded sign-up failed, using browser', e);
      if (global.ShogunIpcClient && hasTauriInvoke()) {
        return openSignUpBrowser();
      }
      return { ok: false, error: { message: e.message || 'Sign-up failed' } };
    }
  }

  async function signOut() {
    if (global.Clerk && typeof global.Clerk.signOut === 'function') {
      await global.Clerk.signOut();
    }
    let out = { ok: true, data: { signedOut: true } };
    if (global.ShogunIpcClient) {
      const ipc = global.ShogunIpcClient.createIpcClient();
      out = await ipc.invoke('auth_sign_out', {});
    }
    global.dispatchEvent(new CustomEvent('shogun-clerk-auth-changed'));
    return out;
  }

  function getClerkUser() {
    return global.Clerk && global.Clerk.user ? global.Clerk.user : null;
  }

  function isSignedIn() {
    return Boolean(global.Clerk && global.Clerk.session);
  }

  global.ShogunClerkAuth = {
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
})(window);
