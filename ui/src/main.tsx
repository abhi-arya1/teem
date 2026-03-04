import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "streamdown/styles.css";
import "./styles/slack.css";
import { connectBrowserWs } from "./ws";

connectBrowserWs();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
