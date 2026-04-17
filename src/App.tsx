import { getCurrentWindow } from "@tauri-apps/api/window";
import { MainPage } from "./pages/MainPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TrayPage } from "./pages/TrayPage";

const currentWindowLabel = getCurrentWindow().label;

export function App() {
  if (currentWindowLabel === "tray") return <TrayPage />;
  if (currentWindowLabel === "settings") return <SettingsPage />;
  return <MainPage />;
}
