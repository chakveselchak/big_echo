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

function isUnsupportedAntdSelectSelector(error: unknown, selector?: string) {
  const message = String(error instanceof Error ? error.message : error);
  return (
    message.includes("ant-select-item-option-selected") ||
    Boolean(selector?.includes("ant-select-item-option-selected"))
  );
}

if (typeof Element !== "undefined") {
  const originalMatches = Element.prototype.matches;
  Element.prototype.matches = function matches(selector: string) {
    try {
      return originalMatches.call(this, selector);
    } catch (error) {
      if (isUnsupportedAntdSelectSelector(error, selector)) return false;
      throw error;
    }
  };

  const originalQuerySelectorAll = Element.prototype.querySelectorAll;
  Element.prototype.querySelectorAll = function querySelectorAll(selector: string) {
    try {
      return originalQuerySelectorAll.call(this, selector);
    } catch (error) {
      if (isUnsupportedAntdSelectSelector(error, selector)) {
        return [] as unknown as NodeListOf<Element>;
      }
      throw error;
    }
  };
}

if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
  const originalGetComputedStyle = window.getComputedStyle.bind(window);
  const createFallbackComputedStyle = (element: Element) =>
    ({
      bottom: "",
      content: "",
      display: element instanceof HTMLElement ? element.style.display : "",
      getPropertyValue: (property: string) =>
        element instanceof HTMLElement ? element.style.getPropertyValue(property) : "",
      visibility: element instanceof HTMLElement ? element.style.visibility : "",
    }) as CSSStyleDeclaration;

  window.getComputedStyle = ((element: Element, pseudoElt?: string | null) => {
    if (pseudoElt) return createFallbackComputedStyle(element);
    try {
      return originalGetComputedStyle(element, pseudoElt);
    } catch (error) {
      if (isUnsupportedAntdSelectSelector(error)) {
        return createFallbackComputedStyle(element);
      }
      throw error;
    }
  }) as typeof window.getComputedStyle;
}
