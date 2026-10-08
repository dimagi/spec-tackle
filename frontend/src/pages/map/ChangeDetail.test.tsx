import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChangeNode, Changes } from "../../api/map";
import { ChangeDetail } from "./ChangeDetail";

const node = (id: string, over: Partial<ChangeNode> = {}): ChangeNode => ({
  id, file: id.split("::")[0], label: id.split("::")[1] + "()", kind: "function", change: "modified",
  signatureChanged: false, additions: 1, deletions: 0, lines: [1, 2], baseLines: [1, 2], ...over,
});
const changes: Changes = {
  nodes: [node("a.py::send", { signatureChanged: true }), node("b.py::retry", { change: "added" }), node("c.py::run", { change: "caller", kind: "caller" })],
  edges: [
    { from: "a.py::send", to: "b.py::retry", type: "uses", line: 3 },
    { from: "c.py::run", to: "a.py::send", type: "breaks-signature", line: 9 },
  ],
  readingPath: [],
};

test("shows what a change uses and what uses it, flagging likely breakage", async () => {
  const onGo = vi.fn();
  render(<ChangeDetail node={changes.nodes[0]} changes={changes} diff={null} onGo={onGo} onOpenReview={vi.fn()} />);

  expect(screen.getByText("signature changed")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "retry()" })).toBeInTheDocument();
  const caller = screen.getByRole("button", { name: "run()" });
  expect(caller).toHaveClass("warn");
  await userEvent.click(caller);
  expect(onGo).toHaveBeenCalledWith("c.py::run");
});

test("a moved change says where it came from", () => {
  render(<ChangeDetail node={node("b.py::total", { change: "moved", from: { file: "a.py", name: "sum_up" } })} changes={changes} diff={null} onGo={vi.fn()} onOpenReview={vi.fn()} />);
  expect(screen.getByText("was a.py · sum_up")).toBeInTheDocument();
});
