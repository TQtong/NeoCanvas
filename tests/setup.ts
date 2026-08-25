import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

/** JSDOM 缺少 ResizeObserver，画布组件测试使用可控的无副作用实现。 */
class TestResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

globalThis.ResizeObserver = TestResizeObserver;
