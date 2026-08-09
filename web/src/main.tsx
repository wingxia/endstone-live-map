import "leaflet/dist/leaflet.css";
import "./styles.css";

import React from "react";
import { createRoot } from "react-dom/client";

import { installAppViewportTracking } from "./appViewport";
import { App } from "./ui/App";

installAppViewportTracking();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
