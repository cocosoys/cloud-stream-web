/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Game hosting panel: start / stop / restart the client the server spawns,
 * follow its state, and get to the crash reports when it dies.
 *
 * The panel polls `/api/v1/health` rather than inventing a "game status"
 * endpoint: the health document is already the one place that answers "what is
 * this machine doing", and `game.enabled === false` is a real answer there
 * ("this host does not host games") that a 404 from a dedicated endpoint
 * cannot express as cleanly.
 *
 * Stopping is a kill — `docs/game-hosting.md` §6.1 measured that MC 1.12.2 has
 * no external graceful exit. The confirmation copy says so instead of pretending
 * otherwise.
 *
 * @module GamePanel
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
    apiUrl,
    controlErrorDetail,
    controlErrorKey,
    fetchHealth,
    postControl,
} from "../lib/control-api.js";
import { withSessionToken } from "../../../selkies-web-core/lib/session-token.js";

/** Health is cheap but not free; 5 s is fine for a process that takes 3 s to boot. */
const POLL_INTERVAL_MS = 5000;

/**
 * `1234` → `20m 34s`, `93784` → `1d 2h`.
 * @param {number} secs
 * @returns {string}
 */
function formatUptime(secs) {
    const s = Math.max(0, Math.floor(secs || 0));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * @param {object} props
 * @param {(key: string, varsOrFallback?: object | string) => string} props.t
 * @param {(notice: {status: string, message: string, detail?: string}) => void} [props.notify]
 */
export default function GamePanel({ t, notify }) {
    const [game, setGame] = useState(null);
    const [errorKey, setErrorKey] = useState(null);
    const [errorDetail, setErrorDetail] = useState("");
    const [pending, setPending] = useState(null);
    const alive = useRef(true);

    const poll = useCallback(async () => {
        try {
            const health = await fetchHealth();
            if (!alive.current) return;
            if (health && typeof health === "object" && health.game) {
                setGame(health.game);
            }
            setErrorKey(null);
            setErrorDetail("");
        } catch (err) {
            if (!alive.current) return;
            setErrorKey(controlErrorKey(err));
            setErrorDetail(controlErrorDetail(err));
        }
    }, []);

    useEffect(() => {
        alive.current = true;
        // Kick the first read on a timer rather than straight from the effect
        // body: the effect is there to subscribe, and a synchronous setState in
        // it would render the panel twice before the first answer arrives.
        const kick = setTimeout(poll, 0);
        const timer = setInterval(() => {
            // A hidden tab polling for a status nobody is looking at burns the
            // host's CPU on a machine whose whole job is encoding video.
            if (document.visibilityState === "visible") poll();
        }, POLL_INTERVAL_MS);
        return () => {
            alive.current = false;
            clearTimeout(kick);
            clearInterval(timer);
        };
    }, [poll]);

    const run = useCallback(
        async (action) => {
            setPending(action);
            setErrorKey(null);
            setErrorDetail("");
            try {
                const res = await postControl(`game/${action}`);
                if (res?.game) {
                    setGame({ ...res.game, enabled: true });
                }
                notify?.({
                    status: "end",
                    message: t(`sections.game.notify.${action}`, `${action} ok`),
                });
                poll();
            } catch (err) {
                const key = controlErrorKey(err);
                const detail = controlErrorDetail(err);
                setErrorKey(key);
                setErrorDetail(detail);
                notify?.({
                    status: "error",
                    message: t(key, "Request failed"),
                    detail,
                });
                // A 409 already carries the authoritative state; adopt it
                // instead of leaving a stale "stopped" label next to the error.
                if (err?.payload?.game) {
                    setGame({ ...err.payload.game, enabled: true });
                }
            } finally {
                if (alive.current) setPending(null);
            }
        },
        [notify, poll, t]
    );

    if (!game) {
        return (
            <div className="dev-setting-item">
                <span className="game-status-line">
                    <span className="game-status-dot" />
                    <span>{t("sections.game.loading", "Reading status…")}</span>
                </span>
                {errorKey && (
                    <div className="game-error">
                        <div className="game-error-headline">{t(errorKey, "Request failed")}</div>
                        {errorDetail && <div className="game-error-detail">{errorDetail}</div>}
                    </div>
                )}
            </div>
        );
    }

    if (game.enabled === false) {
        return (
            <div className="dev-setting-item">
                <div className="game-hint">
                    {t(
                        "sections.game.disabledHint",
                        "This host is not hosting a game. Start stream-server with --game to enable it."
                    )}
                </div>
            </div>
        );
    }

    const running = game.state === "running";
    const busy = pending !== null;
    const lastExit = game.last_exit;
    // 本机的"停止"恒为 killed-window-gone + code 1（窗口先销毁、javaw 不退、1 秒后
    // 被杀），与一次真崩溃长得一模一样。后端从 0.4.1 起在 last_exit 里带 requested，
    // 不看它就只能在"把玩家点停说成崩溃"和"把崩溃说成正常停止"之间二选一。
    // requested 缺失 = 老后端，退回旧文案而不是猜。
    const exitTone = !lastExit
        ? null
        : lastExit.requested === true
          ? "requested"
          : lastExit.requested === false
            ? (lastExit.code === 0 ? "clean" : "crash")
            : "legacy";
    const crashCount = Number(game.crash_reports || 0);
    const windowInfo = game.window;

    return (
        <>
            <div className="dev-setting-item">
                <span className="game-status-line" title={`state=${game.state}`}>
                    <span className={`game-status-dot ${running ? "is-running" : "is-stopped"}`} />
                    <span className="game-status-label">
                        {running
                            ? t("sections.game.stateRunning", "Running")
                            : t("sections.game.stateStopped", "Stopped")}
                    </span>
                    {game.pid != null && (
                        <span className="game-status-meta">pid {game.pid}</span>
                    )}
                    {running && game.uptime_secs > 0 && (
                        <span className="game-status-meta">{formatUptime(game.uptime_secs)}</span>
                    )}
                </span>
                <div className="game-instance-name">{game.name || game.instance}</div>
                {windowInfo && (
                    <div className="game-status-meta">
                        {t("sections.game.windowSize", { w: windowInfo.width, h: windowInfo.height })}
                        {windowInfo.minimized && ` · ${t("sections.game.windowMinimized", "minimized off-screen")}`}
                    </div>
                )}
                {running && !windowInfo && (
                    <div className="game-warn">
                        {t(
                            "sections.game.noWindow",
                            "The process is up but no window was found — the client may still be loading."
                        )}
                    </div>
                )}
                {exitTone === "requested" && (
                    <div className="game-status-meta">
                        {t("sections.game.lastExitStopped", "Stopped on request.")}
                    </div>
                )}
                {exitTone === "clean" && (
                    <div className="game-status-meta">
                        {t("sections.game.lastExitClean", "The client quit normally.")}
                    </div>
                )}
                {exitTone === "crash" && lastExit && (
                    <div className="game-warn">
                        {t("sections.game.lastExitCrash", {
                            code: lastExit.code != null ? lastExit.code : "?",
                        })}
                    </div>
                )}
                {exitTone === "legacy" && lastExit && (
                    <div className="game-status-meta">
                        {t("sections.game.lastExit", {
                            reason: t(
                                `sections.game.exitReason.${lastExit.reason}`,
                                lastExit.reason
                            ),
                        })}
                        {lastExit.code != null ? ` (code ${lastExit.code})` : ""}
                    </div>
                )}
            </div>

            <div className="game-button-row">
                <button
                    className="resolution-button"
                    onClick={() => run("start")}
                    disabled={busy || running}
                    title={t("sections.game.startHint", "Launch the client on the host")}
                >
                    {pending === "start"
                        ? t("sections.game.starting", "Starting…")
                        : t("sections.game.start", "Start")}
                </button>
                <button
                    className="resolution-button"
                    onClick={() => run("stop")}
                    disabled={busy || !running}
                    title={t(
                        "sections.game.stopHint",
                        "Kills the process. Quit the world in-game first — this is not a save."
                    )}
                >
                    {pending === "stop"
                        ? t("sections.game.stopping", "Stopping…")
                        : t("sections.game.stop", "Stop")}
                </button>
                <button
                    className="resolution-button"
                    onClick={() => run("restart")}
                    disabled={busy}
                    title={t("sections.game.restartHint", "Stop (if running), then start again")}
                >
                    {pending === "restart"
                        ? t("sections.game.restarting", "Restarting…")
                        : t("sections.game.restart", "Restart")}
                </button>
            </div>

            <div className="game-footnote">
                {t(
                    "sections.game.stopWarning",
                    "Stop ends the process; the client has no external graceful exit. Save and quit from inside the game first, or the world may be left half-written."
                )}
            </div>

            <div className="dev-setting-item">
                <div className="game-meta-row">
                    <span>
                        {crashCount > 0
                            ? t("sections.game.crashReports", { count: crashCount })
                            : t("sections.game.crashReportsNone", "No crash reports")}
                    </span>
                    {crashCount > 0 && (
                        <a
                            className="game-link"
                            href={withSessionToken(apiUrl("/api/files/"))}
                            target="_blank"
                            rel="noreferrer"
                            title={t(
                                "sections.game.crashHint",
                                "Opens the file browser. Crash reports sit under the save's crash-reports/ folder."
                            )}
                        >
                            {t("sections.game.openCrashDir", "Open files")}
                        </a>
                    )}
                </div>
            </div>

            {errorKey && (
                <div className="game-error">
                    <div className="game-error-headline">{t(errorKey, "Request failed")}</div>
                    {errorDetail && <div className="game-error-detail">{errorDetail}</div>}
                </div>
            )}
        </>
    );
}
