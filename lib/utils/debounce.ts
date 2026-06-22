/**
 * 防抖与节流工具。
 *
 * 画布的高频交互（拖动连续位移、缩放连续尺寸变化）不逐帧写库，而在交互结束或防抖
 * 窗口到期后再持久化（第 04 篇第三、五节）。这些工具是「防抖持久化」的基础设施。
 *
 * @module lib/utils/debounce
 */

/** 带取消与立即刷新能力的防抖函数。 */
export interface DebouncedFunction<A extends unknown[]> {
  (...args: A): void;
  /** 取消尚未触发的调用。 */
  cancel: () => void;
  /** 立即以最近一次参数触发（若有挂起调用）。 */
  flush: () => void;
  /** 是否有挂起调用。 */
  pending: () => boolean;
}

/**
 * 创建一个防抖函数：在最后一次调用后 `wait` 毫秒才真正执行。
 *
 * @param fn - 被防抖的函数
 * @param wait - 防抖窗口（毫秒）
 * @returns 带 cancel / flush / pending 的防抖函数
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
): DebouncedFunction<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;

  const invoke = (): void => {
    if (lastArgs) {
      const args = lastArgs;
      lastArgs = null;
      fn(...args);
    }
  };

  const debounced = (...args: A): void => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      invoke();
    }, wait);
  };

  debounced.cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };

  debounced.flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      invoke();
    }
  };

  debounced.pending = (): boolean => timer !== null;

  return debounced;
}

/**
 * 创建一个节流函数：在 `wait` 毫秒内至多执行一次（首次立即，末次补发）。
 *
 * @param fn - 被节流的函数
 * @param wait - 节流间隔（毫秒）
 * @returns 节流函数
 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
): (...args: A) => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;

  return (...args: A): void => {
    const now = Date.now();
    const remaining = wait - (now - last);
    lastArgs = args;
    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        if (lastArgs) fn(...lastArgs);
      }, remaining);
    }
  };
}
