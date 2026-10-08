import { render } from "@testing-library/react";
import { useRef } from "react";
import { useMarginEngine } from "./useMarginEngine";

function Harness() {
  const doc = useRef<HTMLElement>(null);
  const margin = useRef<HTMLDivElement>(null);
  useMarginEngine(doc, margin, [{ id: "T1", kind: "thread", path: "a.md", range: [1, 1], hidden: false }], null, 0);
  return (
    <>
      <main ref={doc} />
      <div ref={margin}><div data-card="T1" className="thread-card">card</div></div>
    </>
  );
}

test("cards are watched for size changes from their first render", () => {
  const observed: Element[] = [];
  vi.stubGlobal("ResizeObserver", class {
    observe(el: Element) { observed.push(el); }
    unobserve() {}
    disconnect() {}
  });

  const { container } = render(<Harness />);

  expect(observed).toContain(container.querySelector('[data-card="T1"]'));
  vi.unstubAllGlobals();
});
