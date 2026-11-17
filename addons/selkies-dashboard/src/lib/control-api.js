/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The one place the dashboard talks to the server's control surface.
 *
 * Two rules, both learned from the alternatives:
 *
 * - **Every failure is a `ControlError` with a `kind`.** The control endpoints
 *   use status codes as semantics, not as accidents: `404` means "this host
 *   does not host games", `409` means "it is already running", `403` means
 *   "only the host machine may do this". A panel that renders `Failed to
 *   fetch` for all four is worse than no panel, so the mapping happens here
 *   and the copy lives in `translations.js`.
 * - **Every request has a deadline.** Starting a game waits for the process to
 *   come up; stopping waits up to `stop_timeout_sec` before killing. A panel
 *   with no timeout shows a spinner forever exactly when the machine is
 *   unhealthy — the one moment the operator is looking at it.
 *
 * @module control-api
 */

import { getRoutePrefix } from "../../../selkies-web-core/lib/util.js";
import { sessionAuthHeaders } from "../../../selkies-web-core/lib/session-token.js";

/** Start/stop/restart wait for the process to settle, so they get more room. */
export const CONTROL_TIMEOUT_MS = 30000;

/** A health poll that takes longer than this is not going to answer. */
export const HEALTH_TIMEOUT_MS = 6000;

/**
 * A control-surface failure, tagged by what the operator can do about it.
 * @property {number} status HTTP status, or 0 when the request never landed.
 * @property {"unauthorized"|"forbidden"|"unavailable"|"conflict"|"busy"|"too-large"|"timeout"|"network"|"server"|"http"} kind
 * @property {object|null} payload Parsed body, when the server sent one.
 */
export class ControlError extends Error {
    constructor(message, { status = 0, kind = "network", payload = null } = {}) {
        super(message);
        this.name = "ControlError";
        this.status = status;
        this.kind = kind;
        this.payload = payload;
    }
}

/**
 * An absolute path under the deployment's route prefix.
 * @param {string} path Starts with `/`.
 * @returns {string}
 */
export function apiUrl(path) {
    return `${getRoutePrefix()}${path}`;
}

/**
 * @param {string} action e.g. `game/start`.
 * @returns {string}
 */
export function controlUrl(action) {
    return apiUrl(`/api/v1/control/${action}`);
}

/**
 * Status code to the kind the panel renders.
 * @param {number} status
 * @returns {string}
 */
function kindOfStatus(status) {
    if (status === 401) return "unauthorized";
    if (status === 403) return "forbidden";
    if (status === 404) return "unavailable";
    if (status === 409) return "conflict";
    if (status === 413) return "too-large";
    if (status === 429 || status === 503) return "busy";
    if (status >= 500) return "server";
    return "http";
}

/**
 * Parse a body without letting a non-JSON error page throw over the real error.
 * @param {Response} res
 * @returns {Promise<object|null>}
 */
async function readJson(res) {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

/**
 * Wrap `fetch` with the timeout/session/JSON conventions above.
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object} [options.body]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object|null>}
 */
async function request(url, { method = "GET", body = null, timeoutMs = CONTROL_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = sessionAuthHeaders(body ? { "Content-Type": "application/json" } : {});
    try {
        const res = await fetch(url, {
            method,
            credentials: "same-origin",
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
            cache: "no-store",
        });
        const payload = await readJson(res);
        if (!res.ok) {
            // The server writes a human sentence into `error` on the control
            // endpoints; keep it for the details line, but drive the headline
            // off the status so the copy stays translated.
            throw new ControlError(payload?.error || res.statusText || `HTTP ${res.status}`, {
                status: res.status,
                kind: kindOfStatus(res.status),
                payload,
            });
        }
        return payload;
    } catch (err) {
        if (err instanceof ControlError) throw err;
        if (err?.name === "AbortError") {
            throw new ControlError(`timed out after ${timeoutMs} ms`, { kind: "timeout" });
        }
        throw new ControlError(err?.message || "request failed", { kind: "network" });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * `POST /api/v1/control/<action>`.
 * @param {string} action `game/start`, `game/stop`, `game/restart`, …
 * @param {object} [options]
 * @param {object} [options.body]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object|null>} The parsed body (`{ ok, action, game }`).
 */
export function postControl(action, { body = {}, timeoutMs = CONTROL_TIMEOUT_MS } = {}) {
    return request(controlUrl(action), { method: "POST", body, timeoutMs });
}

/**
 * The whole health report. Callers pick the segment they care about (`game`,
 * `kiosk`); it is one request on purpose — two polls of the same document
 * would answer from two different moments and the panel would flicker between
 * "running" and "locked" states that never coexisted.
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object|null>}
 */
export function fetchHealth({ timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
    return request(apiUrl("/api/v1/health"), { timeoutMs });
}

/**
 * i18n key for the headline of a failure.
 * @param {unknown} err
 * @returns {string}
 */
export function controlErrorKey(err) {
    const kind = err instanceof ControlError ? err.kind : "network";
    return `sections.game.errors.${kind}`;
}

/**
 * The detail line: whatever the server said, verbatim.
 * @param {unknown} err
 * @returns {string}
 */
export function controlErrorDetail(err) {
    if (err instanceof ControlError) {
        return err.message;
    }
    return err instanceof Error ? err.message : String(err ?? "");
}
