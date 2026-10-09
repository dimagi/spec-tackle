import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/e2e/reset");
});

test("find references, hover one to see its target, click it to jump there", async ({ page }) => {
  await page.goto("/pr/o/r/7");
  const file = page.locator('section.file[data-path="docs/retry.md"]');
  await file.getByRole("button", { name: "Find references" }).click();
  await expect(file.getByRole("button", { name: "2 references" })).toBeVisible();

  const marker = file.locator(".doc-ref", { hasText: "Limits" });
  await marker.hover();
  const popup = page.getByRole("tooltip");
  await expect(popup).toContainText("At most five tries.");
  await expect(popup).toContainText("lines 7–9");

  // A click jumps to the target; it doesn't open a comment composer.
  await marker.click();
  await expect(page.locator(".line-flash")).toContainText("Limits");
  await expect(page.locator(".thread-card.composer")).toHaveCount(0);

  // A reload keeps them.
  await page.reload();
  await expect(file.locator(".doc-ref")).toHaveCount(2);
});

test("a reference to a code file shows its lines and opens it on GitHub", async ({ page }) => {
  await page.goto("/pr/o/r/7");
  const file = page.locator('section.file[data-path="docs/retry.md"]');
  await file.getByRole("button", { name: "Find references" }).click();

  const marker = file.locator(".doc-ref.is-external");
  await expect(marker).toHaveText("five tries");
  await marker.hover();
  const popup = page.getByRole("tooltip");
  await expect(popup).toContainText("app/retry.py:1");
  await expect(popup.locator(".logic-line")).toContainText("MAX_TRIES = 5");

  const opened = page.waitForEvent("popup");
  await marker.click();
  expect((await opened).url()).toContain("/o/r/blob/e2e0000headsha/app/retry.py#L1-L1");
});

test("with Auto-find references on, documents are searched without a click, and it stays on for this PR", async ({ page }) => {
  await page.goto("/pr/o/r/7");
  const toggle = page.getByRole("switch", { name: "Auto-find references" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  const file = page.locator('section.file[data-path="docs/retry.md"]');
  await expect(file.locator(".doc-ref")).toHaveCount(2);

  await page.reload();
  await expect(page.getByRole("switch", { name: "Auto-find references" })).toHaveAttribute("aria-checked", "true");
  // Another PR has its own setting.
  await page.goto("/pr/o/r/8");
  await expect(page.getByRole("switch", { name: "Auto-find references" })).toHaveAttribute("aria-checked", "false");
});
