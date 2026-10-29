/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * A corner overlay with the session's live figures, shown only while the
 * dashboard's stats section has its "Show over the stream" switch on.
 *
 * The core already collects both halves — the server's `stream_stats` and its
 * own receive side — into `window.stream_stats` (`lib/stream-stats.js`), but
 * only a dashboard that posts `statsOpen` ever reads it. So the numbers the
 * server measures (encoder target, capture-to-sent, round-trip, keyframe
 * requests) would otherwise be computed and thrown away.
 *
 * It has no hotkey of its own: the switch is the only way in or out. A panel
 * that could also appear by pressing a key would be one more thing whose state
 * disagrees with the switch that claims to own it.
 *
 * It docks to the **right** edge: the stream is the thing being watched, and a
 * panel over the top-left corner lands on whatever a game draws its own HUD in.
 * The right edge also has the least content in practice (desktop icons are on
 * the left). Next to it sits a narrow tab, the same affordance the dashboard's
 * sidebar uses on its own edge: clicking it tucks the panel off-screen and
 * leaves only the tab, clicking again brings it back. That state is remembered,
 * so a session that wants the numbers out of the way stays that way.
 *
 * Opening the overlay does **not** touch the subscription: the dashboard's
 * strip already holds it (`holdStats` in `stats-hold.js`), and the section
 * holds it too while open. Posting `statsOpen` from here as well would fight
 * that counter — a panel closing would cut the numbers the section is still
 * showing.
 *
 * Everything is drawn inside a shadow root and re-rendered on the
 * `selkies-stream-stats` event, once per second, with `pointer-events: none`
 * so it can never eat a click meant for the stream. The tab and the two
 * pipeline buttons are the only clickable parts.
 * @module
 */

import { STATS_EVENT } from './stream-stats.js';

/** Remembered across loads: "on, but tucked into the edge" is a third state. */
const STORE_TUCKED = 'cloudstream_stats_hud_tucked';

/** One line of the overlay: a label and how to render the current sample. */
const ROWS = [
  { key: 'fps', label: 'FPS', of: (s) => num(s.fps, 1) },
  { key: 'rate', label: 'Video', of: (s) => rate(s) },
  { key: 'peak', label: 'Peak 250ms', of: (s) => mbps(s.peak_mbps) },
  { key: 'send', label: 'Cap→sent', of: (s) => span(s.send_ms, s.send_min_ms, s.send_max_ms) },
  { key: 'encode', label: 'Encode', of: (s) => num(s.encode_ms, 1, ' ms') },
  // #84: the server's QoS controller backs the encoder off when the link is
  // the bottleneck. Without this line a deliberately reduced rate looks like a
  // broken encoder — `Target` above drops while `Video` follows it.
  { key: 'qos', label: 'QoS', of: (s) => (typeof s.throttled === 'boolean'
    ? (s.throttled ? 'throttled' : 'full rate')
    : '\u2013') },
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
    /* The dock is the fixed anchor at the right edge; the panel and its tab are
       one flex row inside it, so the tab can never drift away from the panel
       whatever height the row list grows to. */
    .dock {
      position: fixed; right: 0; top: 12px; z-index: 2147483000;
      display: flex; align-items: flex-start; gap: 8px;
      pointer-events: none;
    }
    .dock[hidden] { display: none; }
    .panel {
      position: relative;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: #e8eef7; background: rgba(9, 12, 18, 0.82);
      border: 1px solid rgba(120, 160, 220, 0.28); border-radius: 8px;
      padding: 8px 10px; min-width: 232px;
      max-height: calc(100vh - 24px); overflow-y: auto;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      pointer-events: none; user-select: none;
      -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
      transform: translateX(0); opacity: 1;
      transition: transform 180ms ease, opacity 180ms ease;
    }
    /* Tucked: slid past the edge far enough that only the tab is left on screen.
       Layout is untouched (transform, not margin), so the tab does not move. */
    .dock[data-tucked="1"] .panel {
      transform: translateX(calc(100% + 16px)); opacity: 0;
    }
    /* The grab handle: the same affordance as the dashboard sidebar's edge
       toggle (the toggle-handle / toggle-indicator pair in the dashboard's
       Overlay.css) — a bare accent pill on a transparent hit box, so it adds no
       dark rectangle of its own over the stream. */
    .tab {
      flex: 0 0 auto; width: 15px; height: 60px; margin-top: 6px;
      display: flex; align-items: center; justify-content: center;
      padding: 0; background: none; border: none; cursor: pointer;
      /* The one part of the overlay that must accept clicks while tucked. */
      pointer-events: auto;
    }
    .tab::before {
      content: ''; width: 4px; height: 44px; border-radius: 999px;
      background: #ec4899; opacity: 0.7;
      transition: opacity 150ms ease, width 150ms ease;
    }
    .tab:hover::before { opacity: 1; width: 6px; }
    .tab:focus-visible { outline: none; }
    .tab:focus-visible::before { opacity: 1; width: 6px; }
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
  hint.hidden = true;
  panel.append(hint);

  // The edge tab. Same gesture as the dashboard sidebar's handle: one click
  // tucks the panel away, the next brings it back.
  const tab = document.createElement('button');
  tab.className = 'tab';
  tab.type = 'button';
  tab.setAttribute('aria-controls', 'selkies-stats-panel');
  panel.id = 'selkies-stats-panel';

  const dock = document.createElement('div');
  dock.className = 'dock';
  dock.append(panel, tab);
  root.append(style, dock);
  document.body.append(host);

  /** Whether the panel is drawn. The subscription is the dashboard's business. */
  let shown = false;
  /** Whether the panel is tucked into the right edge (visible, but out of the way). */
  let tucked = false;

  const paintTab = () => {
    // The pill has no room for a chevron; the tooltip and the ARIA state carry
    // the direction instead.
    tab.title = tucked ? 'Show the stats panel' : 'Hide the stats panel';
    tab.setAttribute('aria-label', tab.title);
    tab.setAttribute('aria-expanded', tucked ? 'false' : 'true');
    dock.dataset.tucked = tucked ? '1' : '0';
  };

  const setTucked = (next) => {
    tucked = !!next;
    paintTab();
    try {
      localStorage.setItem(STORE_TUCKED, tucked ? '1' : '0');
    } catch (_) {
      // Storage disabled: the fold just does not outlive the page.
    }
  };

  tab.addEventListener('click', (event) => {
    // The tab sits over the stream in gaming mode; a stray press must not also
    // reach the pointer-lock handler.
    event.stopPropagation();
    setTucked(!tucked);
  });

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
    const waiting = sample.server === false;
    hint.hidden = !waiting;
    hint.textContent = waiting ? 'waiting for the server sample\u2026' : '';
  };

  /**
   * The switch's state, and nothing else. The dashboard owns it (the stats
   * section's "show over the stream" button posts `statsHud`), so this does not
   * remember a state of its own: two memories would eventually disagree, and the
   * loser would be whichever wrote last.
   */
  const show = (open) => {
    shown = !!open;
    dock.hidden = !shown;
    render();
  };

  window.addEventListener(STATS_EVENT, render);

  /**
   * Pipeline toggles. Both are `pipelineControl` posts — the same message a
   * dashboard sends (`selkies-wr-core.js:2051`). They earn their place even
   * with a dashboard around: in a pointer-locked session no click lands on the
   * sidebar, and these two are the only ones that keep working from over the
   * stream.
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
    if (!data) return;
    // The stats section's "show over the stream" switch, posted by the
    // dashboard (`Sidebar.jsx`). Every state change arrives here; the panel
    // has no other way to be shown.
    if (data.type === 'statsHud') {
      show(!!data.open);
      return;
    }
    if (data.type !== 'sidebarButtonStatusUpdate') return;
    if (typeof data.audio === 'boolean') audioOn = data.audio;
    if (typeof data.microphone === 'boolean') micOn = data.microphone;
    paint();
  });
  paint();

  // Remembered: "tucked into the edge" outlives the page. Whether the panel is
  // on at all is the dashboard's switch, not ours.
  let rememberedTucked = '0';
  try {
    rememberedTucked = localStorage.getItem(STORE_TUCKED) ?? '0';
  } catch (_) {
    // Private mode with storage disabled: stay on the default.
  }
  setTucked(rememberedTucked === '1');
  // Off until the dashboard says otherwise: a panel that appears before the
  // switch that owns it has even mounted is a panel flickering on and off.
  show(false);
}
