import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/e2e/reset");
});

test("browse to a repo, open one of its PRs, and come back to the list", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Review pull requests");

  await page.getByRole("listbox", { name: "Repositories" }).getByRole("option", { name: /o\/r/ }).click();
  await expect(page).toHaveURL(/\/\?repo=o%2Fr$/);
  await page.getByRole("option", { name: /Rename the sync queue/ }).click();

  await expect(page).toHaveURL(/\/pr\/o\/r\/8$/);
  await expect(page.locator("header h1")).toContainText("Rename the sync queue");

  await page.goBack();
  await expect(page.getByRole("listbox", { name: "Open pull requests" })).toContainText("Retry failed form submissions");
});

test("a repo's PRs: open, unapproved ones by default; the chips show drafts and approved ones", async ({ page }) => {
  await page.goto("/?repo=o%2Fr");
  const list = page.getByRole("listbox", { name: "Open pull requests" });
  await expect(list.getByRole("option")).toHaveCount(2);
  await expect(list).toContainText("Rename the sync queue");
  await expect(list).toContainText("changes requested");
  await expect(list).not.toContainText("Offline mode");
  await expect(list).toContainText("2 pull requests more hidden by the filters");

  await page.getByRole("button", { name: "Draft", exact: true }).click();
  await page.getByRole("button", { name: "Approved", exact: true }).click();
  await expect(list.getByRole("option")).toHaveCount(4);
  await expect(list).toContainText("Offline mode");
  await expect(list).toContainText("approved");
});
