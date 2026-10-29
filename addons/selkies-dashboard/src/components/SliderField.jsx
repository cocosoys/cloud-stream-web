/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useRef, useState } from "react";
import { stopIndex } from "../../../selkies-web-core/lib/slider-stops.js";

/**
 * One settings row: the name of the setting, a box to type its value into, and
 * the dot slider under both.
 *
 * The slider alone cannot express every value it stands for. The frame-rate
 * track is sparse on purpose (a stop owns a band, so a thumb moved by a finger
 * still lands on a rate worth choosing), which leaves everything between two
 * stops unreachable; the audio bitrate slider only knows the rates the browser
 * was offered. The box beside the label is the precise entry for exactly those
 * cases: the slider stays the coarse control, the box commits the number the
 * user actually wants, and both write through the same `onChange`.
 *
 * Layout (see `.slider-field` in `styles/Overlay.css`, the shared style every
 * dot slider in the panel uses):
 *
 *     Frames per second             [ 144 ] FPS
 *     ──────────●─────────────────────────
 *
 * @param {Object} props
 * @param {string} props.id DOM id of the track; the label points at it.
 * @param {string} props.label The setting's name, without its value.
 * @param {?string} [props.note] Short remark after the name ("default").
 * @param {string} [props.unit] Unit shown in the entry ("FPS", "%", "kbps").
 * @param {number} props.value The live value, in the units `min`/`max` are in.
 * @param {?number[]} [props.stops]
 *     Sparse track values; the thumb positions itself on the nearest one and a
 *     drag commits a stop. Absent: the track runs `min`..`max` by `step`.
 * @param {?number} [props.uncapped]
 *     The value that means "no limit". Adds one position after the last stop,
 *     drawn and labelled as infinite, and an empty entry box reads as it.
 * @param {?boolean} [props.snap]
 *     With `stops`, round a typed value to the nearest stop (for controls whose
 *     consumer only accepts the listed values, e.g. the audio bitrate rates the
 *     browser was offered).
 * @param {?number} [props.index]
 *     The thumb's position, where the caller knows better than the nearest
 *     stop does — the frame-rate track holds one rate twice (a fixed choice and
 *     "match the display"), and only the caller knows which of the two is set.
 * @param {number} [props.scale] Entry multiplier, so 1 can read as "100 %".
 * @param {number} [props.decimals] Entry precision.
 * @param {function(number, ?number): void} props.onChange
 *     The committed value, and the stop index it came from where it came from
 *     the track (`null` for a typed value).
 * @param {boolean} [props.disabled]
 * @param {?string} [props.title] Tooltip for both controls.
 */
export default function SliderField({
    id,
    label,
    note = null,
    unit = "",
    value,
    stops = null,
    uncapped = null,
    snap = false,
    index = null,
    min,
    max,
    step = 1,
    scale = 1,
    decimals = 0,
    onChange,
    disabled = false,
    title,
}) {
    // The entry keeps what is being typed, and only what is being typed: a
    // value that arrives from the slider, from the server, or from another
    // panel while the box is not focused must still show up in it.
    const [draft, setDraft] = useState(null);
    /** Set by Escape, so the blur it causes does not commit what it cancelled. */
    const abandoned = useRef(false);

    const low = stops ? Math.min(...stops) : min;
    const high = stops ? Math.max(...stops) : max;
    const isUncapped = uncapped !== null && value === uncapped;
    const shown = draft !== null ? draft : format(value * scale, decimals, isUncapped);

    const clamp = (v) => Math.min(high, Math.max(low, v));

    const commit = (text) => {
        const trimmed = String(text).trim();
        if (trimmed === "") {
            // An empty box is how "no limit" reads once it has one: keep the
            // current value if this control has no such setting to fall back to.
            if (uncapped !== null) onChange(uncapped, null);
            return;
        }
        const parsed = parseFloat(trimmed.replace(",", "."));
        if (!Number.isFinite(parsed)) return;
        let next = clamp(parsed / scale);
        if (snap && stops) next = stops[stopIndex(stops, next)];
        onChange(next, null);
    };

    return (
        <div className="dev-setting-item slider-field">
            <div className="slider-field-head">
                <label htmlFor={id}>{label}</label>
                {note ? <span className="slider-field-note">{note}</span> : null}
                <span className={`slider-field-entry${disabled ? " is-disabled" : ""}`}>
                    <input
                        type="number"
                        className="slider-field-input"
                        inputMode="decimal"
                        aria-label={label}
                        title={title}
                        value={shown}
                        placeholder={uncapped !== null ? "∞" : undefined}
                        disabled={disabled}
                        // Any value the control's own range allows, not just the
                        // track's stops: an exact entry is the reason the box
                        // exists. A stopped control (`snap`) rounds on commit.
                        step="any"
                        onFocus={() => setDraft(shown)}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={(event) => {
                            // Escape abandons the edit, and blurring is how it
                            // leaves the box — without this flag the blur would
                            // commit the very text Escape just discarded.
                            if (!abandoned.current) commit(event.target.value);
                            abandoned.current = false;
                            setDraft(null);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                // The blur commits, once.
                                event.currentTarget.blur();
                            } else if (event.key === "Escape") {
                                abandoned.current = true;
                                setDraft(null);
                                event.currentTarget.blur();
                            }
                        }}
                    />
                    {unit ? <span className="slider-field-unit">{unit}</span> : null}
                </span>
            </div>
            <input
                type="range"
                id={id}
                title={title}
                disabled={disabled}
                min={stops ? 0 : min}
                max={stops ? stops.length - 1 + (uncapped !== null ? 1 : 0) : max}
                step={stops ? 1 : step}
                value={stops ? (index !== null ? index : trackIndex(stops, value, uncapped)) : value}
                onChange={(event) => {
                    const at = parseFloat(event.target.value);
                    if (!stops) {
                        onChange(at, null);
                    } else if (uncapped !== null && at >= stops.length) {
                        onChange(uncapped, at);
                    } else if (stops[at] !== undefined) {
                        onChange(stops[at], at);
                    }
                }}
            />
        </div>
    );
}

/**
 * The thumb position of `value` among `stops`, with the uncapped position
 * (one past the last stop) winning outright when that is what is set.
 * @param {number[]} stops
 * @param {number} value
 * @param {?number} uncapped
 * @returns {number}
 */
function trackIndex(stops, value, uncapped) {
    if (uncapped !== null && value === uncapped) return stops.length;
    return stopIndex(stops, value);
}

/**
 * A value as the entry shows it: scaled, at the control's precision, without
 * trailing zeros, and empty for "no limit" (its placeholder is the infinity).
 * @param {number} value
 * @param {number} decimals
 * @param {boolean} isUncapped
 * @returns {string}
 */
function format(value, decimals, isUncapped) {
    if (isUncapped) return "";
    if (!Number.isFinite(value)) return "";
    return String(Number(value.toFixed(decimals)));
}
