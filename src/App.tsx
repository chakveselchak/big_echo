import { getCurrentWindow } from "@tauri-apps/api/window";
import AntdApp from "antd/es/app";
import ConfigProvider from "antd/es/config-provider";
import { MainPage } from "./pages/MainPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TrayPage } from "./pages/TrayPage";
import { appTheme } from "./theme";
import { I18nProvider, antdLocaleForLanguage, useI18n } from "./i18n";

const currentWindowLabel = getCurrentWindow().label;

function AppContent() {
  if (currentWindowLabel === "tray") return <TrayPage />;
  if (currentWindowLabel === "settings") return <SettingsPage />;
  return <MainPage />;
}

function LocalizedApp() {
  const { language } = useI18n();
  return (
    <ConfigProvider locale={antdLocaleForLanguage(language)} theme={appTheme}>
      <AntdApp>
        <AppContent />
      </AntdApp>
    </ConfigProvider>
  );
}

export function App() {
  return (
    <I18nProvider>
      <LocalizedApp />
    </I18nProvider>
  );
}
