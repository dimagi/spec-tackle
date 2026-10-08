import { streamStep, STARTED } from "./claudeStream";

test("text accumulates and tool updates replace the status", () => {
  let live = STARTED;
  live = streamStep(live, { type: "tool", text: "Reading docs/a.md" })!;
  live = streamStep(live, { type: "text", text: "The " })!;
  live = streamStep(live, { type: "text", text: "answer" })!;
  expect(live).toEqual({ tool: "Reading docs/a.md", text: "The answer" });
});

test("any other event ends the stream", () => {
  expect(streamStep(STARTED, { type: "done", text: "" })).toBeNull();
  expect(streamStep(STARTED, { type: "error", text: "boom" })).toBeNull();
});
