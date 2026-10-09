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
