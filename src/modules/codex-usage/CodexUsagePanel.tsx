import type { CodexUsageSnapshot } from "./types";

const number = new Intl.NumberFormat("pt-BR");
export function compactTokens(value: number) {
  return new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
const statusLabels: Record<CodexUsageSnapshot["status"], string> = {
  disabled: "Monitor desativado", loading: "Lendo registros locais", ready: "Registros locais",
  empty: "Nenhum consumo registrado", not_installed: "Codex não encontrado",
  insufficient_data: "Cobertura insuficiente", error: "Coleta indisponível",
};

export function CodexUsagePanel({ desktop, enabled, snapshot, failed, refreshing, refresh }: {
  desktop: boolean; enabled: boolean; snapshot: CodexUsageSnapshot | null; failed: boolean;
  refreshing: boolean; refresh(): void;
}) {
  const status = !enabled ? "disabled" : snapshot?.status ?? "loading";
  const today = enabled ? snapshot?.today : null;
  const partial = snapshot && (snapshot.legacyOnlyFiles > 0 || snapshot.invalidRecords > 0 || snapshot.conflicts > 0 || snapshot.pendingFiles > 0);
  const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const start = new Date(); start.setDate(start.getDate() - 13);
  const days = enabled ? [...(snapshot?.days ?? [])].filter(day => day.date >= localDate(start) && day.date <= localDate(new Date())).sort((a, b) => a.date.localeCompare(b.date)).slice(-14) : [];
  const maximum = Math.max(1, ...days.map(day => day.totalTokens));
  const updated = snapshot?.lastUpdated ? new Date(snapshot.lastUpdated) : null;

  return <section className="usage-content" aria-label="Consumo do Codex">
    <div className="usage-status" aria-live="polite">
      <span className={`status-dot ${enabled && snapshot?.status === "ready" && !failed ? "online" : ""}`} aria-hidden="true" />
      <span>{!desktop ? "Desktop necessário" : failed ? "Falha ao consultar consumo" : snapshot?.scanning ? "Atualizando registros" : statusLabels[status]}</span>
      <button type="button" className="retry-button refresh-button" disabled={!desktop || !enabled || refreshing || snapshot?.scanning} onClick={refresh}>{refreshing || snapshot?.scanning ? "Atualizando…" : "Atualizar"}</button>
    </div>
    <div className="today-usage">
      <span className="eyebrow">Tokens hoje</span>
      <strong className="token-total" title={today ? number.format(today.totalTokens) : undefined}>{today ? compactTokens(today.totalTokens) : "—"}</strong>
      <p className="usage-description">{!desktop ? "Abra o aplicativo desktop para ler seu consumo local." : !enabled ? "Ative o monitor nas Preferências e salve." : today ? `${number.format(today.responseCount)} respostas · ${number.format(today.sessionCount)} sessões` : status === "empty" ? "Os próximos registros aparecerão aqui." : status === "not_installed" ? "Nenhuma pasta de sessões do Codex foi encontrada." : status === "insufficient_data" ? "Os registros encontrados não identificam respostas individuais." : status === "error" || failed ? "Tente atualizar para consultar novamente." : snapshot?.scanning ? "A primeira leitura pode levar alguns instantes." : status === "ready" ? "Sem respostas registradas hoje." : "Aguardando leitura dos registros."}</p>
    </div>
    {enabled && snapshot?.scanning && <p className="scan-progress" role="status">{number.format(snapshot.scannedFiles)} arquivos lidos · {number.format(snapshot.pendingFiles)} pendentes</p>}
    {enabled && (failed || status === "error") && <p className="usage-notice" role="alert">{today ? "Últimos dados conhecidos. " : ""}Não foi possível atualizar o consumo.</p>}
    <dl className="token-breakdown">
      <div><dt>Entrada</dt><dd>{today ? number.format(today.inputTokens) : "—"}</dd></div>
      <div><dt>Saída</dt><dd>{today ? number.format(today.outputTokens) : "—"}</dd></div>
      <div><dt>Cache <span title="Parte dos tokens de entrada">⊂ entrada</span></dt><dd>{today ? number.format(today.cachedInputTokens) : "—"}</dd></div>
    </dl>
    <p className="token-help">Cache já está na entrada; raciocínio já está na saída.</p>
    <section className="usage-history" aria-label="Histórico dos últimos 14 dias">
      <div className="section-label"><h2>Últimos 14 dias</h2><span>tokens / dia</span></div>
      {days.length ? <ol className="history-bars">{days.map(day => <li key={day.date} title={`${day.date}: ${number.format(day.totalTokens)} tokens`}>
        <span className="history-bar-track"><span className="history-bar" style={{ height: `${Math.max(day.totalTokens ? 3 : 0, day.totalTokens / maximum * 100)}%` }} /></span>
        <span className="history-date">{day.date.slice(8)}</span><span className="sr-only">{day.date}: {number.format(day.totalTokens)} tokens</span>
      </li>)}</ol> : <p className="history-empty">{!desktop ? "Histórico disponível no desktop." : status === "loading" ? "Carregando histórico…" : "Sem histórico disponível."}</p>}
    </section>
    {enabled && partial && <p className="usage-notice" role="status">Dados parciais: {snapshot.pendingFiles > 0 && (snapshot.scanning ? "Leitura em andamento. " : "Aguardando conclusão dos registros. ")}{snapshot.legacyOnlyFiles > 0 && `${number.format(snapshot.legacyOnlyFiles)} arquivos legados sem IDs de resposta. `}{snapshot.invalidRecords > 0 && `${number.format(snapshot.invalidRecords)} registros não aproveitados. `}{snapshot.conflicts > 0 && `${number.format(snapshot.conflicts)} conflitos de resposta. `}Somente respostas confirmadas entram no total.</p>}
    <details className="quota-note"><summary>Limite indisponível <span aria-hidden="true">ⓘ</span></summary><p>Tokens registrados não determinam a cota nem o saldo da assinatura.</p></details>
    <p className="last-updated">{updated && !Number.isNaN(updated.getTime()) ? `Atualizado ${updated.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "Ainda sem atualização"} · uso registrado localmente</p>
  </section>;
}
