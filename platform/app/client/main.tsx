import { CodexModelCatalogProvider } from "./workspace/CodexModelCatalog";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./styles-theme.css";
import "./appearance/palette";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CodexModelCatalogProvider><App /></CodexModelCatalogProvider>
  </React.StrictMode>,
);
