import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/e2e/reset");
});

test("generate a logic map, expand it, open a function and jump to it in Review", async ({ page }) => {
  await page.goto("/pr/o/r/7");
  await page.getByRole("tab", { name: "Logic view" }).click();
  await expect(page).toHaveURL(/\?view=logic$/);

  await page.getByRole("button", { name: "Generate logic map" }).click();
  await expect(page.getByText("Failed form submissions are retried with backoff")).toBeVisible();

  const chart = page.locator(".logic-chart");
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
