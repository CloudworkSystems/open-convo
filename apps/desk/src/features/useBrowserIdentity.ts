import { useEffect, useState } from 'react';
import { DEFAULT_IDENTITY, IDENTITY_KEY, type BrowserIdentityLoadResult } from '../adapters/browser-identity';
import { useDeskRuntime } from '../app/runtime';

const changeEvent = 'true-convo:browser-identity-changed';

export function announceIdentitySaved(): void {
  window.dispatchEvent(new Event(changeEvent));
}

/** Identity uses the selected auxiliary store, never workspace records. */
export function useBrowserIdentity() {
  const runtime = useDeskRuntime();
  const [identity, setIdentity] = useState<BrowserIdentityLoadResult & { ready: boolean }>({
    preferences: { ...DEFAULT_IDENTITY }, baseline: null, ready: false, readOnly: true, warning: 'Loading browser identity…',
  });
  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = async () => {
      const current = ++request;
      const loaded = await runtime.identity.load();
      if (active && runtime.isActive() && current === request) setIdentity({ ...loaded, ready: true });
    };
    const changed = () => { void refresh(); };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === IDENTITY_KEY || event.key === null) changed();
    };
    const visible = () => { if (document.visibilityState === 'visible') changed(); };
    const unsubscribe = runtime.identity.subscribe(changed);
    changed();
    window.addEventListener(changeEvent, changed);
    window.addEventListener('storage', storageChanged);
    window.addEventListener('focus', changed);
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      request += 1;
      unsubscribe();
      window.removeEventListener(changeEvent, changed);
      window.removeEventListener('storage', storageChanged);
      window.removeEventListener('focus', changed);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [runtime]);
  return identity;
}
