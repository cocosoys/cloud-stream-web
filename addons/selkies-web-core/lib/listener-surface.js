/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * 监听面骨架：让页面上每一个"外部能触发的东西"都有一个名字，并且能被一个
 * 函数统一拦下。
 *
 * 这个模块只做归类与拦截，不知道任何权限模型。默认没有拦截器，一切照旧；
 * 上层项目（webgame 等）在启动时 `setInterceptor(fn)` 就能拿到按键、指针、
 * 剪贴板、麦克风、摄像头、文件上传的每一次触发，并决定放不放行。
 *
 * 面的名字与后端 `security::EventKind::label()` 保持一致 —— 同一个用户在
 * 前后端各被拦一次时，日志里应该是同一个词，否则对不上账。后端的标签是
 * `input.keyboard`、`clipboard.write` 这种形态，这里照抄。
 *
 * 三个刻意的选择：
 *
 * 1. **默认放行**。没有拦截器时 `admit()` 直接返回 true，不产生任何开销
 *    （一次 `if`）。骨架上线的这一版不能改变现有行为。
 * 2. **失败即拒绝**。拦截器抛异常时按拒绝处理并写一条 console.error ——
 *    权限判断出错时"悄悄放行"是最糟的默认值。
 * 3. **计数而不采样**。`stats()` 给出每个面的触发与拒绝次数。鉴权做起来之后，
 *    这就是"哪些面在被用、哪些在被挡"的唯一凭据；不做计数的话，只能靠猜。
 * @module
 */

/** 面。字符串值即日志标签，与后端 `security::EventKind::label()` 对齐。 */
export const Surface = Object.freeze({
    KEYBOARD: 'input.keyboard',
    POINTER: 'input.pointer',
    TOUCH: 'input.touch',
    GAMEPAD: 'input.gamepad',
    WHEEL: 'input.wheel',
    TEXT: 'input.text',
    CLIPBOARD_READ: 'clipboard.read',
    CLIPBOARD_WRITE: 'clipboard.write',
    MEDIA_MIC: 'media.mic-in',
    MEDIA_WEBCAM: 'media.webcam-in',
    FILE_UPLOAD: 'file.upload',
    /** 页面生命周期：可见性、全屏、前后台切换。 */
    LIFECYCLE: 'lifecycle',
    /** 视口与布局：resize、方向、指针锁定。 */
    VIEWPORT: 'viewport',
});

/**
 * DOM 事件名 → 面。
 *
 * 写成表而不是正则，是因为这张表就是"这个页面到底监听什么"的清单：新增
 * 监听时会在 `addListener` 处被归到 `null`，而 `null` 会在第一次触发时
 * 报一次 warn（见 `admit`），不会静默漏掉。
 */
const DOM_SURFACE = new Map([
    ['keydown', Surface.KEYBOARD],
    ['keyup', Surface.KEYBOARD],
    ['keypress', Surface.KEYBOARD],
    ['pointerdown', Surface.POINTER],
    ['pointermove', Surface.POINTER],
    ['pointerup', Surface.POINTER],
    ['pointercancel', Surface.POINTER],
    ['pointerrawupdate', Surface.POINTER],
    ['mousedown', Surface.POINTER],
    ['mousemove', Surface.POINTER],
    ['mouseup', Surface.POINTER],
    ['wheel', Surface.WHEEL],
    ['touchstart', Surface.TOUCH],
    ['touchmove', Surface.TOUCH],
    ['touchend', Surface.TOUCH],
    ['touchcancel', Surface.TOUCH],
    ['touchgamepadinput', Surface.GAMEPAD],
    ['gamepadconnected', Surface.GAMEPAD],
    ['gamepaddisconnected', Surface.GAMEPAD],
    ['compositionstart', Surface.TEXT],
    ['compositionupdate', Surface.TEXT],
    ['compositionend', Surface.TEXT],
    ['textInput', Surface.TEXT],
    ['input', Surface.TEXT],
    ['paste', Surface.CLIPBOARD_WRITE],
    ['copy', Surface.CLIPBOARD_READ],
    ['cut', Surface.CLIPBOARD_READ],
    ['visibilitychange', Surface.LIFECYCLE],
    ['pagehide', Surface.LIFECYCLE],
    ['pageshow', Surface.LIFECYCLE],
    ['freeze', Surface.LIFECYCLE],
    ['resume', Surface.LIFECYCLE],
    ['beforeunload', Surface.LIFECYCLE],
    ['resize', Surface.VIEWPORT],
    ['orientationchange', Surface.VIEWPORT],
    ['pointerlockchange', Surface.VIEWPORT],
    ['fullscreenchange', Surface.VIEWPORT],
    ['loadedmetadata', Surface.VIEWPORT],
]);

/** 由事件名取面；未登记返回 null（`admit` 会告警一次）。 */
export function surfaceOfEvent(type) {
    return DOM_SURFACE.get(type) ?? null;
}

/** 每个面一张 `{allowed, denied}` 计数表。 */
const counters = new Map();
/** 已就"这个事件名没登记"告警过的集合，避免每次触发都刷 console。 */
const unclassifiedWarned = new Set();

let interceptor = null;
let interceptorName = 'none';

function bump(surface, verdict) {
    const key = surface ?? 'unclassified';
    let row = counters.get(key);
    if (!row) {
        row = { allowed: 0, denied: 0 };
        counters.set(key, row);
    }
    row[verdict] += 1;
}

/**
 * 装一个拦截器。传 `null` 卸载。
 *
 * 签名：`(surface, detail) => boolean | 'allow' | 'deny'`。`detail` 是
 * `{ type, event }`，`event` 在非 DOM 触发（麦克风、上传）时为 undefined。
 *
 * 拦截器必须是**同步**的：它跑在 `pointerrawupdate` 这种每帧几十次的热路径
 * 上，返回 Promise 等于把输入延迟交给微任务队列。
 *
 * @param {?((surface: string, detail: object) => (boolean|string))} fn
 * @param {string} [name] 记进日志的名字，便于确认"到底装的是哪个策略"。
 */
export function setInterceptor(fn, name = 'custom') {
    if (fn !== null && typeof fn !== 'function') {
        throw new TypeError('setInterceptor expects a function or null');
    }
    interceptor = fn;
    interceptorName = fn ? name : 'none';
    if (fn) {
        console.info(`[surface] interceptor installed: ${interceptorName}`);
    }
}

/** 当前拦截器名（未装时为 `none`）。 */
export function interceptorLabel() {
    return interceptorName;
}

/**
 * 裁决一次触发。
 *
 * - 没装拦截器：直接放行，不计表（否则每个指针事件都要写一次 Map，白白发热）。
 * - 拦截器返回 `false` 或 `'deny'`：拒绝。
 * - 拦截器抛异常：拒绝，并记一次 error —— 失败关闭。
 *
 * @param {?string} surface 面，未知传 null
 * @param {{type?: string, event?: Event}} detail
 * @returns {boolean} 是否继续派发
 */
export function admit(surface, detail = {}) {
    if (!interceptor) return true;

    if (surface === null) {
        const type = detail.type ?? '?';
        if (!unclassifiedWarned.has(type)) {
            unclassifiedWarned.add(type);
            console.warn(`[surface] unclassified event "${type}" — add it to DOM_SURFACE`);
        }
        surface = 'unclassified';
    }

    let verdict;
    try {
        verdict = interceptor(surface, detail);
    } catch (err) {
        bump(surface, 'denied');
        console.error(`[surface] interceptor threw on ${surface}, denying`, err);
        return false;
    }
    const allowed = verdict !== false && verdict !== 'deny';
    bump(surface, allowed ? 'allowed' : 'denied');
    return allowed;
}

/**
 * 注册一个受管的监听。返回解绑函数。
 *
 * 与直接 `addEventListener` 的唯一区别：回调外面包了一层 `admit`。事件对象
 * 原样传下去，`preventDefault`/`stopPropagation` 的行为不变。
 *
 * @param {EventTarget} target
 * @param {string} type
 * @param {(event: Event) => any} handler
 * @param {AddEventListenerOptions|boolean} [options]
 * @param {?string} [surface] 显式指定面（DOM 事件名未登记时用）
 * @returns {() => void}
 */
export function attach(target, type, handler, options = false, surface = undefined) {
    const resolved = surface !== undefined ? surface : surfaceOfEvent(type);
    const wrapped = (event) => {
        if (!admit(resolved, { type, event })) return undefined;
        return handler(event);
    };
    target.addEventListener(type, wrapped, options);
    return () => target.removeEventListener(type, wrapped, options);
}

/** 非 DOM 的面（麦克风、摄像头、上传）在动作之前显式问一次。 */
export function admitAction(surface, detail = {}) {
    return admit(surface, detail);
}

/** 每个面的计数快照，按面的名字排序。 */
export function stats() {
    return [...counters.entries()]
        .map(([surface, row]) => ({ surface, ...row }))
        .sort((a, b) => a.surface.localeCompare(b.surface));
}

/** 清空计数（测试与"从这一刻开始观察"用）。 */
export function resetStats() {
    counters.clear();
    unclassifiedWarned.clear();
}
