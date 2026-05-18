import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "@fontsource/geist-sans";
import { PostHogProvider } from "./providers/PostHogProvider";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PostHogProvider>
      <App />
    </PostHogProvider>
  </React.StrictMode>,
);
