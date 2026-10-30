import { useCallback, useRef, useState } from "react";
import type { ShellBridge } from "../../lib/shellBridge";

export interface AskTurn { question: string; answer: string; error?: string }

/** Pergunta com as últimas trocas como contexto: o CLI roda sem sessão salva. */
export function askPrompt(history: AskTurn[], question: string) {
  const previous = history.filter(turn => turn.answer && !turn.error).slice(-3)
    .map(turn => `Você: ${turn.question}\nAssistente: ${turn.answer}`).join("\n\n");
  return previous ? `Conversa até aqui:\n${previous}\n\nPergunta: ${question}` : question;
}

// A conversa vive enquanto o app estiver aberto; trocar de página não a perde.
export function useAsk(bridge: ShellBridge) {
  const [history, setHistory] = useState<AskTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const turns = useRef(history);
  turns.current = history;
  const ask = useCallback(async (question: string) => {
    const clean = question.trim();
    if (!clean || busy || !bridge.ask) return;
    const prompt = askPrompt(turns.current, clean);
    setBusy(true);
    setHistory(value => [...value, { question: clean, answer: "" }].slice(-20));
    const patch = (change: (turn: AskTurn) => AskTurn) => setHistory(value => value.map((turn, index) => index === value.length - 1 ? change(turn) : turn));
    try { await bridge.ask(prompt, text => patch(turn => ({ ...turn, answer: turn.answer + text }))); }
    catch (reason) { patch(turn => ({ ...turn, error: typeof reason === "string" ? reason : "O Claude não respondeu." })); }
    finally { setBusy(false); }
  }, [bridge, busy]);
  const cancel = useCallback(() => { void bridge.askCancel?.(); }, [bridge]);
  const clear = useCallback(() => { if (!busy) setHistory([]); }, [busy]);
  return { history, busy, available: Boolean(bridge.desktop && bridge.ask), ask, cancel, clear };
}
export type AskControl = ReturnType<typeof useAsk>;
