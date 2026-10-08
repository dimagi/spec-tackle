import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/e2e/reset");
});

test("switch to another PR from the title, then back", async ({ page }) => {
  await page.goto("/pr/o/r/7");
  const title = page.locator("header h1");
  await expect(title).toContainText("Retry failed form submissions");

  await title.getByRole("button").click();
  await page.getByRole("group", { name: "Review requested" }).getByRole("option", { name: /Rename the sync queue/ }).click();

  await expect(page).toHaveURL(/\/pr\/o\/r\/8$/);
  await expect(title).toContainText("Rename the sync queue");
  await expect(page).toHaveTitle(/#8/);

  await page.goBack();
  await expect(page).toHaveURL(/\/pr\/o\/r\/7$/);
  await expect(title).toContainText("Retry failed form submissions");
  await expect(page.locator(".thread-card", { hasText: "How long is the backoff?" })).toBeVisible();

  // p reopens it; PR 8 is in the review queue, so Recent shows only PR 7.
  await page.keyboard.press("p");
  const recent = page.getByRole("group", { name: "Recent" });
  await expect(recent.getByRole("option")).toHaveCount(1);
  await expect(recent).toContainText("Retry failed form submissions");
});

test("paste a link into the switcher", async ({ page }) => {
  await page.goto("/pr/o/r/7");
  await expect(page.locator("header h1")).toContainText("Retry failed form submissions");
  await page.keyboard.press("p");
  await page.getByRole("textbox", { name: "Pull request link or filter" }).fill("https://github.com/o/r/pull/8/files");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/pr\/o\/r\/8$/);
});
