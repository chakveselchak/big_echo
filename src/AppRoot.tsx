import AntdApp from "antd/es/app";
import ConfigProvider from "antd/es/config-provider";
import { App } from "./App";
import { useGlassTheme } from "./theme/useGlassTheme";

export function AppRoot() {
  const { appClassName, ...configProps } = useGlassTheme();

  return (
    <ConfigProvider {...configProps}>
      <AntdApp className={appClassName}>
        <App />
      </AntdApp>
    </ConfigProvider>
  );
}
