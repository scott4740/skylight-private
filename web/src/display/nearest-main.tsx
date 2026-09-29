import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Display } from "./Display.js";
import "../styles/display.css";
createRoot(document.getElementById("root")!).render(<StrictMode><Display nearestPanel /></StrictMode>);
