/** Scroll the review page to a line of a file in the given view, and flash it. */
export function scrollToLine(path: string, line: number, view: "rendered" | "diff") {
  const section = document.querySelector<HTMLElement>(`section.file[data-path="${CSS.escape(path)}"]`);
  if (!section) return;
  const blocks = section.querySelectorAll<HTMLElement>(`.view[data-view="${view}"] [data-ls]`);
  const hit = [...blocks].find((b) => +b.dataset.ls! <= line && line <= +b.dataset.le!);
  (hit ?? section).scrollIntoView({ block: "center", behavior: "smooth" });
  if (hit) {
    hit.classList.remove("line-flash");
    void hit.offsetWidth; // restart the animation
    hit.classList.add("line-flash");
  }
}
