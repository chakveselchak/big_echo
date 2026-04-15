import '@testing-library/jest-dom/vitest';

function createStorage(): Storage {
  const entries = new Map<string, string>();

  return {
    clear() {
      entries.clear();
    },
    getItem(key: string) {
      return entries.has(key) ? entries.get(key)! : null;
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null;
    },
    removeItem(key: string) {
      entries.delete(key);
    },
    setItem(key: string, value: string) {
      entries.set(key, value);
    },
    get length() {
      return entries.size;
    },
  } as Storage;
}

const storage = typeof globalThis.localStorage?.clear === "function" ? globalThis.localStorage : createStorage();

if (globalThis.localStorage !== storage) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    enumerable: true,
    value: storage,
    writable: true,
  });
}

if (typeof window !== "undefined" && window.localStorage !== storage) {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    enumerable: true,
    value: storage,
    writable: true,
  });
}
