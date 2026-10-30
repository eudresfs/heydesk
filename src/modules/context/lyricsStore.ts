import { useSyncExternalStore } from "react";

// Letra ligada vale para o app inteiro: o Player mostra a letra e o notch fechado
// passa a exibir a linha atual (como no Nusa). Guardado entre sessões.
let on = (() => { try { return localStorage.getItem("heydesk.lyrics") === "on"; } catch { return false; } })();
const listeners = new Set<() => void>();
export function setLyricsOn(value: boolean) {
  on = value;
  try { localStorage.setItem("heydesk.lyrics", value ? "on" : "off"); } catch {}
  listeners.forEach(listener => listener());
}
export function useLyricsOn() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => on, () => on);
}
