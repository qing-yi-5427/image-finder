import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./standalone.css";
import "./live.css";
createRoot(document.getElementById("image-finder-prototype")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
