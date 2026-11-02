// Página "Bichinho": barras, nível, moedas, missões do dia e as ações (água, carinho,
// brincar, loja). Esc volta para o início da página; cada troca de tela leva o foco junto.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cosmetics, missionDone, missions, stageNames, statHints, statNames, type PetGain, type PetStat } from "./petSim";
import { GoleCerto, PegaGota } from "./PetGames";
import type { PetControl } from "./usePet";

const statIcons: Record<PetStat, string> = {
  thirst: "M12 3s-6 6.6-6 11a6 6 0 0 0 12 0c0-4.4-6-11-6-11z",
  energy: "M13 2 4 14h7l-1 8 9-12h-7z",
  joy: "M12 21s-7-4.4-9.3-9A5.3 5.3 0 0 1 12 6.4 5.3 5.3 0 0 1 21.3 12C19 16.6 12 21 12 21z",
  focus: "M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
};
const Icon = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const Coin = () => <svg className="pet-coin" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5.5" fill="none" strokeWidth="1.6" /></svg>;

export function gainText(gain: PetGain) {
  const parts = [gain.xp ? `+${gain.xp} XP` : "", gain.coins ? `+${gain.coins} moedas` : ""].filter(Boolean).join(" · ");
  if (gain.capped === "coins") return "Moedas insuficientes";
  if (gain.capped === "level") return "Nível insuficiente";
  if (gain.capped === "snack") return "Já comeu o petisco hoje";
  const extra = gain.mission ? ` · missão: ${gain.mission.toLowerCase()}` : "";
  if (gain.capped === "minigame" && !gain.coins && !gain.xp) return "Limite de prêmios dos jogos de hoje";
  if (gain.capped === "soon" && !parts) return "Registrado. Próximo prêmio em 10 min";
  if (gain.capped === "drinks" && !parts) return "Registrado. Prêmios de água do dia esgotados";
  if (gain.capped === "pets" && !parts) return "Chega de carinho por hoje";
  if (!parts) return "";
  return `${parts}${extra}${gain.levelUp ? " · subiu de nível!" : ""}`;
}

type View = "home" | "shop" | "play" | "gole" | "gota" | { result: number; game: "gole" | "gota"; gain: PetGain | null };

export function PetPage({ pet, reducedMotion }: { pet?: PetControl; reducedMotion: boolean }) {
  const [view, setView] = useState<View>("home");
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [shown, setShown] = useState<{ text: string; key: number } | null>(null);
  const root = useRef<HTMLElement>(null);
  const viewKey = typeof view === "object" ? "result" : view;
  // Troca de tela: foco no primeiro controle da tela nova (não cai no body).
  useEffect(() => { if (viewKey !== "gole" && viewKey !== "gota") root.current?.querySelector<HTMLElement>("button, input")?.focus({ preventScroll: true }); }, [viewKey]);
  // Chip de ganho: some sozinho depois de 2,5 s (também com movimento reduzido).
  useEffect(() => {
    const gain = pet?.lastGain;
    if (!gain) return;
    const text = gainText(gain.gain);
    if (!text) return;
    setShown({ text, key: gain.key });
    const timer = window.setTimeout(() => setShown(current => current?.key === gain.key ? null : current), 2500);
    return () => window.clearTimeout(timer);
  }, [pet?.lastGain?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pet) return null;
  const state = pet.view;
  const back = (event: KeyboardEvent) => { if (event.key === "Escape" && view !== "home" && viewKey !== "gole" && viewKey !== "gota") { event.stopPropagation(); setConfirm(null); setView("home"); } };
  const finish = (game: "gole" | "gota") => (score: number) => setView({ result: score, game, gain: pet.event({ kind: "minigame", game, score }) });
  if (view === "gole") return <section className="pet-page pet-stack" aria-label="Mini-jogo Gole certo"><GoleCerto reducedMotion={reducedMotion} onEnd={finish("gole")} onExit={() => setView("home")} /></section>;
  if (view === "gota") return <section className="pet-page pet-stack" aria-label="Mini-jogo Pega-gota"><PegaGota reducedMotion={reducedMotion} onEnd={finish("gota")} onExit={() => setView("home")} /></section>;
  if (typeof view === "object") return <section ref={root} className="pet-page pet-stack pet-center" aria-label="Resultado" onKeyDown={back}>
    <b className="pet-big" role="status">{view.result} pontos</b>
    <span className="pet-muted">{view.gain ? gainText(view.gain) || "Sem prêmio desta vez" : ""}</span>
    <span className="pet-actions pet-row"><button type="button" className="chip" onClick={() => setView(view.game)}>Jogar de novo</button><button type="button" className="chip" onClick={() => setView("play")}>Outro jogo</button><button type="button" className="chip" onClick={() => setView("home")}>Voltar</button></span>
  </section>;
  if (view === "play") return <section ref={root} className="pet-page pet-stack pet-center" aria-label="Brincar" onKeyDown={back}>
    <b className="pet-title">Do que vamos brincar?</b>
    <span className="pet-games">
      <button type="button" className="pet-pick" onClick={() => setView("gole")}><b>Gole certo</b><span>Aperte espaço na hora em que o marcador passar pela faixa.</span></button>
      <button type="button" className="pet-pick" onClick={() => setView("gota")}><b>Pega-gota</b><span>Pegue as gotas antes que caiam. 5 seguidas dão bônus.</span></button>
    </span>
    <button type="button" className="text-button" onClick={() => setView("home")}>Voltar</button>
  </section>;
  if (view === "shop") return <section ref={root} className="pet-page pet-stack pet-shop-page" aria-label="Loja" onKeyDown={back}>
    <header className="pet-shop-head"><button type="button" className="text-button" onClick={() => setView("home")}>‹ Voltar</button><b>Loja</b><span className="pet-coins" aria-label={`${state.coins} moedas`}><Coin />{state.coins}</span></header>
    <div className="pet-shop">{cosmetics.map(item => {
      const snack = item.slot === "snack";
      const owned = !snack && state.owned.includes(item.id), equipped = !snack && state.equipped[item.slot as "hat" | "color"] === item.id;
      const locked = pet.level < item.minLevel, missing = Math.max(0, item.price - state.coins);
      const label = snack && state.daily.snack ? "Amanhã tem mais" : undefined;
      return <div key={item.id} className="pet-card" data-equipped={equipped || undefined} title={item.hint}>
        <b>{item.name}</b>
        {owned ? <button type="button" className="chip" aria-pressed={equipped} onClick={() => pet.event({ kind: "equip", slot: item.slot as "hat" | "color", id: equipped ? "" : item.id })}>{equipped ? "Usando" : "Usar"}</button>
          : locked ? <span className="pet-muted">Nível {item.minLevel} · {item.price}</span>
          : label ? <span className="pet-muted">{label}</span>
          : confirm === item.id ? <button type="button" className="chip chip-primary" onClick={() => { setConfirm(null); pet.event({ kind: "buy", id: item.id }); }}>Confirmar</button>
          : <button type="button" className="chip" disabled={missing > 0} aria-label={missing ? `${item.name}: faltam ${missing} moedas` : `Comprar ${item.name} por ${item.price} moedas`} onClick={() => setConfirm(item.id)}><Coin />{missing ? `faltam ${missing}` : item.price}</button>}
      </div>;
    })}</div>
  </section>;
  const done = missions.filter(item => missionDone(state, item.id)).length;
  return <section ref={root} className="pet-page" aria-label={`Bichinho ${state.name}`}>
    <div className="pet-bars">{(Object.keys(statNames) as PetStat[]).map(stat => <div key={stat} className="pet-bar" data-low={state[stat] < 20 || undefined} title={statHints[stat]}>
      <span className="pet-bar-label"><Icon d={statIcons[stat]} />{statNames[stat]}{state[stat] < 20 && <b className="pet-alert" aria-hidden="true">!</b>}</span>
      <span className="pet-track-bar" role="meter" aria-label={`${statNames[stat]}. ${statHints[stat]}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state[stat])}><i style={{ transform: `scaleX(${state[stat] / 100})` }} /></span>
    </div>)}
      <span className="pet-missions" title={missions.map(item => `${missionDone(state, item.id) ? "✓" : "○"} ${item.name}`).join("\n")}>Missões do dia: {done}/{missions.length}{done === missions.length ? " · baú aberto" : ""}</span>
    </div>
    <div className="pet-side">
      <div className="pet-head">
        {renaming ? <input className="pet-name-input" aria-label="Nome do bichinho" defaultValue={state.name} maxLength={20} autoFocus
          onBlur={event => { pet.event({ kind: "rename", name: event.target.value }); setRenaming(false); }}
          onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter") (event.target as HTMLInputElement).blur(); if (event.key === "Escape") setRenaming(false); }} />
          : <button type="button" className="pet-name" aria-label={`Renomear ${state.name}`} title="Mudar o nome" onClick={() => setRenaming(true)}>{state.name}</button>}
        <span className="pet-coins" aria-label={`${state.coins} moedas`}><Coin />{state.coins}</span>
      </div>
      <span className="pet-level">Nível {pet.level} · {stageNames[pet.stage]}{state.streak.current > 1 ? ` · ${state.streak.current} dias` : ""}{state.streak.best > 1 ? ` (recorde ${state.streak.best})` : ""}</span>
      <span className="pet-xp" role="meter" aria-label="Experiência até o próximo nível" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pet.progress * 100)}><i style={{ transform: `scaleX(${pet.progress})` }} /></span>
      <span className="pet-actions">
        <button type="button" className="chip" title="Registra um copo de água na sua meta" onClick={pet.feed}>Bebi um copo</button>
        <button type="button" className="chip" onClick={pet.pet}>Carinho</button>
        <button type="button" className="chip" onClick={() => setView("play")}>Brincar</button>
        <button type="button" className="chip" onClick={() => setView("shop")}>Loja</button>
      </span>
      <span className="pet-gain" role="status">{shown?.text ?? ""}</span>
    </div>
  </section>;
}
