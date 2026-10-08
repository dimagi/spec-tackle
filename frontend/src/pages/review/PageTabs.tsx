export type PageTab = { id: string; label: string };

/** Page-level views (Review now; the Map adds itself here). Hidden while there's only one. */
export function PageTabs({ tabs, active, onSelect }: { tabs: PageTab[]; active: string; onSelect: (id: string) => void }) {
  if (tabs.length < 2) return null;
  return (
    <div className="flex rounded-lg bg-stone-200/70 p-0.5 text-xs font-medium dark:bg-stone-800" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === active} className={`seg ${t.id === active ? "on" : ""}`} onClick={() => onSelect(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
