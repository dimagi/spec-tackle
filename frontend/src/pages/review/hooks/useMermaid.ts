import { useEffect, type RefObject } from "react";

/** Draw ```mermaid blocks; redraw when the theme changes. */
export function useMermaid(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const diagrams = [...(root.current?.querySelectorAll<HTMLElement>("pre.mermaid") ?? [])];
    if (!diagrams.length) return;
    let cancelled = false;
    diagrams.forEach((pre) => (pre.dataset.source ??= pre.textContent ?? ""));
    const draw = async () => {
      const { default: mermaid } = await import("mermaid");
      if (cancelled) return;
      const dark = document.documentElement.classList.contains("dark");
      mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict" });
      diagrams.forEach((pre) => { pre.removeAttribute("data-processed"); pre.textContent = pre.dataset.source!; });
      await mermaid.run({ nodes: diagrams });
      window.dispatchEvent(new Event("spec-tackle:layout"));
    };
    window.addEventListener("spec-tackle:theme", draw);
    draw();
    return () => {
      cancelled = true;
      window.removeEventListener("spec-tackle:theme", draw);
    };
  }, [root]);
}
