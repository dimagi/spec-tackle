import { scrollToLine } from "./scrollToLine";

beforeEach(() => {
  document.body.innerHTML = `
    <section class="file" data-path="app/x.py">
      <div class="view" data-view="rendered"><p data-ls="1" data-le="9">doc</p></div>
      <div class="view" data-view="diff">
        <table><tr class="code-line" data-ls="3" data-le="3"><td>a</td></tr><tr class="code-line" data-ls="4" data-le="4"><td>b</td></tr></table>
      </div>
    </section>`;
  Element.prototype.scrollIntoView = vi.fn();
});

test("scrolls to the block covering the line in the chosen view, and flashes it", () => {
  scrollToLine("app/x.py", 4, "diff");
  const row = document.querySelector('[data-ls="4"]')!;
  expect(row.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  expect(row).toHaveClass("line-flash");
  expect(document.querySelector('[data-ls="1"]')).not.toHaveClass("line-flash");
});

test("falls back to the file when no block covers the line", () => {
  scrollToLine("app/x.py", 40, "diff");
  expect(document.querySelector("section")!.scrollIntoView).toHaveBeenCalled();
  expect(document.querySelector(".line-flash")).toBeNull();
});

test("does nothing for a file that isn't on the page", () => {
  expect(() => scrollToLine("nope.py", 1, "diff")).not.toThrow();
});
