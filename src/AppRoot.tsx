import { App as AntdApp, ConfigProvider } from "antd";
import { App } from "./App";
import { useGlassTheme } from "./theme/useGlassTheme";

export function AppRoot() {
  const configProps = useGlassTheme();

  return (
    <ConfigProvider {...configProps}>
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  );
}
