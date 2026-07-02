import { useEffect, useState } from 'react';

export interface StringFocusBinding {
  read(): string | null;
  write(value: string | null): void;
  dispatch(value: string | null): void;
  focus(value: string): void;
  clear(): void;
}

export interface ObjectFocusBinding<TState> {
  read(): TState;
  write(value: TState): void;
  dispatch(value: TState): void;
  focus(value: TState): void;
  clear(): void;
}

export interface DraftBinding<TDraft> {
  read(): TDraft | null;
  write(value: TDraft | null): void;
  dispatch(value: TDraft | null): void;
  seed(value: TDraft): void;
  clear(): void;
}

export function normalizeFocusString(value: string | null | undefined): string | null {
  const nextValue = String(value || '').trim();
  return nextValue || null;
}

export function createStringFocusBinding(
  storageKey: string,
  eventName: string,
  detailKey: string,
): StringFocusBinding {
  const read = (): string | null => {
    if (typeof window === 'undefined') return null;
    return normalizeFocusString(window.localStorage.getItem(storageKey));
  };

  const write = (value: string | null): void => {
    if (typeof window === 'undefined') return;
    const nextValue = normalizeFocusString(value);
    if (nextValue) {
      window.localStorage.setItem(storageKey, nextValue);
    } else {
      window.localStorage.removeItem(storageKey);
    }
  };

  const dispatch = (value: string | null): void => {
    if (typeof window === 'undefined') return;
    const nextValue = normalizeFocusString(value);
    window.dispatchEvent(
      new CustomEvent(eventName, {
        detail: { [detailKey]: nextValue },
      }),
    );
  };

  const focus = (value: string): void => {
    const nextValue = normalizeFocusString(value);
    if (!nextValue) return;
    write(nextValue);
    dispatch(nextValue);
  };

  const clear = (): void => {
    write(null);
    dispatch(null);
  };

  return {
    read,
    write,
    dispatch,
    focus,
    clear,
  };
}

export function createObjectFocusBinding<TState>(
  storageKey: string,
  eventName: string,
  normalize: (raw: unknown) => TState,
  isEmpty: (value: TState) => boolean,
): ObjectFocusBinding<TState> {
  const read = (): TState => {
    if (typeof window === 'undefined') return normalize(null);
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return normalize(null);
      return normalize(JSON.parse(raw));
    } catch {
      return normalize(null);
    }
  };

  const write = (value: TState): void => {
    if (typeof window === 'undefined') return;
    const nextValue = normalize(value);
    if (isEmpty(nextValue)) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify(nextValue));
  };

  const dispatch = (value: TState): void => {
    if (typeof window === 'undefined') return;
    const nextValue = normalize(value);
    window.dispatchEvent(new CustomEvent(eventName, { detail: nextValue }));
  };

  const focus = (value: TState): void => {
    const nextValue = normalize(value);
    write(nextValue);
    dispatch(nextValue);
  };

  const clear = (): void => {
    const emptyValue = normalize(null);
    write(emptyValue);
    dispatch(emptyValue);
  };

  return {
    read,
    write,
    dispatch,
    focus,
    clear,
  };
}

export function createDraftBinding<TDraft>(
  storageKey: string,
  eventName: string,
  normalize: (raw: unknown) => TDraft | null,
): DraftBinding<TDraft> {
  const read = (): TDraft | null => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return null;
      return normalize(JSON.parse(raw));
    } catch {
      return null;
    }
  };

  const write = (value: TDraft | null): void => {
    if (typeof window === 'undefined') return;
    const nextValue = normalize(value);
    if (!nextValue) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify(nextValue));
  };

  const dispatch = (value: TDraft | null): void => {
    if (typeof window === 'undefined') return;
    const nextValue = normalize(value);
    window.dispatchEvent(
      new CustomEvent(eventName, {
        detail: { draft: nextValue },
      }),
    );
  };

  const seed = (value: TDraft): void => {
    const nextValue = normalize(value);
    if (!nextValue) return;
    write(nextValue);
    dispatch(nextValue);
  };

  const clear = (): void => {
    write(null);
    dispatch(null);
  };

  return {
    read,
    write,
    dispatch,
    seed,
    clear,
  };
}

export function useEventedValue<TValue>(
  read: () => TValue,
  eventName: string,
): TValue {
  const [value, setValue] = useState<TValue>(() => read());

  useEffect(() => {
    const sync = () => setValue(read());
    sync();
    window.addEventListener(eventName, sync as EventListener);
    return () => window.removeEventListener(eventName, sync as EventListener);
  }, [eventName, read]);

  return value;
}
