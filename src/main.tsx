import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { CameraBubble } from "./modules/prompter/CameraBubble";
import { CursorOverlay } from "./modules/prompter/CursorOverlay";
import { CountdownOverlay } from "./modules/prompter/CountdownOverlay";
import "./index.css";

// A mesma página serve o notch e as janelas da gravação (?view=camera|cursor|countdown).
const view = new URLSearchParams(location.search).get("view");
if (view) document.documentElement.dataset.view = view;
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{view === "camera" ? <CameraBubble /> : view === "cursor" ? <CursorOverlay /> : view === "countdown" ? <CountdownOverlay /> : <App />}</React.StrictMode>,
);
