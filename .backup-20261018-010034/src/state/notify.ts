import { create } from 'zustand';

export type NotifyKind = 'info' | 'success' | 'warning' | 'danger';

export interface NotifyItem {
  id: number;
  kind: NotifyKind;
  text: string;
}

interface NotifyStore {
  items: NotifyItem[];
  push: (kind: NotifyKind, text: string) => void;
  dismiss: (id: number) => void;
}

let seq = 0;

/** 轻量提示队列：用于回显后端 ActionReply.message 与错误说明，配合 aria-live 播报。 */
export const useNotify = create<NotifyStore>((set) => ({
  items: [],
  push: (kind, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = ++seq;
    set((s) => ({ items: [...s.items, { id, kind, text: trimmed }] }));
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}));

export function notify(kind: NotifyKind, text: string): void {
  useNotify.getState().push(kind, text);
}
