import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";

ReactDOM.createRoot(document.querySelector("#root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
