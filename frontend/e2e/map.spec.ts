import { expect, test } from "@playwright/test";

const PAGE = "/pr/o/r/7";

test.beforeEach(async ({ request }) => {
  await request.post("/e2e/reset");
});

test("the Map shows the change, who depends on it, and a reading path", async ({ page }) => {
  await page.goto(PAGE);
  await page.getByRole("tab", { name: "Map" }).click();

  const graph = page.locator(".map-graph");
  await expect(graph.locator(".map-node", { hasText: "sync.py" })).toBeVisible({ timeout: 20_000 });
  await expect(graph.locator(".map-node.dependent", { hasText: "tasks.py" })).toContainText("unchanged · uses send");

  const rows = page.getByTestId("path-row");
  await expect(rows.first()).toHaveAttribute("data-path", "shop/models.py"); // data first
  await expect(page.locator(".map-path")).toContainText("not in PR · check");
  await expect(page.getByText("Reviewed 0 of 3 files")).toBeVisible();
});

test("j and x tick files off; Enter opens one in Review", async ({ page }) => {
  await page.goto(PAGE);
  await page.getByRole("tab", { name: "Map" }).click();
  await expect(page.getByTestId("path-row").first()).toBeVisible({ timeout: 20_000 });

  await page.keyboard.press("j");
  await page.keyboard.press("x");
  await expect(page.getByText("Reviewed 1 of 3 files")).toBeVisible();

  await page.keyboard.press("j");
  await expect(page.getByTestId("path-row").nth(1)).toHaveClass(/sel/);
  await expect(page.getByTestId("path-row").nth(1)).toHaveAttribute("data-path", "shop/sync.py");
  await page.keyboard.press("Enter");

  const section = page.locator('section.file[data-path="shop/sync.py"]');
  await expect(section).toBeVisible();
  await expect(section.locator('.view[data-view="diff"]')).toBeVisible();
  await expect(page.locator(".map-view")).toHaveCount(0);
});

test("hovering a reading-path row lights up its node", async ({ page }) => {
  await page.goto(PAGE);
  await page.getByRole("tab", { name: "Map" }).click();
  const row = page.getByTestId("path-row").filter({ hasText: "sync.py" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.hover();
  await expect(page.locator(".map-graph .map-node.is-hl")).toContainText("sync.py");
});
