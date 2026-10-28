/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * A corner overlay with the session's live figures, toggled with F3.
 *
 * The core already collects both halves — the server's `stream_stats` and its
 * own receive side — into `window.stream_stats` (`lib/stream-stats.js`), but
 * only a dashboard that posts `statsOpen` ever reads it, and this page has
 * none. So the numbers the server measures (encoder target, capture-to-sent,
 * round-trip, keyframe requests) were being computed and thrown away.
 *
 * Opening the overlay posts `{type: "statsOpen", open: true}` to the same
 * window, which is exactly what a dashboard does (`selkies-wr-core.js:1933`):
 * the core then sends `_stats,1` and starts sampling its own side. Closing it
 * posts `open: false` and the server stops sending.
 *
 * Everything is drawn inside a shadow root and re-rendered on the
 * `selkies-stream-stats` event, once per second, with `pointer-events: none`
 * so it can never eat a click meant for the stream.
 * @module
 */

import { STATS_EVENT } from './stream-stats.js';

/** Key that toggles the overlay. F3 is unbound in the browser and in MC. */
const HOTKEY = 'F3';
/** Key that toggles the microphone, for use while the pointer is locked. */
const MIC_HOTKEY = 'F4';
/** Remembered across loads; the overlay is worth keeping on while tuning. */
const STORE_KEY = 'cloudstream_stats_hud';

/** One line of the overlay: a label and how to render the current sample. */
const ROWS = [
  { key: 'fps', label: 'FPS', of: (s) => num(s.fps, 1) },
  { key: 'rate', label: 'Video', of: (s) => rate(s) },
  { key: 'peak', label: 'Peak 250ms', of: (s) => mbps(s.peak_mbps) },
  { key: 'send', label: 'Cap→sent', of: (s) => span(s.send_ms, s.send_min_ms, s.send_max_ms) },
  { key: 'encode', label: 'Encode', of: (s) => num(s.encode_ms, 1, ' ms') },
  { key: 'rtt', label: 'RTT', of: (s) => num(s.rtt_ms, 1, ' ms') },
  { key: 'loss', label: 'Loss', of: (s) => num(s.packet_loss_percent, 2, ' %') },
  { key: 'kf', label: 'Keyframes', of: (s) => num(s.keyframe_requests, 0) },
  { key: 'path', label: 'Stream', of: (s, client) => path(s, client) },
];

/** A number with `digits` decimals, or an en dash when it was not measured. */
function num(value, digits, unit = '') {
  if (typeof value !== 'number' || !isFinite(value)) return '\u2013';
  return `${value.toFixed(digits)}${unit}`;
}

/** Megabits per second, two decimals. */
function mbps(value) {
  return typeof value === 'number' && isFinite(value) ? `${value.toFixed(2)} Mbps` : '\u2013';
}

/** `4.12 / 5.00 Mbps`: what the encoder produced against its target. */
function rate(sample) {
  const got = sample.video_mbps;
  if (typeof got !== 'number' || !isFinite(got)) return '\u2013';
  const want = sample.target_mbps;
  return typeof want === 'number' && want > 0
    ? `${got.toFixed(2)} / ${want.toFixed(2)} Mbps`
    : `${got.toFixed(2)} Mbps`;
}

/** `19.4 ms (12–41)`: the mean with the window's range under it. */
function span(mean, min, max) {
  const shown = num(mean, 1, ' ms');
  if (shown === '\u2013' || typeof min !== 'number' || typeof max !== 'number') return shown;
  return `${shown} (${min.toFixed(0)}\u2013${max.toFixed(0)})`;
}

/** Transport, codec, resolution and decoder in one line. */
function path(sample, client) {
  if (!client) return '\u2013';
  const parts = [client.transport, client.resolution].filter(Boolean);
  if (client.decoder && client.decoder !== 'unknown') parts.push(client.decoder);
  return parts.join(' \u00b7 ') || '\u2013';
}

/**
 * Build the overlay and wire it to the stats stream.
 *
 * Idempotent: a second call (a host page initializing twice) does nothing.
 */
export function installStatsHud() {
  if (typeof window === 'undefined' || window.__selkiesStatsHud) return;
  window.__selkiesStatsHud = true;

  const host = document.createElement('div');
  host.id = 'selkies-stats-hud';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    .panel {
      position: fixed; left: 12px; top: 12px; z-index: 2147483000;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: #e8eef7; background: rgba(9, 12, 18, 0.82);
      border: 1px solid rgba(120, 160, 220, 0.28); border-radius: 8px;
      padding: 8px 10px; min-width: 232px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      pointer-events: none; user-select: none;
      -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
      transition: opacity 120ms ease;
    }
    .panel[hidden] { display: none; }
    .row { display: flex; justify-content: space-between; gap: 14px; }
    .k { color: #8fa3bd; }
    .v { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .hint { margin-top: 4px; color: #64748b; font-size: 10px; }
    .controls {
      display: flex; gap: 6px; margin-top: 7px; padding-top: 7px;
      border-top: 1px solid rgba(120, 160, 220, 0.18);
      /* The panel is click-through so it never eats a click meant for the
         stream; these two are the exception. */
      pointer-events: auto;
    }
    .btn {
      flex: 1; font: inherit; font-size: 11px; color: #cbd5e1; cursor: pointer;
      background: rgba(255, 255, 255, 0.06); border-radius: 5px;
      border: 1px solid rgba(120, 160, 220, 0.25); padding: 3px 0;
    }
    .btn:hover { background: rgba(255, 255, 255, 0.12); }
    .btn[data-on="1"] { color: #06121f; background: #5eead4; border-color: #5eead4; }
  `;
  const panel = document.createElement('div');
  panel.className = 'panel';
  /** @type {Record<string, HTMLElement>} */
  const cells = {};
  for (const row of ROWS) {
    const line = document.createElement('div');
    line.className = 'row';
    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = row.label;
    const value = document.createElement('span');
    value.className = 'v';
    value.textContent = '\u2013';
    line.append(key, value);
    cells[row.key] = value;
    panel.append(line);
  }
  const controls = document.createElement('div');
  controls.className = 'controls';
  const audioBtn = document.createElement('button');
  const micBtn = document.createElement('button');
  for (const btn of [audioBtn, micBtn]) {
    btn.className = 'btn';
    btn.type = 'button';
  }
  controls.append(audioBtn, micBtn);
  panel.append(controls);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = `F3 hides this \u00b7 F4 mic`;
  panel.append(hint);
  root.append(style, panel);
  document.body.append(host);

  /** Whether the overlay is on screen, which is also the server subscription. */
  let shown = false;

  /** Posts what a dashboard would post: the core owns the subscription. */
  const announce = (open) => {
    try {
      window.postMessage({ type: 'statsOpen', open }, window.location.origin);
    } catch (_) {
      // A cross-origin parent refuses the target origin; nothing else to do,
      // the overlay still shows whatever the core collected for other reasons.
    }
  };

  const render = () => {
    if (!shown) return;
    const stats = window.stream_stats || {};
    const client = window.stream_client || null;
    const sample = stats.latest || {};
    for (const row of ROWS) {
      const cell = cells[row.key];
      if (cell) cell.textContent = row.of(sample, client);
    }
    // A sample without the server's half means the subscription has not landed
    // yet (the first second after opening); say so instead of showing a room
    // full of dashes with no explanation.
    hint.textContent = sample.server === false
      ? 'waiting for the server sample\u2026'
      : 'F3 hides this \u00b7 F4 mic';
  };

  const show = (open) => {
    shown = !!open;
    panel.hidden = !shown;
    try {
      localStorage.setItem(STORE_KEY, shown ? '1' : '0');
    } catch (_) {
      // Storage disabled: the choice just does not outlive the page.
    }
    announce(shown);
    render();
  };

  window.addEventListener(STATS_EVENT, render);

  /**
   * Pipeline toggles. Both are `pipelineControl` posts — the same message a
   * dashboard sends (`selkies-wr-core.js:2051`) — because this page has no
   * dashboard, and without them neither the microphone nor the mute button is
   * reachable at all: the core only ever changes those on a dashboard's word.
   *
   * The labels mirror what the core reports back (`sidebarButtonStatusUpdate`,
   * which carries the real state after a permission prompt refuses), never the
   * click itself.
   */
  let audioOn = true;
  let micOn = false;
  const paint = () => {
    audioBtn.dataset.on = audioOn ? '1' : '0';
    micBtn.dataset.on = micOn ? '1' : '0';
    audioBtn.textContent = audioOn ? 'Sound on' : 'Sound off';
    micBtn.textContent = micOn ? 'Mic on' : 'Mic off';
  };
  const control = (pipeline, enabled) => {
    try {
      window.postMessage({ type: 'pipelineControl', pipeline, enabled }, window.location.origin);
    } catch (_) {
      // Cross-origin parent: nothing to do, the post is for this window only.
    }
  };
  audioBtn.addEventListener('click', () => control('audio', !audioOn));
  micBtn.addEventListener('click', () => control('microphone', !micOn));
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.type !== 'sidebarButtonStatusUpdate') return;
    if (typeof data.audio === 'boolean') audioOn = data.audio;
    if (typeof data.microphone === 'boolean') micOn = data.microphone;
    paint();
  });
  paint();

  window.addEventListener('keydown', (event) => {
    if (event.repeat) return;
    // F4 reaches the microphone without leaving pointer lock: in a locked
    // session no click can land on these buttons.
    if (event.key === MIC_HOTKEY) {
      event.preventDefault();
      control('microphone', !micOn);
      return;
    }
    if (event.key !== HOTKEY) return;
    // F3 is a browser "find again" on some engines and a console shortcut in
    // others; the overlay is the only thing it should do here.
    event.preventDefault();
    show(!shown);
  }, true);

  // Default on: the figures are the point, and the first session after an
  // update should show them without hunting for a hotkey. A session that
  // turned it off keeps it off.
  let remembered = '1';
  try {
    remembered = localStorage.getItem(STORE_KEY) ?? '1';
  } catch (_) {
    // Private mode with storage disabled: stay on the default.
  }
  show(remembered !== '0');
}
