import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MapNode } from "../../api/map";
import { FileNodeCard } from "./MapGraph";

const changed: MapNode = {
  id: "shop/sync.py", hop: 0, phase: "core", inGraph: true, status: "modified", additions: 40, deletions: 3, tag: "contract",
  symbols: [
    { name: "send", kind: "function", change: "modified", signatureChanged: true },
    { name: "resubmit", kind: "function", change: "removed", signatureChanged: false },
  ],
};
const dependent: MapNode = {
  id: "shop/views.py", hop: 1, phase: "edges", inGraph: true, references: ["send"], indirectCount: 2, indirect: ["shop/admin.py", "shop/urls.py"],
};

test("a changed file expands into its changed symbols", async () => {
  render(<FileNodeCard node={changed} maxSize={43} highlighted={false} />);
  expect(screen.queryByText("send()")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /symbols/ }));
  expect(screen.getByText("send()")).toBeInTheDocument();
  expect(screen.getByText("signature changed")).toBeInTheDocument();
  expect(screen.getByText("removed")).toBeInTheDocument();
});

test("an unchanged dependent says what it uses and lists its indirect importers on demand", async () => {
  render(<FileNodeCard node={dependent} maxSize={43} highlighted={false} />);
  expect(screen.getByText("unchanged · uses send")).toBeInTheDocument();
  expect(screen.queryByText("shop/admin.py")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "+2 indirect" }));
  expect(screen.getByText("shop/admin.py")).toBeInTheDocument();
});

test("the node under the reading-path cursor is highlighted", () => {
  const { container } = render(<FileNodeCard node={changed} maxSize={43} highlighted />);
  expect(container.firstChild).toHaveClass("is-hl");
});

test("one symbol is singular", () => {
  render(<FileNodeCard node={{ ...changed, symbols: [changed.symbols![0]] }} maxSize={43} highlighted={false} />);
  expect(screen.getByRole("button", { name: "▸ 1 symbol" })).toBeInTheDocument();
});
