import { render, screen, waitFor } from "@testing-library/react";
import type { ChangeNode } from "../../api/map";
import { ChangeGraph } from "./ChangeGraph";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; constructor() {} });
});
afterAll(() => vi.unstubAllGlobals());

const node = (id: string): ChangeNode => ({
  id, file: id.split("::")[0], label: id.split("::")[1] + "()", kind: "function", change: "modified",
  signatureChanged: false, additions: 1, deletions: 0, lines: [1, 2], baseLines: [1, 2],
});
const props = { selected: null, hover: null, onHover: () => {}, onSelect: () => {}, initialCollapsed: [] };

test("hiding a change while a layout is on screen doesn't crash", async () => {
  const a = node("a.py::send"), t = node("tests/t.py::test_send");
  const { rerender } = render(<div style={{ width: 800, height: 600 }}><ChangeGraph nodes={[a, t]} edges={[]} {...props} /></div>);
  await waitFor(() => expect(screen.queryByText("Laying out…")).toBeNull());

  rerender(<div style={{ width: 800, height: 600 }}><ChangeGraph nodes={[a]} edges={[]} {...props} /></div>);

  await waitFor(() => expect(document.querySelector('[data-id="tests/t.py::test_send"]')).toBeNull());
  expect(document.querySelector('[data-id="a.py::send"]')).not.toBeNull();
});

test("arrows leave a change from below and enter what it uses from above", async () => {
  render(<div style={{ width: 800, height: 600 }}><ChangeGraph nodes={[node("a.py::send")]} edges={[]} {...props} /></div>);
  await waitFor(() => expect(screen.queryByText("Laying out…")).toBeNull());
  const card = document.querySelector('[data-id="a.py::send"]')!;
  expect(card.querySelector(".react-flow__handle-bottom.source")).not.toBeNull();
  expect(card.querySelector(".react-flow__handle-top.target")).not.toBeNull();
});
