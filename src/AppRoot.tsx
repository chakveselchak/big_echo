import AntdApp from "antd/es/app";
import ConfigProvider from "antd/es/config-provider";
import { App } from "./App";
import { appTheme } from "./theme";

export function AppRoot() {
  return (
    <ConfigProvider theme={appTheme}>
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  );
}
