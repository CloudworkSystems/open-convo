import { createRoot } from 'react-dom/client';
import '../brand/fonts/fonts.css';
import '../brand/tokens.css';
import './shell/foundation.css';
import './shell/nexus.css';
import './app/recovery.css';
import { App } from './app/App';
import { createBrowserRuntime } from './app/runtime';

const root = document.getElementById('root');
if (!root) throw new Error('The Desk mount point is missing.');
const renderer = createRoot(root);

if (import.meta.env.MODE === 'native-proof') {
  // This is a separate explicit build mode of the same App, never selected by
  // a URL parameter or by finding a lookalike global in the browser preview.
  renderer.render(<main className="recovery-page"><p role="status">Opening the workspace…</p></main>);
  void (async () => {
    try {
      const native = window as unknown as {
        trueConvoHostBootstrap?: unknown;
        webkit?: { messageHandlers?: { trueConvoHost?: { postMessage(value: Record<string, unknown>): Promise<unknown> } } };
      };
      const handler = native.webkit?.messageHandlers?.trueConvoHost;
      if (!handler || typeof handler.postMessage !== 'function') throw new Error('Host unavailable');
      const { initializeNativeProof } = await import('./app/native-bootstrap');
      const { nativeOpenedBefore, windowNameViewCarry } = await import('./adapters/fresh-open');
      const { DESK_TAB_VIEW_KEY } = await import('./adapters/browser-tab-view');
      const initialized = await initializeNativeProof({
        bootstrap: native.trueConvoHostBootstrap,
        postMessage: (envelope) => handler.postMessage(envelope),
        events: window,
      // A reload of this window (also the host's crash recovery) keeps its screen; a new window opens blank.
      }, { keepSavedScreen: nativeOpenedBefore(window), viewCarry: windowNameViewCarry(window, DESK_TAB_VIEW_KEY) });
      if (initialized.kind !== 'ready') throw new Error('Host unavailable');
      window.addEventListener('pagehide', () => initialized.runtime.revoke(), { once: true });
      renderer.render(<App runtime={initialized.runtime} />);
    } catch {
      renderer.render(<main className="recovery-page" role="alert"><h1>Workspace unavailable</h1>
        <p>Reopen the native proof from the Mac app. Existing work was not replaced.</p></main>);
    }
  })();
} else {
  renderer.render(<App runtime={createBrowserRuntime()} />);
}
