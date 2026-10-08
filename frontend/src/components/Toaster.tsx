import { useToasts } from "../state/toasts";

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div id="toasts" className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.message}
          {t.action && (
            <> <button onClick={() => { t.onAction?.(); dismiss(t.id); }}>{t.action}</button></>
          )}
        </div>
      ))}
    </div>
  );
}
