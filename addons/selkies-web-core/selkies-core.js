/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Entry point of the web client: names the tab after the web root's manifest,
 * picks the streaming transport, and starts it.
 *
 * The transport is `window.__SELKIES_STREAMING_MODE__` when the page injects
 * one, else the `stream_mode` the last session persisted, else WebSockets. A
 * dashboard switches it by posting a `{type: "mode", mode}` window message; the
 * choice is persisted and the page reloads two seconds later, since the two
 * cores are not built for an in-place hand-off. A host page that sets
 * `window.__SELKIES_DEFER_INITIALIZATION` starts the client itself through
 * `window.selkiesCoreInitialize()`; otherwise the client starts on load.
 *
 * Persisted settings live in localStorage under the `getStorageAppName()`
 * namespace (origin plus pathname, never the query: a per-session `?token=`
 * must not mint a namespace per connect and exhaust the origin's quota). This
 * module also owns the one-time migration from the two legacy key schemes: a
 * sanitizer that kept `?`, `=`, and `:` literal, and a full-href derivation
 * whose token-scoped keys are pruned on every load to recover stores the leak
 * already filled.
 * @module
 */

import { getStorageAppName } from "./lib/util.js";
import { titleFromManifest } from "./lib/page-title.js";
import { installStatsHud } from "./lib/stats-hud.js";
import {
    Surface,
    admitAction,
    interceptorLabel,
    resetStats,
    setInterceptor,
    stats,
    surfaceOfEvent,
} from "./lib/listener-surface.js";
import webrtc from "./selkies-wr-core";
import websockets from "./selkies-ws-core";

const STREAM_MODE_WEBRTC = "webrtc";
const STREAM_MODE_WEBSOCKETS = "websockets";

/** Origin plus pathname, the string the legacy key prefix was derived from. */
const urlForKey = window.location.origin + window.location.pathname;
const storageAppName = getStorageAppName();
const getPrefixedKey = (key) => {return `${storageAppName}_${key}`}
/** Writes a key, degrading a full or unavailable store to a warning. */
const safeSetItem = (key, value) => {
    try {
        localStorage.setItem(key, value);
    } catch (e) {
        console.warn(`Selkies: could not persist '${key}' to localStorage:`, e);
    }
};

/**
 * Migrates settings from the legacy key prefix and prunes token-scoped keys.
 *
 * Query-less legacy keys are copied to the current prefix once, and only when
 * no key under the current prefix exists yet, so settings saved since are
 * never clobbered; a flag key makes the copy run at most once. Token-scoped
 * keys (legacy prefix plus a literal `?`) are removed on every load, which is
 * cheap and frees quota before any write (`removeItem` never hits the quota).
 */
(function migrateStorageKeys() {
    try {
        if (typeof localStorage === 'undefined') return;
        // The legacy sanitizer kept a-z and 0x2E-0x5F literal.
        let oldAppName = '';
        for (let i = 0; i < urlForKey.length; i++) {
            const c = urlForKey.charCodeAt(i);
            oldAppName += ((c >= 0x2E && c <= 0x5F) || (c >= 0x61 && c <= 0x7A)) ? urlForKey[i] : '_';
        }
        const tokenPrefix = oldAppName + '?';
        const staleKeys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(tokenPrefix)) staleKeys.push(k);
        }
        staleKeys.forEach((k) => localStorage.removeItem(k));
        if (staleKeys.length) {
            console.log(`Selkies: removed ${staleKeys.length} stale token-scoped localStorage keys.`);
        }
        if (oldAppName === storageAppName) return;
        const migratedFlagKey = `${storageAppName}_storage_key_migrated`;
        if (localStorage.getItem(migratedFlagKey) !== null) return;

        const oldPrefix = `${oldAppName}_`;
        const newPrefix = `${storageAppName}_`;

        // Snapshot first: the loop below mutates localStorage.
        const allKeys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k !== null) allKeys.push(k);
        }
        const hasNew = allKeys.some((k) => k.startsWith(newPrefix));
        const oldKeys = allKeys.filter((k) => k.startsWith(oldPrefix));
        if (!hasNew && oldKeys.length > 0) {
            for (const oldKey of oldKeys) {
                const suffix = oldKey.slice(oldPrefix.length);
                const newKey = newPrefix + suffix;
                if (localStorage.getItem(newKey) === null) {
                    const val = localStorage.getItem(oldKey);
                    if (val !== null) safeSetItem(newKey, val);
                }
            }
            console.log(`Migrated ${oldKeys.length} setting(s) from old storage prefix "${oldPrefix}" to "${newPrefix}".`);
        }
        safeSetItem(migratedFlagKey, '1');
    } catch (e) {
        console.warn('Storage key migration skipped due to error:', e);
    }
})();

let mode = null;

/**
 * Resolves the transport to start: the injected runtime mode, else the last
 * session's persisted mode, else WebSockets.
 * @returns {string} `"webrtc"` or `"websockets"`.
 */
function determineStreamingMode() {
    const runtimeMode = (typeof window !== 'undefined' && window.__SELKIES_STREAMING_MODE__) ? window.__SELKIES_STREAMING_MODE__ : undefined;
    let lastSessionMode = localStorage.getItem(getPrefixedKey('stream_mode'));
    const finalMode = runtimeMode ? runtimeMode : (lastSessionMode ? lastSessionMode : STREAM_MODE_WEBSOCKETS);
    console.log(`Streaming mode determined to be: ${finalMode}`);
    return finalMode;
}

/**
 * Persists a dashboard's `{type: "mode", mode}` request and reloads the page.
 *
 * Only the two real transports are persisted: anything else would make every
 * following load throw until localStorage was repaired by hand. The reload
 * waits two seconds so the server has switched modes before it lands.
 * @param {MessageEvent} event Same-origin window message.
 */
function handleMessage(event) {
    if (event.origin !== window.location.origin) return;
    let message = event.data;
    if (message.mode !== undefined && message.type === "mode") {
        if (![STREAM_MODE_WEBRTC, STREAM_MODE_WEBSOCKETS].includes(message.mode)) return;
        console.log(`Switching streaming mode to: ${message.mode}`);
        safeSetItem(getPrefixedKey('stream_mode'), message.mode);

        setTimeout(() => {
            window.location.reload();
        }, 2000)
    }
}

/**
 * Persists the mode and starts the matching core.
 * @param {string} newMode `"webrtc"` or `"websockets"`.
 * @throws {Error} On any other mode.
 */
function switchStreamingMode(newMode) {
    safeSetItem(getPrefixedKey('stream_mode'), newMode);
    switch (newMode) {
        case STREAM_MODE_WEBRTC:
            mode = webrtc();
            mode.initialize();
            break;
        case STREAM_MODE_WEBSOCKETS:
            mode = websockets();
            break;
        default:
            throw new Error(`Invalid client mode: ${newMode} received, aborting`);
    }
}

if (typeof window !== 'undefined') {
    // #88: 监听面 API。上层项目（webgame 等）不必改这份源码 ——
    // `window.selkiesSurface.setInterceptor(fn)` 就能接管键鼠、剪贴板、麦克风、
    // 摄像头、文件上传的每一次触发。
    //
    // 暴露在 `selkiesCoreInitialize` 之外、模块求值时：策略必须在**第一个**
    // 事件到达之前就位。挂进初始化函数里，首屏那几十毫秒的按键会遵循默认的
    // "全放行"，而那正是最该被拦的时刻。
    window.selkiesSurface = Object.freeze({
        Surface,
        admitAction,
        setInterceptor,
        /** 当前拦截器名，`none` 表示没有策略。 */
        interceptorLabel,
        stats,
        resetStats,
        surfaceOfEvent,
    });
    window.addEventListener("message", handleMessage)
    window.selkiesCoreInitialize = function() {
        titleFromManifest();
        const streamingMode = determineStreamingMode();
        switchStreamingMode(streamingMode);
        // After the core is up: the overlay announces `statsOpen` on the
        // window, and the core is the only listener for it.
        //
        // Guarded on purpose. This runs *before* a dashboard mounts its React
        // tree (`main.jsx:70` calls us, then renders), so an exception in the
        // overlay takes the whole sidebar down with it — the failure looks like
        // "the toolbar is gone", not like "the stats panel is broken". An
        // optional overlay must never be able to do that.
        try {
            installStatsHud();
        } catch (e) {
            console.error("Selkies: stats overlay failed to install; continuing without it:", e);
        }
    };
}

if (typeof window !== 'undefined' && !window.__SELKIES_DEFER_INITIALIZATION) {
    window.selkiesCoreInitialize();
}
