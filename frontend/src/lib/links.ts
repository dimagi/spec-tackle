/** Links inside comments open in a new tab, so following one never leaves the review. */
export function externalLinks(el: Element | null, rel = "noopener") {
  el?.querySelectorAll("a").forEach((a) => {
    a.target = "_blank";
    a.rel = rel;
  });
}
