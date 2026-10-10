import { render, screen } from "@testing-library/react";
import type { LogicBlock } from "../../api/types";
import { walkMarks } from "../../lib/walkthrough";
import { stubReactFlowEnvironment } from "../../test/reactFlow";
import FlowChart from "./FlowChart";

const BLOCKS: LogicBlock[] = [
  { id: "send", label: "Form is sent", kind: "entry", change: "unchanged", next: [{ to: "drop" }] },
  { id: "drop", label: "Drop the queue", kind: "exit", change: "added", next: [] },
  { id: "alt", label: "Another path", kind: "step", change: "added", next: [] },
];
const STEPS = [
  { blockId: "send", input: {}, output: {}, note: "n" },
  { blockId: "drop", input: {}, output: {}, note: "n", danger: [{ note: "Sends secrets out" }] },
  { blockId: "alt", input: {}, output: {}, note: "n", effects: [{ kind: "external" as const, note: "Calls out" }, { kind: "destructive" as const, note: "Deletes it" }] },
];

beforeEach(() => stubReactFlowEnvironment());
afterEach(() => vi.unstubAllGlobals());

test("walk marks ring the current step, number visited ones, flag danger and dim the rest", async () => {
  const walk = { marks: walkMarks(BLOCKS, STEPS, 0), taken: new Set<string>(), path: new Set(["send>drop#0"]) };
  render(<FlowChart blocks={BLOCKS} expanded={new Set()} selected={null} walk={walk} onActivate={vi.fn()} onFailed={vi.fn()} />);

  const send = await screen.findByRole("button", { name: /^Form is sent/ });
  expect(send).toHaveClass("walk-current");
  expect(send.querySelector(".walk-step")).toHaveTextContent("1");

  const drop = screen.getByRole("button", { name: /^Drop the queue/ });
  expect(drop).not.toHaveClass("walk-visited");
  expect(drop.querySelector(".walk-danger")).toHaveTextContent("⚠");
  expect(drop).toHaveAccessibleName(/looks malicious/);
  expect(drop.querySelector(".walk-effects")).toBeNull();

  const alt = screen.getByRole("button", { name: /^Another path/ });
  expect(alt.querySelector(".walk-effects")).toHaveTextContent("ⓘ");
  expect(alt.querySelector(".walk-danger")).toBeNull();
  expect(alt).toHaveAccessibleName(/effects: External call, Deletes data/);
  expect(alt).not.toHaveAccessibleName(/looks malicious/);
});

test("without a walk nothing is marked", async () => {
  render(<FlowChart blocks={BLOCKS} expanded={new Set()} selected={null} onActivate={vi.fn()} onFailed={vi.fn()} />);
  const send = await screen.findByRole("button", { name: /^Form is sent/ });
  expect(send.className).not.toMatch(/walk-/);
  expect(document.querySelector(".walk-step, .walk-danger, .walk-effects")).toBeNull();
});
