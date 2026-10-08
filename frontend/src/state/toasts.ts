import { create } from "zustand";

export type Toast = {
  id: number;
  message: string;
  kind: "info" | "error";
  action?: string;
  onAction?: () => void;
};

type ToastState = { toasts: Toast[]; dismiss: (id: number) => void };

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

let nextId = 1;

export function toast(
  message: string,
  { kind = "info", action, onAction, timeout = 5000 }: Partial<Omit<Toast, "id" | "message">> & { timeout?: number } = {},
): number {
  const id = nextId++;
  useToasts.setState({ toasts: [...useToasts.getState().toasts, { id, message, kind, action, onAction }] });
  if (timeout) setTimeout(() => useToasts.getState().dismiss(id), timeout);
  return id;
}
