/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Entry point of the dashboard bundle.
 *
 * Probes `/api/status` for the server's streaming mode and dual-mode flag,
 * publishes them on `window.__SELKIES_STREAMING_MODE__` and
 * `window.__SELKIES_DUAL_MODE__`, then loads selkies-core with
 * `window.__SELKIES_DEFER_INITIALIZATION` set and starts it through
 * `window.selkiesCoreInitialize()` so the core comes up in the detected mode.
 * The `#shared` and `#player2` to `#player4` hashes render no dashboard and
 * mount only the floating touch-gamepad toggle: always for the player slots,
 * and once touch is detected for the shared viewer. The touch gamepad is
 * bundled straight from the universal-touch-gamepad addon, so a fresh
 * checkout builds without a vendored copy.
 * @module
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import PlayerGamepadButton from './components/PlayerGamepadButton.jsx';
import './index.css';
import { getRoutePrefix, getStorageAppName } from '../../selkies-web-core/lib/util.js';
import { urlFragmentKeyword } from '../../selkies-web-core/lib/page-url.js';
import "../../universal-touch-gamepad/universalTouchGamepad.js";

/** The two transports selkies-core can start. */
const TRANSPORTS = ['webrtc', 'websockets'];

/** The key selkies-core reads and writes the transport choice under. */
const STREAM_MODE_KEY = `${getStorageAppName()}_stream_mode`;

/**
 * The transport named in `?transport=`, or null.
 *
 * A one-shot override, for a link that must open in a given transport: a
 * WebRTC session that cannot connect on somebody's network, or a support
 * message saying "try `?transport=websockets`". It is not a pin — see
 * {@link dropTransportParam}.
 * @returns {?string}
 */
function transportFromQuery() {
  const asked = new URLSearchParams(window.location.search).get('transport');
  const mode = (asked || '').trim().toLowerCase();
  return TRANSPORTS.includes(mode) ? mode : null;
}

/**
 * Removes `transport=` from the address bar after it has been honoured.
 *
 * The panel's switch stores its choice and reloads the page. Left in the URL,
 * the override would win again on that reload and the switch would appear to
 * do nothing — the one bug this whole file exists to avoid.
 * @returns {void}
 */
function dropTransportParam() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('transport')) return;
    url.searchParams.delete('transport');
    window.history.replaceState(window.history.state, '', url.toString());
  } catch (err) {
    console.warn(`Could not tidy the transport override out of the URL: ${err}`);
  }
}

/**
 * Decides which transport this page starts on, before selkies-core is loaded.
 *
 * Two sources, in this order:
 *
 * 1. `?transport=` — explicit, and it is also persisted so the choice
 *    survives the reload.
 * 2. `/api/status` — the deployment's default, taken **only when this browser
 *    has never chosen**. That distinction matters: selkies-core ranks an
 *    injected mode *above* the stored one (`determineStreamingMode`), so
 *    publishing the server's default on `window` would silently undo every
 *    switch the user made in the panel. Seeding an empty localStorage gives a
 *    fresh browser the right default and leaves a used one alone.
 *
 * The probe also carries `enable_dual_mode`, which is what makes the panel's
 * mode switch render at all (`Sidebar.jsx:2804`). Without it a WebRTC session
 * that cannot connect has no way back to the transport that works.
 *
 * A failed probe is logged and leaves everything at the core's own default;
 * both transports are implemented, so the page still comes up.
 * @returns {Promise<void>}
 */
async function detectInitialMode() {
  const asked = transportFromQuery();
  if (asked) {
    console.log(`Transport asked for in the URL: ${asked}`);
    window.__SELKIES_STREAMING_MODE__ = asked;
    try {
      localStorage.setItem(STREAM_MODE_KEY, asked);
    } catch (err) {
      console.warn(`Could not persist the transport override: ${err}`);
    }
    dropTransportParam();
    return;
  }

  try {
    const resp = await fetch(`${getRoutePrefix()}/api/status`, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok)
      throw new Error(`Failed to fetch initial mode, status: ${resp.status}`);
    const data = await resp.json();
    if (data && typeof data.enable_dual_mode !== 'undefined') {
      window.__SELKIES_DUAL_MODE__ = !!data.enable_dual_mode;
    }
    if (!data || !TRANSPORTS.includes(data.current_mode)) return;
    let stored = null;
    try {
      stored = localStorage.getItem(STREAM_MODE_KEY);
    } catch (err) {
      console.warn(`Could not read the stored transport: ${err}`);
    }
    if (stored) {
      console.log(`Keeping this browser's saved transport: ${stored}`);
      return;
    }
    console.log(`Received initial streaming mode: ${data.current_mode}`);
    try {
      localStorage.setItem(STREAM_MODE_KEY, data.current_mode);
    } catch (err) {
      // Private mode or a full quota: fall through to the injected value,
      // which is still better than the core's hard default.
      console.warn(`Could not persist the server's transport: ${err}`);
      window.__SELKIES_STREAMING_MODE__ = data.current_mode;
    }
  } catch (err) {
    console.warn(`Error detecting initial mode: ${err}`);
  }
}

const currentHash = urlFragmentKeyword();
const noDashboardModes = ['#shared', '#player2', '#player3', '#player4'];
const playerClientModes = ['#player2', '#player3', '#player4'];

(async () => {
  await detectInitialMode();
  window.__SELKIES_DEFER_INITIALIZATION = true;
  await import('./selkies-core.js');
  window.selkiesCoreInitialize();
  if (!noDashboardModes.includes(currentHash)) {
    const dashboardRootElement = document.createElement('div');
    dashboardRootElement.id = 'dashboard-root';
    // Keystrokes on dashboard controls drive the UI, not the game: the input
    // core skips events whose target sits under an allow-native-input ancestor.
    dashboardRootElement.classList.add('allow-native-input');
    document.body.appendChild(dashboardRootElement);
    const appMountPoint = document.getElementById('root');
    if (appMountPoint) {
      ReactDOM.createRoot(appMountPoint).render(
        <React.StrictMode>
          <App dashboardRoot={dashboardRootElement} />
        </React.StrictMode>,
      );
    } else {
      console.error("CRITICAL: Dashboard mount point #root not found. Primary dashboard will not render.");
    }
  } else {
    console.log(`Dashboard UI rendering skipped for mode: ${currentHash}; mounting the touch gamepad toggle.`);
    const playerUIRootElement = document.createElement('div');
    playerUIRootElement.id = 'player-ui-root';
    document.body.appendChild(playerUIRootElement);
    ReactDOM.createRoot(playerUIRootElement).render(
      <React.StrictMode>
        <PlayerGamepadButton touchOnly={!playerClientModes.includes(currentHash)} />
      </React.StrictMode>,
    );
  }
})();
