import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import enUS from "antd/es/locale/en_US";
import ruRU from "antd/es/locale/ru_RU";
import type { Locale } from "antd/es/locale";
import enLocale from "./locales/en.json";
import ruLocale from "./locales/ru.json";

export type Language = "ru" | "en";
export type TranslationParams = Record<string, string | number>;

export const I18N_LANGUAGE_STORAGE_KEY = "bigecho.ui.language";

const locales: Record<Language, unknown> = {
  ru: ruLocale,
  en: enLocale,
};

const canonicalDomText = ruLocale.domText as Record<string, string>;

type I18nContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: string, params?: TranslationParams) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function isLanguage(value: unknown): value is Language {
  return value === "ru" || value === "en";
}

function readStoredLanguage(): Language {
  if (typeof window === "undefined") return "ru";
  const stored = window.localStorage.getItem(I18N_LANGUAGE_STORAGE_KEY);
  return isLanguage(stored) ? stored : "ru";
}

function resolveLocaleValue(locale: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, locale);
}

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

export function translate(language: Language, key: string, params?: TranslationParams): string {
  const value = resolveLocaleValue(locales[language], key);
  return typeof value === "string" ? interpolate(value, params) : key;
}

export function flattenLocaleKeys(locale: unknown, prefix = ""): string[] {
  if (!locale || typeof locale !== "object") return [];
  return Object.keys(locale as Record<string, unknown>)
    .flatMap((key) => {
      const path = prefix ? `${prefix}.${key}` : key;
      const value = (locale as Record<string, unknown>)[key];
      return value && typeof value === "object" ? flattenLocaleKeys(value, path) : [path];
    })
    .sort();
}

export function antdLocaleForLanguage(language: Language): Locale {
  return language === "ru" ? ruRU : enUS;
}

function staticDomTranslationFor(language: Language, value: string): string | null {
  if (language === "ru") return canonicalDomText[value] ?? null;
  for (const [english, russian] of Object.entries(canonicalDomText)) {
    if (value === russian) return english;
  }
  return null;
}

function translateElementAttributes(element: Element, language: Language) {
  for (const attribute of ["aria-label", "title", "placeholder"]) {
    const value = element.getAttribute(attribute);
    if (!value) continue;
    const translated = staticDomTranslationFor(language, value);
    if (translated && translated !== value) element.setAttribute(attribute, translated);
  }
}

function translateTextNode(node: Text, language: Language) {
  const value = node.nodeValue;
  if (!value) return;
  const trimmed = value.trim();
  if (!trimmed) return;
  const translated = staticDomTranslationFor(language, trimmed);
  if (!translated || translated === trimmed) return;
  node.nodeValue = value.replace(trimmed, translated);
}

function translateStaticDom(root: ParentNode, language: Language) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    translateTextNode(node as Text, language);
    node = walker.nextNode();
  }

  if (root instanceof Element) translateElementAttributes(root, language);
  root.querySelectorAll?.("[aria-label], [title], [placeholder]").forEach((element) => {
    translateElementAttributes(element, language);
  });
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(readStoredLanguage);

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const translate = () => translateStaticDom(document.body, language);
    translate();
    const observer = new MutationObserver(() => translate());
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["aria-label", "title", "placeholder"],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [language]);

  const value = useMemo<I18nContextValue>(() => {
    const setLanguage = (nextLanguage: Language) => {
      setLanguageState(nextLanguage);
      window.localStorage.setItem(I18N_LANGUAGE_STORAGE_KEY, nextLanguage);
    };
    return {
      language,
      setLanguage,
      t: (key, params) => translate(language, key, params),
    };
  }, [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used within I18nProvider");
  return context;
}
