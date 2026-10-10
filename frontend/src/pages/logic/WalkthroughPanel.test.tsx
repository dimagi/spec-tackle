// frontend/src/pages/logic/WalkthroughPanel.test.tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { LogicBlock, Trace, WalkInput, WalkState } from "../../api/types";
import type { WalkRun } from "./useWalk";
import { WalkthroughPanel } from "./WalkthroughPanel";

const b = (id: string, label: string, kind: LogicBlock["kind"] = "step"): LogicBlock => ({ id, label, kind, change: "added", next: [] });
const BLOCKS = [b("send", "Form is sent", "entry"), b("save", "Save the visit"), b("drop", "Drop the queue", "exit"), b("job", "Nightly job", "entry")];
const BY_ID = new Map(BLOCKS.map((x) => [x.id, x]));
const STARTING: WalkInput[] = [
  { name: "body", description: "The JSON request body", value: { status: "final" } },
  { name: "user", description: "The signed-in user", value: { id: 12 } },
];
const TRACE: Trace = {
  id: "t1", mapId: "m1", entryId: "send", inputs: STARTING, proposed: true, usedAt: "",
  steps: [
    { blockId: "send", input: { body: { status: "final" } }, output: { payload: "<img src=x onerror=alert(1)>" }, note: "Parses <b>the</b> body." },
    { blockId: "save", input: { visit: 7 }, output: { visit: 7, saved: true }, note: "Saves it.", assumed: ["Visit 7 exists"],
      effects: [{ kind: "external", note: "Posts the visit to the sync webhook (app/q.py:2)" }] },
    { blockId: "drop", input: {}, output: { raises: "KeyError('q')" }, note: "Clears it.",
      danger: [{ note: "Posts every queued form to an unknown host (app/q.py:9)" }],
      effects: [{ kind: "destructive", note: "Deletes every queued form (app/q.py:9)" }, { kind: "external", note: "Calls out (app/q.py:8)" }] },
  ],
  outcome: { kind: "error", message: "Raised KeyError: 'q'" },
};

function walkRun(over: Partial<WalkRun> = {}, data: Partial<WalkState> = {}): WalkRun {
  return {
    data: { trace: TRACE, starting: STARTING, running: false, error: null, ...data },
    loadError: null, progress: null, error: null, posting: false, run: vi.fn(async () => {}), retry: vi.fn(async () => {}), ...over,
  };
}

function Harness({ walk, onShowCode = vi.fn(), onEntry = vi.fn() }: { walk: WalkRun; onShowCode?: () => void; onEntry?: () => void }) {
  const [step, setStep] = useState(0);
  return (
    <WalkthroughPanel entries={[BLOCKS[0], BLOCKS[3]]} entry="send" onEntry={onEntry} blocks={BY_ID} walk={walk}
      step={step} onStep={setStep} onShowCode={onShowCode} onClose={vi.fn()} />
  );
}

const panel = () => screen.getByRole("complementary", { name: "Walkthrough" });

test("proposing shows progress and the privacy note", () => {
  render(<Harness walk={walkRun({ progress: "Reading app/visits.py" }, { trace: null, starting: null, running: true })} />);
  expect(screen.getByText("Reading app/visits.py")).toBeInTheDocument();
  expect(screen.getByText(/Private: runs on your machine/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Next/ })).toBeNull();
});

test("tracing new inputs keeps the old trace and disables Run", async () => {
  render(<Harness walk={walkRun({ progress: "Writing the trace…" })} />);
  expect(screen.getByText("Writing the trace…")).toBeInTheDocument();
  expect(screen.getByText("Parses <b>the</b> body.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /^Inputs/ }));
  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
});

test("failure shows the error and Try again", async () => {
  const walk = walkRun({ error: "Claude's walkthrough didn't pass validation: x" }, { trace: null });
  render(<Harness walk={walk} />);
  expect(screen.getByText(/didn't pass validation/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(walk.retry).toHaveBeenCalledTimes(1);
  expect(walk.run).not.toHaveBeenCalled();
});

test("stepping with buttons and arrow keys, ignoring keys while typing", async () => {
  render(<Harness walk={walkRun()} />);
  expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Prev/ })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: /Next/ }));
  expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
  await userEvent.keyboard("{ArrowRight}");
  expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
  await userEvent.keyboard("{ArrowLeft}");
  expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /^Inputs/ }));
  const box = screen.getByRole("textbox", { name: "body" });
  await userEvent.click(box);
  await userEvent.keyboard("{ArrowRight}{ArrowLeft}");
  expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Back to step 1" }));
  expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
});

test("inputs are collapsed with a trace, invalid JSON disables Run, edits show, Reset restores", async () => {
  const walk = walkRun();
  render(<Harness walk={walk} />);
  const toggle = screen.getByRole("button", { name: /^Inputs/ });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveTextContent("2 values · proposed by Claude");
  await userEvent.click(toggle);

  const box = screen.getByRole("textbox", { name: "user" });
  await userEvent.clear(box);
  await userEvent.type(box, "{{");
  expect(screen.getByText("Not valid JSON")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();

  await userEvent.clear(box);
  await userEvent.type(box, '{{"id": 13}');
  expect(toggle).toHaveTextContent("· edited");
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(walk.run).toHaveBeenLastCalledWith({ body: { status: "final" }, user: { id: 13 } });

  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(walk.run).toHaveBeenLastCalledWith({ body: { status: "final" }, user: { id: 12 } });
  expect(toggle).toHaveTextContent("proposed by Claude");
});

test("inputs are open when there's no trace yet", () => {
  render(<Harness walk={walkRun({ error: "failed" }, { trace: null })} />);
  expect(screen.getByRole("button", { name: /^Inputs/ })).toHaveAttribute("aria-expanded", "true");
});

test("step card: note, assumptions, changed keys, values as text, outcome", async () => {
  render(<Harness walk={walkRun()} />);
  // Claude's text is never HTML.
  expect(screen.getByText("Parses <b>the</b> body.")).toBeInTheDocument();
  expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
  expect(document.querySelector(".walk-json img")).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: /Next/ }));
  expect(screen.getByText("assumed: Visit 7 exists")).toBeInTheDocument();
  const output = screen.getByLabelText("Output");
  expect(within(output).getByText(/"saved": true/).closest("div")).toHaveClass("changed");
  expect(within(output).getByText(/"visit": 7/).closest("div")).not.toHaveClass("changed");

  await userEvent.click(screen.getByRole("button", { name: /Next/ }));
  expect(screen.getByText("Raised KeyError: 'q'")).toBeInTheDocument();
  expect(screen.getByLabelText("Output")).toHaveClass("error");
});

test("danger: flag on the step card and a banner on every step that jumps to it", async () => {
  render(<Harness walk={walkRun()} />);
  const banner = screen.getByRole("alert");
  expect(banner).toHaveTextContent("⚠ 1 step looks malicious");
  await userEvent.click(within(banner).getByRole("button", { name: "Drop the queue" }));
  expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
  const flag = screen.getByText("Posts every queued form to an unknown host (app/q.py:9)").closest(".walk-flag")!;
  expect(flag).toHaveTextContent("⚠ Looks malicious");
});

test("danger banner counts several steps", () => {
  const steps = TRACE.steps.map((s) => ({ ...s, danger: [{ note: "x" }] }));
  render(<Harness walk={walkRun({}, { trace: { ...TRACE, steps } })} />);
  expect(screen.getByRole("alert")).toHaveTextContent("⚠ 3 steps look malicious");
});

test("effects: a neutral summary, phrases that open step lists, and chips on the card", async () => {
  render(<Harness walk={walkRun()} />);
  const summary = screen.getByText(/^Effects:/);
  expect(summary).toHaveTextContent("Effects: 2 external calls · 1 deletes data");
  expect(summary.closest("[role=alert]")).toBeNull();
  await userEvent.click(within(summary).getByRole("button", { name: "1 deletes data" }));
  await userEvent.click(within(summary.parentElement!).getByRole("button", { name: "Drop the queue" }));
  expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
  const chip = screen.getByText(/Deletes every queued form/).closest(".walk-effect")!;
  expect(chip).toHaveTextContent("Deletes data · Deletes every queued form (app/q.py:9)");
  expect(screen.getByText(/Calls out/).closest(".walk-effect")).toHaveTextContent("External call");
});

test("a step with only effects shows nothing red", async () => {
  const steps = TRACE.steps.map(({ danger: _d, ...s }) => s);
  render(<Harness walk={walkRun({}, { trace: { ...TRACE, steps } })} />);
  expect(screen.queryByRole("alert")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "2 external calls" }));
  await userEvent.click(within(screen.getByText(/^Effects:/).parentElement!).getAllByRole("button", { name: "Save the visit" })[0]);
  expect(screen.getByText(/Posts the visit to the sync webhook/).closest(".walk-effect")).not.toBeNull();
  expect(document.querySelector(".walk-flag")).toBeNull();
});

test("no effects summary when there are none", () => {
  const steps = TRACE.steps.map(({ effects: _e, ...s }) => s);
  render(<Harness walk={walkRun({}, { trace: { ...TRACE, steps } })} />);
  expect(screen.queryByText(/^Effects:/)).toBeNull();
});

test("no banner when nothing is flagged", () => {
  render(<Harness walk={walkRun({}, { trace: { ...TRACE, steps: TRACE.steps.slice(0, 2) } })} />);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("Show code and the entry picker", async () => {
  const onShowCode = vi.fn();
  const onEntry = vi.fn();
  render(<Harness walk={walkRun()} onShowCode={onShowCode} onEntry={onEntry} />);
  await userEvent.click(within(panel()).getByRole("button", { name: /Show code/ }));
  expect(onShowCode).toHaveBeenCalledWith(BLOCKS[0]);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Entry" }), "job");
  expect(onEntry).toHaveBeenCalledWith("job");
});
