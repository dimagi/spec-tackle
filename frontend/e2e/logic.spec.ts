import { expect, test, type Locator } from "@playwright/test";

/** Wait out the chart's fit-to-view and layout animations: until `el` stops moving. */
async function settled(el: Locator) {
  let last = "";
  await expect.poll(async () => {
    const was = last;
    last = JSON.stringify(await el.boundingBox());
    return was === last;
  }, { intervals: [400] }).toBe(true);
}

test.beforeEach(async ({ request }) => {
  await request.post("/e2e/reset");
});

test("generate a logic map, expand it, open a function and jump to it in Review", async ({ page }) => {
  await page.goto("/pr/o/r/7");
  await page.getByRole("tab", { name: "Logic view" }).click();
  await expect(page).toHaveURL(/\?view=logic$/);

  await page.getByRole("button", { name: "Generate logic map" }).click();
  await expect(page.getByText("Failed form submissions are retried with backoff")).toBeVisible();

  const chart = page.locator(".logic-flow");
  // A plain click on a block with steps inside shows all their code.
  await chart.getByRole("button", { name: /Retry failures ⊕/ }).click();
  const parent = page.getByRole("complementary", { name: "Retry failures" });
  await expect(parent.getByText("Back off and resend")).toBeVisible();
  await expect(parent.getByText("docs/retry.md:5–5")).toBeVisible();
  await page.keyboard.press("Escape");

  // Ctrl/⌘-click expands it.
  await chart.getByRole("button", { name: /Retry failures ⊕/ }).click({ modifiers: ["ControlOrMeta"] });
  await expect(chart.getByRole("button", { name: /⊖ Retry failures/ })).toBeVisible();

  await chart.getByRole("button", { name: /Back off and resend/ }).click();
  const panel = page.getByRole("complementary", { name: "Back off and resend" });
  await expect(panel.getByText("docs/retry.md:5–5")).toBeVisible();
  await expect(panel.locator(".logic-line.changed")).toContainText("Failures are retried with backoff.");

  await panel.getByRole("button", { name: "Show in Code view" }).click();
  await expect(page).toHaveURL(/\/pr\/o\/r\/7$/);
  await expect(page.locator("#doc")).toBeVisible();
  await expect(page.locator(".line-flash")).toContainText("Failures are retried with backoff.");
  // A new spec file only has its Document view, so that's where the line is shown.
  await expect(page.locator('section.file[data-path="docs/retry.md"] .view[data-view="rendered"]')).toBeVisible();

  // Back to Logic: the map and the expanded block are still there.
  await page.getByRole("tab", { name: "Logic view" }).click();
  await expect(chart.getByRole("button", { name: /⊖ Retry failures/ })).toBeVisible();
});

test("blocks can be dragged around the map, and a drag doesn't open the block", async ({ page }) => {
  await page.goto("/pr/o/r/7?view=logic");
  await page.getByRole("button", { name: "Generate logic map" }).click();

  const chart = page.locator(".logic-flow");
  const card = chart.getByRole("button", { name: /Retry failures ⊕/ });
  const node = card.locator("xpath=ancestor::div[contains(@class, 'react-flow__node ')][1]");
  await settled(node);
  const before = (await node.boundingBox())!;
  const viewport = await chart.locator(".react-flow__viewport").getAttribute("style");

  await card.hover();
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 120, before.y + before.height / 2 + 60, { steps: 8 });
  await page.mouse.up();

  const after = (await node.boundingBox())!;
  // It keeps up with the pointer (less the first step, which starts the drag).
  expect(after.x - before.x).toBeGreaterThan(100);
  expect(after.y - before.y).toBeGreaterThan(50);
  // The block moved, not the chart, and the drag didn't open its code.
  await expect(chart.locator(".react-flow__viewport")).toHaveAttribute("style", viewport!);
  await expect(page.getByRole("complementary", { name: "Retry failures" })).toHaveCount(0);

  // A plain click still opens it.
  await card.click();
  await expect(page.getByRole("complementary", { name: "Retry failures" })).toBeVisible();

  await page.keyboard.press("Escape");

  // A step dragged past its group's edge grows the group.
  await card.click({ modifiers: ["ControlOrMeta"] });
  const group = chart.getByRole("button", { name: /⊖ Retry failures/ });
  const step = chart.getByRole("button", { name: /Back off and resend/ });
  await settled(step);
  const g = (await group.boundingBox())!;
  const s = (await step.boundingBox())!;
  await step.hover();
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 + 200, s.y + s.height / 2, { steps: 8 });
  await page.mouse.up();
  expect((await group.boundingBox())!.width).toBeGreaterThan(g.width + 100);
});

test("walk through the map, see danger, edit inputs and hit the cache", async ({ page }) => {
  await page.goto("/pr/o/r/7?view=logic");
  await page.getByRole("button", { name: "Generate logic map" }).click();
  await expect(page.getByText("Failed form submissions are retried with backoff")).toBeVisible();

  await page.getByRole("button", { name: /Walkthrough/ }).click();
  await expect(page).toHaveURL(/walk=send/);
  const panel = page.getByRole("complementary", { name: "Walkthrough" });
  await expect(panel.getByText("The first send fails.")).toBeVisible();
  const chart = page.locator(".logic-flow");
  await expect(chart.getByRole("button", { name: /^Form is sent/ })).toHaveClass(/walk-current/);
  // The loop holding step 2 is expanded for the walkthrough.
  await expect(chart.getByRole("button", { name: /⊖ Retry failures/ })).toBeVisible();

  // Claude's proposed inputs fill the editor.
  await panel.getByRole("button", { name: /^Inputs/ }).click();
  await expect(panel.getByRole("textbox", { name: "form" })).toHaveValue(/"tries": 0/);
  await panel.getByRole("button", { name: /^Inputs/ }).click();

  // Stepping forward takes an edge, drawn on the map.
  await page.keyboard.press("ArrowRight");
  await expect(panel.getByText("Step 2 of 3")).toBeVisible();
  // Not toBeVisible: a straight vertical edge has a zero-width bounding box, which Playwright calls hidden.
  const taken = chart.locator(".react-flow__edge.walk-taken");
  await expect(taken).toHaveCount(1);
  await expect(taken.locator(".react-flow__edge-path")).toHaveCSS("stroke", "rgb(37, 99, 235)");
  await page.keyboard.press("ArrowLeft");
  await expect(panel.getByText("Step 1 of 3")).toBeVisible();

  // Malicious code is flagged before it's reached, and the banner jumps to it.
  await expect(chart.getByRole("button", { name: /^Give up/ })).toHaveAccessibleName(/looks malicious/);
  await panel.getByRole("alert").getByRole("button", { name: /Give up/ }).click();
  await expect(panel.getByText("Step 3 of 3")).toBeVisible();
  await expect(panel.getByText("Posts the queued form to an unknown host before deleting it (app/retry.py:2)")).toBeVisible();
  await expect(panel.getByText("Reached exit: Give up")).toBeVisible();

  await page.keyboard.press("ArrowLeft");
  await expect(panel.getByText("Step 2 of 3")).toBeVisible();
  await expect(panel.getByText("assumed: The server stays down")).toBeVisible();

  // Effects are neutral: a summary and a card label, nothing red.
  await expect(panel.getByText(/^Effects:/)).toContainText("1 external call");
  await expect(panel.getByText("External call · Resends the form to the server (app/retry.py:1)")).toBeVisible();
  const backoff = chart.getByRole("button", { name: /^Back off/ });
  await expect(backoff).toHaveAccessibleName(/effects: External call/);
  await expect(backoff).not.toHaveAccessibleName(/looks malicious/);

  // A reload comes back to the same walkthrough.
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Walkthrough" }).getByText("Step 1 of 3")).toBeVisible();

  // New inputs: a fresh run.
  await panel.getByRole("button", { name: /^Inputs/ }).click();
  await panel.getByRole("textbox", { name: "form" }).fill('{"id": 7, "tries": 4}');
  await panel.getByRole("button", { name: "Run" }).click();
  await expect(panel.getByText("Sent on the first try")).toBeVisible();

  // Reset: the starting values' trace comes straight from the cache, so no new run starts.
  await panel.getByRole("button", { name: /^Inputs/ }).click();
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/walkthrough")) calls.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await panel.getByRole("button", { name: "Reset" }).click();
  await expect(panel.getByText("Step 1 of 3")).toBeVisible();
  await expect(panel.getByText("The first send fails.")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(panel.getByText("Step 3 of 3")).toBeVisible();
  // A live fixed run would have given one step ending "Sent on the first try".
  await expect(panel.getByText("Reached exit: Give up")).toBeVisible();
  await expect(panel.getByText("Reading app/retry.py")).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
  expect(calls.filter((c) => c.includes("/events"))).toHaveLength(0);

  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/walk=/);
});
