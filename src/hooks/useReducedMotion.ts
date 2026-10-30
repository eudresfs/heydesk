import { useEffect, useState } from "react";
import type { AppSettings } from "../lib/shellBridge";

export function useReducedMotion(preference: AppSettings["motion"]["reducedMotion"]) {
  const [system, setSystem] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystem(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return preference === "on" || (preference === "system" && system);
}
