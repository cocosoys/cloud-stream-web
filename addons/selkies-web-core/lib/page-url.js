/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The page URL as the client reads and hands it on.
 *
 * Its fragment holds a keyword that picks the display or the sharing role
 * (`#display2-right`, `#shared`, `#player2`) and may hold the session token as
 * a `token=` item beside it (`#display2-right&token=<t>`), in either order.
 * Everything that reads the fragment reads the keyword alone
 * (`urlFragmentKeyword`), so no hash parser sees the token and none logs it; a
 * window this page opens for the session carries a fragment token on in its own
 * fragment (`fragmentWithSessionToken`), and a sharing link starts from the page
 * without any token (`shareablePageURL`).
 * @module
 */

/**
 * Splits the page URL's fragment into its keyword and its token.
 *
 * Items are `&`-separated; the token is the `token=` item, percent-decoded as a
 * query value is, and the keyword is the first other item.
 * @returns {{keyword: string, token: string}} The keyword with its `#`, or `''`
 *     without one, and the token, or `''`.
 */
export function readUrlFragment() {
    let keyword = '';
    let token = '';
    if (typeof window === 'undefined' || !window.location) return { keyword, token };
    const fragment = String(window.location.hash || '').replace(/^#/, '');
    for (const item of fragment.split('&')) {
        if (item.startsWith('token=')) {
            if (!token) {
                try {
                    token = new URLSearchParams(item).get('token') || '';
                } catch (_) { /* an undecodable item carries no token */ }
            }
        } else if (!keyword && item) {
            keyword = `#${item}`;
        }
    }
    return { keyword, token };
}

/**
 * The display or sharing keyword of the page URL's fragment, without the token
 * that may ride beside it.
 * @returns {string} The keyword with its `#`, or `''` when there is none.
 */
export function urlFragmentKeyword() {
    return readUrlFragment().keyword;
}

/**
 * The display a fragment keyword selects.
 *
 * `#displayN` is display N, 2 to `max`: the number the server's
 * `DisplayKey::from_hello` uses, where `display2` is the second output
 * (DXGI index 1). `#display1` is refused rather than wrapped to the primary —
 * every other fragment already means the primary, and silently serving it
 * would hide a typo behind a picture that looks perfectly fine.
 *
 * A `-position` suffix (`#display3-left`) is the second display's layout hint,
 * which is meaningless without a second page; it is returned anyway so the
 * caller can pass it on unchanged.
 * @param {string} keyword A keyword from {@link urlFragmentKeyword}, with `#`.
 * @param {number} [max=8] Highest display number this page serves.
 * @returns {{displayId: string, position: (string|null)}|null} The selection,
 *     or `null` when the keyword is not a display keyword in range.
 */
export function displayFromKeyword(keyword, max = 8) {
    const match = /^#display(\d+)(?:-(left|right|up|down))?$/.exec(String(keyword || ''));
    if (!match) return null;
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 2 || index > max) return null;
    return { displayId: `display${index}`, position: match[2] || null };
}

/**
 * The fragment for another page of this session, such as a secondary display's
 * window: the keyword, then the page's token when it came in the fragment. A
 * query token stays in the query, which the caller keeps.
 * @param {string} keyword The keyword without its `#` (`display2-right`).
 * @returns {string} `#keyword`, with `&token=` added for a fragment token.
 */
export function fragmentWithSessionToken(keyword) {
    const { token } = readUrlFragment();
    return token ? `#${keyword}&token=${encodeURIComponent(token)}` : `#${keyword}`;
}

/**
 * The page URL a sharing link starts from: this page without its fragment and
 * without a `token` query parameter, so a link handed to someone else never
 * carries the sharer's own credential.
 * @returns {string}
 */
export function shareablePageURL() {
    if (typeof window === 'undefined' || !window.location) return '';
    try {
        const url = new URL(window.location.href);
        url.searchParams.delete('token');
        url.hash = '';
        return url.href;
    } catch (_) {
        return `${window.location.origin}${window.location.pathname}`;
    }
}
