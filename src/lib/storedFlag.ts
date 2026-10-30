// Preferência simples guardada no navegador do app (vale para todas as janelas, que
// compartilham a mesma origem) e avisada entre elas pelo evento "storage".
import { useEffect, useState } from "react";

const read = (key: string) => { try { return localStorage.getItem(key) === "1"; } catch { return false; } };
export function setStoredFlag(key: string, on: boolean) {
  try { if (on) localStorage.setItem(key, "1"); else localStorage.removeItem(key); window.dispatchEvent(new StorageEvent("storage", { key })); } catch { /* sem armazenamento */ }
}
export function useStoredFlag(key: string) {
  const [on, setOn] = useState(() => read(key));
  useEffect(() => {
    const update = (event: StorageEvent) => { if (event.key === key) setOn(read(key)); };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, [key]);
  return on;
}
