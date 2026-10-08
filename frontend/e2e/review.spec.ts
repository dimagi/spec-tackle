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


test("after a force-push, comments still go to the commit the page shows", async ({ page, request }) => {
  await page.goto(PAGE);
  await expect(page.locator(".thread-card").first()).toBeVisible();
  await request.post("/e2e/push");
  await page.getByTestId("sync-label").click();
  await expect(page.getByText("New commits pushed")).toBeVisible();

  const block = page.locator(".view:not([hidden]) [data-ls]", { hasText: "At most five tries." });
  await block.click();
  await page.locator(".thread-card.composer textarea").fill("Still relevant?");
  await page.locator(".thread-card.composer textarea").press("ControlOrMeta+Enter");
  await expect(page.getByText("Comment posted to the PR")).toBeVisible();

  const posted = await (await request.get("/e2e/posted")).json();
  expect(posted.comments[0].commit_id).toBe("e2e0000headsha");
});

test("signing out mid-review warns once, however often it syncs", async ({ page, request }) => {
  await page.goto(PAGE);
  await expect(page.locator(".thread-card").first()).toBeVisible();
  await request.post("/e2e/signout");

  for (let i = 0; i < 3; i++) {
    await page.getByTestId("sync-label").click();
    await expect(page.getByTestId("sync-label")).not.toHaveText("Checking…");
  }

  await expect(page.getByText("You're signed out of GitHub", { exact: false })).toHaveCount(1);
  await expect(page.getByTestId("sync-label")).toHaveText("Signed out");
});

test("a streaming Claude answer pushes the cards below it out of the way", async ({ page }) => {
  await page.goto(PAGE);
  await expect(page.locator(".thread-card").first()).toBeVisible();
  await page.locator(".view:not([hidden]) [data-ls]", { hasText: "Forms are sent once." }).click();
  const composer = page.locator(".thread-card.composer");
  await composer.getByRole("button", { name: "Ask Claude" }).click();
  await composer.locator("textarea").fill("How does the backoff grow?");
  await composer.locator("textarea").press("ControlOrMeta+Enter");

  const claude = page.locator(".thread-card.claude");
  await expect(claude).toContainText("Reading docs/retry.md");
  const overlaps = async () => {
    // Where layout put each card (cards animate towards it, so live boxes can cross briefly).
    const boxes = await page.locator("#margin > [data-card]:visible").evaluateAll((els) =>
      els.map((el) => { const top = parseFloat((el as HTMLElement).style.top); return [top, top + (el as HTMLElement).offsetHeight]; }));
    return boxes.some(([t1, b1], i) => boxes.some(([t2, b2], j) => i < j && t1 < b2 - 1 && t2 < b1 - 1));
  };
  // Sample while the answer grows, then once it's done.
  for (let i = 0; i < 8; i++) {
    expect(await overlaps()).toBe(false);
    await page.waitForTimeout(150);
  }
  await expect(claude).toContainText("doubling each time", { timeout: 10_000 });
  await page.waitForTimeout(300);
  expect(await overlaps()).toBe(false);
});
