import { expect, test } from "@playwright/test";

const PAGE = "/pr/o/r/7";

test.beforeEach(async ({ request }) => {
  await request.post("/e2e/reset");
});

test("threads sit beside their passage and j activates them", async ({ page }) => {
  await page.goto(PAGE);
  const card = page.locator(".thread-card", { hasText: "How long is the backoff?" });
  await expect(card).toBeVisible();

  const anchor = page.locator(".view:not([hidden]) .has-thread").first();
  await expect(anchor).toContainText("Failures are retried");
  const [cardBox, anchorBox] = [await card.boundingBox(), await anchor.boundingBox()];
  expect(Math.abs(cardBox!.y - anchorBox!.y)).toBeLessThan(40);

  await page.keyboard.press("j");
  await expect(card).toHaveClass(/is-active/);
  await expect(anchor).toHaveClass(/is-active-anchor/);
});

test("comment on a block from the gutter", async ({ page, request }) => {
  await page.goto(PAGE);
  const block = page.locator(".view:not([hidden]) [data-ls]", { hasText: "At most five tries." });
  await block.hover();
  await page.locator(".gutter-add").click();

  const composer = page.locator(".thread-card.composer");
  await expect(composer).toBeVisible();
  await composer.locator("textarea").fill("Why five?");
  await composer.locator("textarea").press("ControlOrMeta+Enter");

  await expect(page.locator(".thread-card", { hasText: "Why five?" })).toBeVisible();
  await expect(page.getByText("Comment posted to the PR")).toBeVisible();
  const posted = await (await request.get("/e2e/posted")).json();
  expect(posted.comments[0]).toMatchObject({ path: "docs/retry.md", body: "Why five?", line: 9, commit_id: "e2e0000headsha" });
});

test("reply and resolve", async ({ page }) => {
  await page.goto(PAGE);
  const card = page.locator(".thread-card", { hasText: "How long is the backoff?" });
  await card.locator(".thread-reply textarea").fill("Exponential, from 1s");
  await card.getByRole("button", { name: "Reply" }).click();
  await expect(card).toContainText("Exponential, from 1s");

  await card.getByRole("button", { name: "✓ Resolve" }).click();
  await expect(page.getByText("Thread resolved")).toBeVisible();
  // The Open filter hides resolved threads.
  await expect(card).toBeHidden();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(card).toBeVisible();
});

test("dark theme", async ({ page }) => {
  await page.goto(PAGE);
  await page.getByTitle("Dark").click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
});

