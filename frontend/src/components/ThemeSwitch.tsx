import { useEffect, useState } from "react";

type Choice = "light" | "dark" | "system";
declare global {
  interface Window { setTheme?: (pref: Choice) => void }
}

const read = (): Choice => {
  try {
    return (localStorage.getItem("spec-tackle:theme") as Choice) || "light";
  } catch {
    return "light";
  }
};

const ICONS: Record<Choice, string> = {
  light: "M10 2a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 2Zm0 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 15Zm0-9a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm7.25 3.25a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1 0-1.5h1.5ZM5 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 5 10Zm9.95-4.95a.75.75 0 0 1 0 1.06l-1.06 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0ZM7.17 12.83a.75.75 0 0 1 0 1.06l-1.06 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0Zm7.78 2.12a.75.75 0 0 1-1.06 0l-1.06-1.06a.75.75 0 1 1 1.06-1.06l1.06 1.06a.75.75 0 0 1 0 1.06ZM7.17 7.17a.75.75 0 0 1-1.06 0L5.05 6.11a.75.75 0 0 1 1.06-1.06l1.06 1.06a.75.75 0 0 1 0 1.06Z",
  dark: "M7.46 2.3a.75.75 0 0 1 .17.82 6 6 0 0 0 7.25 8.04.75.75 0 0 1 .96.96A7.5 7.5 0 1 1 6.64 2.13a.75.75 0 0 1 .82.17Z",
  system: "M2 4.25A2.25 2.25 0 0 1 4.25 2h11.5A2.25 2.25 0 0 1 18 4.25v8.5A2.25 2.25 0 0 1 15.75 15h-3.1l.4 1.5h.7a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1 0-1.5h.7l.4-1.5h-3.1A2.25 2.25 0 0 1 2 12.75v-8.5Zm2.25-.75a.75.75 0 0 0-.75.75v7.5c0 .41.34.75.75.75h11.5a.75.75 0 0 0 .75-.75v-7.5a.75.75 0 0 0-.75-.75H4.25Z",
};
const TITLES: Record<Choice, string> = { light: "Light", dark: "Dark", system: "Match system" };

export function ThemeSwitch() {
  const [choice, setChoice] = useState<Choice>(read);
  useEffect(() => {
    const sync = () => setChoice(read());
    window.addEventListener("spec-tackle:theme", sync);
    return () => window.removeEventListener("spec-tackle:theme", sync);
  }, []);
  const pick = (c: Choice) => {
    window.setTheme?.(c);
    setChoice(c);
  };
  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      {(Object.keys(ICONS) as Choice[]).map((c) => (
        <button key={c} type="button" data-theme-choice={c} className={choice === c ? "on" : ""} title={TITLES[c]} onClick={() => pick(c)}>
          <svg viewBox="0 0 20 20" fill="currentColor">
            <path fillRule={c === "system" ? "evenodd" : undefined} clipRule={c === "system" ? "evenodd" : undefined} d={ICONS[c]} />
          </svg>
        </button>
      ))}
    </div>
  );
}
