/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Input lock panel: engage the host's keyboard lock, or release it with the
 * password, without walking over to the machine.
 *
 * The lock lives on the host, not in the browser: `kiosk/lock` stops the
 * server from forwarding Win/Alt+Tab/Ctrl+Esc to the remote desktop and writes
 * the two Explorer policies that would otherwise let them through. The person
 * staring at this panel is usually *not* sitting at the host — that is the
 * whole point — so "unlock" has to work from here or the lock is a trap.
 *
 * Two states matter more than the button labels:
 *
 * - `hook_installed === false` means the low-level keyboard hook never attached.
 *   The lock then looks engaged but the host's own keyboard still reaches the
 *   window manager. That is a silent lie, so it gets its own warning line.
 * - `policy_pending` means the registry values are written but the shell has not
 *   been restarted yet; the lock is partial until that lands.
 *
 * @module KioskPanel
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
    ControlError,
    controlErrorDetail,
    controlErrorKey,
    fetchHealth,
    postControl,
} from "../lib/control-api.js";

/** Same cadence as the game panel — both read the same health document. */
const POLL_INTERVAL_MS = 5000;

/**
 * @param {object} props
 * @param {(key: string, varsOrFallback?: object | string) => string} props.t
 * @param {(notice: {status: string, message: string, detail?: string}) => void} [props.notify]
 */
export default function KioskPanel({ t, notify }) {
    const [kiosk, setKiosk] = useState(null);
    const [errorKey, setErrorKey] = useState(null);
    const [errorDetail, setErrorDetail] = useState("");
    const [pending, setPending] = useState(null);
    const [password, setPassword] = useState("");
    const [passwordWrong, setPasswordWrong] = useState(false);
    const alive = useRef(true);

    const poll = useCallback(async () => {
        try {
            const health = await fetchHealth();
            if (!alive.current) return;
            if (health && typeof health === "object" && health.kiosk) {
                setKiosk(health.kiosk);
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
        const kick = setTimeout(poll, 0);
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") poll();
        }, POLL_INTERVAL_MS);
        return () => {
            alive.current = false;
            clearTimeout(kick);
            clearInterval(timer);
        };
    }, [poll]);

    const run = useCallback(
        async (action, body) => {
            setPending(action);
            setErrorKey(null);
            setErrorDetail("");
            try {
                const res = await postControl(`kiosk/${action}`, { body });
                if (res?.kiosk) {
                    setKiosk({ ...res.kiosk, enabled: true });
                }
                if (action === "unlock") {
                    setPassword("");
                    setPasswordWrong(false);
                }
                notify?.({
                    status: "end",
                    message: t(`sections.kiosk.notify.${action}`, `${action} ok`),
                });
                poll();
            } catch (err) {
                const key = controlErrorKey(err);
                const detail = controlErrorDetail(err);
                // `403` is doing double duty on this endpoint: wrong password,
                // and "no password configured at all". Same status, opposite
                // next step — the body is the only thing that separates them.
                const noPasswordConfigured =
                    err instanceof ControlError &&
                    err.status === 403 &&
                    typeof err.payload?.error === "string" &&
                    err.payload.error.includes("kiosk_password is not configured");
                const wrongPassword =
                    err instanceof ControlError &&
                    err.status === 403 &&
                    err.payload?.error === "wrong password";
                setPasswordWrong(wrongPassword);
                if (wrongPassword) {
                    setPassword("");
                }
                setErrorKey(
                    noPasswordConfigured ? "sections.kiosk.errors.noPassword" : key
                );
                setErrorDetail(detail);
                notify?.({
                    status: "error",
                    message: t(
                        noPasswordConfigured
                            ? "sections.kiosk.errors.noPassword"
                            : key,
                        "Request failed"
                    ),
                    detail,
                });
                if (err?.payload?.kiosk) {
                    setKiosk({ ...err.payload.kiosk, enabled: true });
                }
            } finally {
                if (alive.current) setPending(null);
            }
        },
        [notify, poll, t]
    );

    const submitUnlock = useCallback(
        (event) => {
            event.preventDefault();
            if (!password || pending) return;
            run("unlock", { password });
        },
        [password, pending, run]
    );

    if (!kiosk) {
        return (
            <div className="dev-setting-item">
                <span className="game-status-line">
                    <span className="game-status-dot" />
                    <span>{t("sections.kiosk.loading", "Reading status…")}</span>
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

    if (kiosk.enabled === false) {
        return (
            <div className="dev-setting-item">
                <div className="game-hint">
                    {t(
                        "sections.kiosk.disabledHint",
                        "Input locking is off on this host. Start stream-server with --kiosk to enable it."
                    )}
                </div>
            </div>
        );
    }

    const armed = kiosk.armed === true;
    const busy = pending !== null;
    const hookBroken = kiosk.hook && kiosk.hook_installed === false;
    const reason = kiosk.reason
        ? t(`sections.kiosk.reasonText.${kiosk.reason}`, kiosk.reason)
        : null;

    return (
        <>
            <div className="dev-setting-item">
                <span className="game-status-line" title={`armed=${String(armed)}`}>
                    <span className={`game-status-dot ${armed ? "is-locked" : "is-stopped"}`} />
                    <span className="game-status-label">
                        {armed
                            ? t("sections.kiosk.stateLocked", "Locked")
                            : t("sections.kiosk.stateUnlocked", "Unlocked")}
                    </span>
                    {reason && <span className="game-status-meta">{reason}</span>}
                </span>
                {kiosk.since_unix > 0 && armed && (
                    <div className="game-status-meta">
                        {t("sections.kiosk.since", {
                            time: new Date(kiosk.since_unix * 1000).toLocaleTimeString(),
                        })}
                    </div>
                )}
                {hookBroken && (
                    <div className="game-warn">
                        {t(
                            "sections.kiosk.hookBroken",
                            "The keyboard hook is not attached — the lock is on, but the host's own keyboard can still switch windows."
                        )}
                    </div>
                )}
                {kiosk.policy_pending && (
                    <div className="game-warn">
                        {t(
                            "sections.kiosk.policyPending",
                            "Registry policies were written; they take full effect after the shell restarts."
                        )}
                    </div>
                )}
            </div>

            <div className="game-button-row">
                <button
                    className="resolution-button"
                    onClick={() => run("lock")}
                    disabled={busy || armed}
                    title={t(
                        "sections.kiosk.lockHint",
                        "Swallow Win, Alt+Tab and Ctrl+Esc on the host's keyboard"
                    )}
                >
                    {pending === "lock"
                        ? t("sections.kiosk.locking", "Locking…")
                        : t("sections.kiosk.lock", "Lock input")}
                </button>
            </div>

            <form className="kiosk-unlock-row" onSubmit={submitUnlock}>
                <input
                    className="kiosk-password"
                    type="password"
                    value={password}
                    onChange={(e) => {
                        setPassword(e.target.value);
                        setPasswordWrong(false);
                    }}
                    placeholder={t("sections.kiosk.passwordPlaceholder", "Unlock password")}
                    autoComplete="current-password"
                    disabled={busy || !armed}
                    aria-label={t("sections.kiosk.passwordPlaceholder", "Unlock password")}
                />
                <button
                    className="resolution-button kiosk-unlock-button"
                    type="submit"
                    disabled={busy || !armed || password.length === 0}
                >
                    {pending === "unlock"
                        ? t("sections.kiosk.unlocking", "Unlocking…")
                        : t("sections.kiosk.unlock", "Unlock")}
                </button>
            </form>

            {passwordWrong && (
                <div className="game-warn">
                    {t("sections.kiosk.wrongPassword", "Wrong password.")}
                </div>
            )}

            <div className="game-footnote">
                {armed
                    ? t(
                          "sections.kiosk.lockedHint",
                          "While locked, the host swallows Win, Alt+Tab, Alt+F4 and Ctrl+Esc. Ctrl+Alt+Del still gets through — that is the OS, not this server."
                      )
                    : t(
                          "sections.kiosk.unlockedHint",
                          "Nothing is filtered right now. Locking affects the host's keyboard only; this page keeps working."
                      )}
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
