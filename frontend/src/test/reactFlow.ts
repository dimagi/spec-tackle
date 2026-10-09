/**
 * jsdom does no layout, so React Flow never sees its nodes measured and keeps them hidden.
 * These stand-ins follow React Flow's own testing guide: sizes come from inline styles.
 */
export function stubReactFlowEnvironment() {
  class ResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      const el = target as HTMLElement;
      const contentRect = { width: parseFloat(el.style?.width) || 1000, height: parseFloat(el.style?.height) || 800 };
      this.callback([{ target, contentRect } as unknown as ResizeObserverEntry], this as unknown as globalThis.ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  class DOMMatrixReadOnly {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
      this.m22 = scale !== undefined ? Number(scale) : 1;
    }
  }
  vi.stubGlobal("ResizeObserver", ResizeObserver);
  vi.stubGlobal("DOMMatrixReadOnly", DOMMatrixReadOnly);
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get() { return parseFloat(this.style.height) || 1; } },
    offsetWidth: { configurable: true, get() { return parseFloat(this.style.width) || 1; } },
  });
  for (const type of ["mousedown", "mousemove", "mouseup"]) window.addEventListener(type, giveView, true);
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
}

/**
 * user-event's mouse events carry no window (`view` is a fixed null), and React Flow's drag code
 * (d3-drag) reads one. Swap such an event for a copy that has it.
 */
function giveView(e: Event) {
  if (!(e instanceof MouseEvent) || e.view) return;
  e.stopImmediatePropagation();
  const { clientX, clientY, screenX, screenY, button, buttons, ctrlKey, metaKey, shiftKey, altKey, detail } = e;
  const copy = new MouseEvent(e.type, {
    bubbles: e.bubbles, cancelable: e.cancelable, composed: e.composed,
    clientX, clientY, screenX, screenY, button, buttons, ctrlKey, metaKey, shiftKey, altKey, detail,
  });
  // jsdom's constructor rejects the test window as a view, so it goes on afterwards.
  Object.defineProperty(copy, "view", { value: window });
  if (!e.target!.dispatchEvent(copy)) e.preventDefault();
}
