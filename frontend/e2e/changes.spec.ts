import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request, page }) => {
  await request.post("/e2e/reset");
  await page.goto("/pr/o/r/7");
  await page.getByRole("tab", { name: "Map" }).click();
  await expect(page.locator(".map-graph .map-node").first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Changes" }).click();
});

const change = (page: import("@playwright/test").Page, text: string) =>
  page.locator(".react-flow__node-change", { hasText: text });

test("each change sits in its file's box; re-signed code is flagged", async ({ page }) => {
  const send = change(page, "send()");
  await expect(send).toContainText("✎sig");
  await expect(send).toHaveAttribute("data-id", "shop/sync.py::send");
  const box = page.locator(".react-flow__node-box", { hasText: "shop/sync.py" });
  const [b, s] = [await box.boundingBox(), await send.boundingBox()];
  expect(s!.x).toBeGreaterThanOrEqual(b!.x);
  expect(s!.y + s!.height).toBeLessThanOrEqual(b!.y + b!.height + 1);
});

test("unchanged callers of a re-signed function are called out", async ({ page }) => {
  await expect(change(page, "run()")).toContainText("unchanged");
  await expect(page.locator(".react-flow__edge-text", { hasText: "signature changed, caller not updated" }).first()).toBeVisible();
});

test("clicking a change focuses its chain and shows its diff", async ({ page }) => {
  await change(page, "send()").click();
  const detail = page.locator(".change-detail");
  await expect(detail).toContainText("send()");
  await expect(detail).toContainText("signature changed");
  await expect(detail.locator(".change-diff")).toContainText("def send(order, retries=3):");
  await expect(change(page, "retry.md").locator(".change-node")).toHaveCSS("opacity", "0.2"); // not connected to send()

  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
});

test("collapsing a file box shows how many changes it holds", async ({ page }) => {
  await page.locator(".change-box-head", { hasText: "shop/models.py" }).click();
  await expect(page.locator(".react-flow__node-box", { hasText: "shop/models.py" })).toContainText("2 changes");
  await expect(change(page, "Order.total()")).toHaveCount(0);
});
