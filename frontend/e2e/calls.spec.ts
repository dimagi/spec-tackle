import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/e2e/reset");
  await request.post("/e2e/python");
});

test("the call tree shows a changed function, the caller it breaks, and its code", async ({ page }) => {
  await page.goto("/pr/o/r/7");
  await page.getByRole("tab", { name: "Visualize" }).click();
  await page.getByRole("tab", { name: "Calls" }).click();
  await expect(page).toHaveURL(/\?view=logic&mode=calls$/);

  await expect(page.getByText("1 changed function, 1 caller, 0 callees · 1 caller not updated")).toBeVisible();
  const chart = page.locator(".logic-flow");
  const backoff = chart.getByRole("button", { name: /changed function backoff, signature changed/ });
  await expect(backoff).toBeVisible();
  await expect(chart.getByRole("button", { name: /unchanged function send/ })).toBeVisible();
  await expect(chart.getByText("caller not updated")).toBeVisible();

  await backoff.click();
  const panel = page.getByRole("complementary", { name: "backoff()" });
  await expect(panel.getByRole("button", { name: /send\(\).*app\/forms\.py:5/ })).toBeVisible();
  await expect(panel.locator(".logic-line.changed").first()).toContainText("def backoff(tries, base):");

  await panel.getByRole("button", { name: "Show in Code view" }).click();
  await expect(page).toHaveURL(/\/pr\/o\/r\/7$/);
  await expect(page.locator(".line-flash")).toContainText("def backoff(tries, base):");

  // Back to Logic: still on Calls.
  await page.getByRole("tab", { name: "Visualize" }).click();
  await expect(page.getByRole("tab", { name: "Calls" })).toHaveAttribute("aria-selected", "true");
});
