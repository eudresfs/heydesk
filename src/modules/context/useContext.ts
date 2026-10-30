import { useEffect, useRef, useState } from "react";
import type { ShellBridge } from "../../lib/shellBridge";
import type { ClaudeQuotaSnapshot, CodexQuotaSnapshot, DesktopSnapshot } from "./types";

// Um intervalo só começa depois da resposta anterior, inclusive em caso de erro.
function useSnapshot<T>(read: () => Promise<T>, enabled: boolean, interval: number) {
  const [value, setValue] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const pending = useRef<Promise<T> | null>(null);
  // Resposta igual à anterior não vira estado novo: sem re-render do App à toa.
  const last = useRef("");
  // O ritmo muda ao abrir/fechar a ilha; trocar só o próximo agendamento não descarta a leitura em curso.
  const every = useRef(interval);
  every.current = interval;
  // Ritmo mais rápido (ilha abriu): lê já, em vez de esperar o agendamento antigo.
  const hurry = useRef<() => void>(() => {});
  useEffect(() => { hurry.current(); }, [interval]);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    hurry.current = () => {};
    if (!enabled) { last.current = ""; setValue(null); setFailed(false); return; }
    async function poll() {
      try {
        // Mudanças de configuração podem reiniciar o efeito durante uma leitura.
        // Aguarde-a antes de iniciar a leitura do novo contexto.
        if (pending.current) { try { await pending.current; } catch {} }
        if (!active) return;
        const task = read();
        pending.current = task;
        let result: T;
        try { result = await task; }
        finally { if (pending.current === task) pending.current = null; }
        if (active) {
          const text = JSON.stringify(result);
          if (text !== last.current) { last.current = text; setValue(result); }
          setFailed(false);
        }
      } catch { if (active) setFailed(true); }
      if (active) { scheduled = Date.now() + every.current; timer = window.setTimeout(() => void poll(), every.current); }
    }
    let scheduled = Infinity;
    hurry.current = () => { if (active && !pending.current && scheduled - Date.now() > every.current) { window.clearTimeout(timer); scheduled = Infinity; void poll(); } };
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [read, enabled]);
  return { value: enabled ? value : null, failed: enabled && failed };
}

export function useContextSnapshots(bridge: ShellBridge, ready: boolean, modules: { codexUsage: boolean; claudeUsage?: boolean; systemInfo: boolean; media: boolean; weather: boolean }, expanded = true) {
  // As funções do bridge são estáveis, e os módulos são aplicados pelo backend
  // somente depois de persistir as preferências. Cada leitura segue o ritmo em que
  // o backend atualiza o dado (Codex 30 s, Anthropic 60 s).
  const quota = useSnapshot<CodexQuotaSnapshot>(bridge.getCodexLimits, bridge.desktop && ready && modules.codexUsage, 30000);
  // Fechado, o compacto só precisa de mídia/bateria a cada 3 s; aberto, 1 s (curva de rede).
  const desktop = useSnapshot<DesktopSnapshot>(bridge.getDesktopStatus, bridge.desktop && ready && (modules.systemInfo || modules.media || modules.weather), expanded ? 1000 : 3000);
  const claude = useSnapshot<ClaudeQuotaSnapshot>(bridge.getClaudeLimits, bridge.desktop && ready && modules.claudeUsage !== false, 60000);
  // Histórico curto da rede para a mini-curva; sobrevive à troca de página.
  const history = useRef<number[]>([]);
  const seen = useRef<DesktopSnapshot | null>(null);
  if (desktop.value && desktop.value !== seen.current) {
    seen.current = desktop.value;
    const rate = desktop.value.network?.downBps;
    if (rate != null) history.current = [...history.current, rate].slice(-30);
  }
  return { quota, desktop, claude, network: history.current };
}
