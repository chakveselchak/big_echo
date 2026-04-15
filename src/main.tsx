import React from "react";
import ReactDOM from "react-dom/client";
import "antd/dist/reset.css";
import { AppRoot } from "./AppRoot";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>
);
