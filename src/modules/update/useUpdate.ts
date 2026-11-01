// Atualização: o Rust avisa quando acha versão nova ("app:update") e manda o progresso do
// download ("app:update-progress"). Aqui fica o que o notch e as configurações mostram.
import { useCallback, useEffect, useState } from "react";
import type { ShellBridge, UpdateInfo } from "../../lib/shellBridge";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none"; current: string }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "installing"; info: UpdateInfo; percent: number }
  | { kind: "error"; message: string; info?: UpdateInfo };

const message = (reason: unknown) => typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "Não foi possível falar com o servidor de atualizações.";

/** `announce`: o notch quer saber das versões achadas pela busca automática. */
export function useUpdate(bridge: ShellBridge, announce: boolean) {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  useEffect(() => {
    if (!bridge.onDesktopEvent) return;
    const stops: (() => void)[] = []; let alive = true;
    const keep = (stop: () => void) => { if (alive) stops.push(stop); else stop(); };
    if (announce) void bridge.onDesktopEvent("app:update", payload => setState({ kind: "available", info: payload as UpdateInfo })).then(keep);
    void bridge.onDesktopEvent("app:update-progress", payload => setState(current => current.kind === "available" || current.kind === "installing" ? { kind: "installing", info: current.info, percent: Number(payload) || 0 } : current)).then(keep);
    return () => { alive = false; stops.forEach(stop => stop()); };
  }, [bridge, announce]);
  const check = useCallback(async () => {
    if (!bridge.updateCheck) return;
    setState({ kind: "checking" });
    try {
      const info = await bridge.updateCheck();
      setState(info.version ? { kind: "available", info } : { kind: "none", current: info.current });
    } catch (reason) { setState({ kind: "error", message: message(reason) }); }
  }, [bridge]);
  const install = useCallback(async () => {
    const info = state.kind === "available" || state.kind === "error" ? state.info : undefined;
    if (!info || !bridge.updateInstall) return;
    setState({ kind: "installing", info, percent: 0 });
    // Deu certo: o app fecha e reabre na versão nova, então só o erro volta.
    try { await bridge.updateInstall(); } catch (reason) { setState({ kind: "error", message: message(reason), info }); }
  }, [bridge, state]);
  const dismiss = useCallback(() => {
    if (state.kind === "available" && state.info.version) void bridge.updateDismiss?.(state.info.version).catch(() => {});
    setState({ kind: "idle" });
  }, [bridge, state]);
  /** Mostra o aviso sem versão nova de verdade (conferir o visual pelo console de depuração). */
  const preview = useCallback((info: UpdateInfo) => setState({ kind: "available", info }), []);
  return { state, check, install, dismiss, preview };
}
export type UpdateControl = ReturnType<typeof useUpdate>;

/** Primeira linha útil das notas da versão (sem marcação), para caber no aviso. */
export function noteLine(notes: string | null | undefined) {
  const line = (notes ?? "").split(/\r?\n/).map(text => text.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? "";
  return line.length > 110 ? `${line.slice(0, 107).trimEnd()}…` : line;
}
