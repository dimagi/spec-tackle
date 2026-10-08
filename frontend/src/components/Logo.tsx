import { Link } from "react-router";

export function Logo() {
  return (
    <Link to="/" className="flex shrink-0 items-center gap-1.5 rounded-md bg-amber-400 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-stone-950">
      <svg viewBox="2 11.5 28 12" className="h-3 w-7" aria-hidden="true">
        <g fill="#fffbeb" fillOpacity=".55" stroke="currentColor" strokeWidth="2.6">
          <circle cx="10" cy="17.5" r="5.2" /><circle cx="22" cy="17.5" r="5.2" />
        </g>
        <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M14.6 15.6 Q16 13.4 17.4 15.6" /><path d="M4.9 16.2 L2.6 14.2" /><path d="M27.1 16.2 L29.4 14.2" />
        </g>
      </svg>
      spec-tackle
    </Link>
  );
}
