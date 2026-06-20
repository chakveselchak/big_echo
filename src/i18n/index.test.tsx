import { render, screen } from "@testing-library/react";
import { waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  I18N_LANGUAGE_STORAGE_KEY,
  I18nProvider,
  flattenLocaleKeys,
  translate,
  useI18n,
} from ".";
import enLocale from "./locales/en.json";
import ruLocale from "./locales/ru.json";

function Probe() {
  const { setLanguage, t } = useI18n();
  return (
    <div>
      <span>{t("settings.title")}</span>
      <span>{t("settings.autoDelete.days", { count: 3 })}</span>
      <button type="button" onClick={() => setLanguage("en")}>
        English
      </button>
    </div>
  );
}

function DomProbe() {
  const { setLanguage } = useI18n();
  return (
    <div>
      <button type="button" title="Settings" aria-label="Settings" onClick={() => setLanguage("en")}>
        Settings
      </button>
      <span>Sessions</span>
    </div>
  );
}

describe("i18n", () => {
  it("uses Russian by default and stores valid language changes", async () => {
    const user = userEvent.setup();
    window.localStorage.clear();

    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    expect(screen.getByText("Настройки")).toBeInTheDocument();
    expect(screen.getByText("3 дн.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "English" }));

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("3 days")).toBeInTheDocument();
    expect(window.localStorage.getItem(I18N_LANGUAGE_STORAGE_KEY)).toBe("en");
  });

  it("falls back to Russian for invalid stored language", () => {
    window.localStorage.setItem(I18N_LANGUAGE_STORAGE_KEY, "de");

    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    expect(screen.getByText("Настройки")).toBeInTheDocument();
  });

  it("interpolates parameters and keeps matching locale key paths", () => {
    expect(translate("ru", "settings.autoDelete.days", { count: 3 })).toBe("3 дн.");
    expect(translate("en", "settings.autoDelete.days", { count: 3 })).toBe("3 days");
    expect(flattenLocaleKeys(ruLocale)).toEqual(flattenLocaleKeys(enLocale));
  });

  it("translates remaining static DOM text and labels from the JSON dictionary", async () => {
    window.localStorage.clear();

    render(
      <I18nProvider>
        <DomProbe />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("Сессии")).toBeInTheDocument();
    });
    const settingsButton = screen.getByRole("button", { name: "Настройки" });
    expect(settingsButton).toHaveAttribute("title", "Настройки");

    await userEvent.click(settingsButton);

    await waitFor(() => {
      expect(screen.getByText("Sessions")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute("title", "Settings");
  });
});
