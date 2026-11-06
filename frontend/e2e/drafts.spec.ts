import { expect, test, type Page } from "@playwright/test";

const PAGE = "/pr/o/r/7";

test.beforeEach(async ({ request }) => {
  await request.post("/e2e/reset");
});

async function draftOn(page: Page, passage: string, body: string) {
  await page.locator(".view:not([hidden]) [data-ls]", { hasText: passage }).hover();
  await page.locator(".gutter-add").click();
  const composer = page.locator(".thread-card.composer");
  await composer.locator("textarea").fill(body);
  await composer.getByRole("button", { name: "Add to review" }).click();
  await expect(page.locator(".thread-card.draft", { hasText: body })).toBeVisible();
}

test("a drafted question survives a reload and can be deleted without GitHub hearing of it", async ({ page, request }) => {
  await page.goto(PAGE);
  await draftOn(page, "At most five tries.", "Why five?");
  const draft = page.locator(".thread-card.draft", { hasText: "Why five?" });
  await expect(draft).toContainText("Draft · only you");
  await expect(page.getByRole("button", { name: "Finish review · 1" })).toBeVisible();

  // It sits beside the passage it is about, which is marked.
  const anchor = page.locator(".view:not([hidden]) .has-draft");
  await expect(anchor).toContainText("At most five tries.");
  const [cardBox, anchorBox] = [await draft.boundingBox(), await anchor.boundingBox()];
  expect(Math.abs(cardBox!.y - anchorBox!.y)).toBeLessThan(40);

  await page.reload();
  await expect(draft).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await draft.getByRole("button", { name: "Delete" }).click();
  await expect(draft).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Finish review", exact: true })).toBeVisible();

  const posted = await (await request.get("/e2e/posted")).json();
  expect(posted).toMatchObject({ comments: [], reviews: [], pending: null });
  expect(posted.threads).toHaveLength(1);
});

test("⌘⇧↵ drafts, and a draft can be edited", async ({ page }) => {
  await page.goto(PAGE);
  await page.locator(".view:not([hidden]) [data-ls]", { hasText: "Forms are sent once." }).hover();
  await page.locator(".gutter-add").click();
  const box = page.locator(".thread-card.composer textarea");
  await box.fill("Only once?");
  await box.press("ControlOrMeta+Shift+Enter");

  const draft = page.locator(".thread-card.draft");
  await expect(draft).toContainText("Only once?");
  await draft.getByRole("button", { name: "Edit" }).click();
  await draft.getByLabel("Edit comment").fill("Only once, ever?");
  await draft.getByRole("button", { name: "Save" }).click();

  await expect(page.locator(".thread-card.draft", { hasText: "Only once, ever?" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".thread-card.draft", { hasText: "Only once, ever?" })).toBeVisible();
});

test("a drafted comment and a drafted reply go out together as one review", async ({ page, request }) => {
  await page.goto(PAGE);
  await draftOn(page, "At most five tries.", "Why five?");
  const thread = page.locator(".thread-card", { hasText: "How long is the backoff?" });
  await thread.locator(".thread-reply textarea").fill("Exponential, I assume");
  await thread.getByRole("button", { name: "Add to review" }).click();
  await expect(thread.locator(".draft-reply")).toContainText("Exponential, I assume");

  // Still private.
  let posted = await (await request.get("/e2e/posted")).json();
  expect(posted).toMatchObject({ comments: [], reviews: [], pending: null });

  await page.getByRole("button", { name: "Finish review · 2" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("2 drafts will be posted with this review.");
  await dialog.getByRole("button", { name: "Submit review" }).click();

  await expect(page.getByText("Review submitted with 2 drafts")).toBeVisible();
  await expect(page.locator(".thread-card.draft")).toHaveCount(0);
  await expect(page.locator(".draft-reply")).toHaveCount(0);
  await expect(page.locator(".thread-card:not(.draft)", { hasText: "Why five?" })).toBeVisible();
  await expect(thread).toContainText("Exponential, I assume");
  await expect(page.getByRole("button", { name: "Finish review", exact: true })).toBeVisible();

  posted = await (await request.get("/e2e/posted")).json();
  expect(posted.reviews).toHaveLength(1);
  expect(posted.reviews[0]).toMatchObject({
    event: "COMMENT", commit: "e2e0000headsha",
    threads: [{ path: "docs/retry.md", body: "Why five?", line: 9 }],
    replies: [{ body: "Exponential, I assume" }],
  });
  expect(posted.comments).toEqual([]); // nothing went through the post-immediately route
});

test("a draft whose passage is rewritten is flagged, held back, and can be re-attached", async ({ page, request }) => {
  await page.goto(PAGE);
  await draftOn(page, "At most five tries.", "Why five?");
  await draftOn(page, "Forms are sent once.", "Only once?");

  await request.post("/e2e/reword");
  await page.getByTestId("sync-label").click();

  const stale = page.locator(".thread-card.draft", { hasText: "Why five?" });
  await expect(stale).toContainText("Outdated");
  await expect(stale.locator("blockquote")).toHaveText("At most five tries.");
  await expect(page.locator(".thread-card.draft", { hasText: "Only once?" })).not.toContainText("Outdated");

  await page.getByRole("button", { name: "Finish review · 2" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("1 draft will be posted with this review.");
  await expect(dialog).toContainText("1 outdated draft stays behind.");
  await dialog.getByRole("button", { name: "Submit review" }).click();
  await expect(page.getByText("Review submitted with 1 draft")).toBeVisible();

  await expect(stale).toBeVisible();
  await expect(page.locator(".thread-card.draft")).toHaveCount(1);
  const posted = await (await request.get("/e2e/posted")).json();
  expect(posted.reviews[0].threads.map((t: { body: string }) => t.body)).toEqual(["Only once?"]);

  // Move it to the heading above; it is a normal draft again.
  await stale.getByRole("button", { name: "Re-attach" }).click();
  await expect(stale).toContainText("Click a passage or select text");
  await page.locator(".view:not([hidden]) h2", { hasText: "Limits" }).click();
  await expect(page.getByText("Draft moved")).toBeVisible();
  await expect(stale).not.toContainText("Outdated");
  await expect(stale).toContainText("L7");
});
