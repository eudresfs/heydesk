// Página "Bichinho": barras, nível, moedas e as ações (alimentar, carinho, brincar, loja).
import { useState } from "react";
import { cosmetics, stageNames, statNames, type PetGain, type PetStat } from "./petSim";
import { GoleCerto, PegaGota } from "./PetGames";
import type { PetControl } from "./usePet";

const statIcons: Record<PetStat, string> = {
  thirst: "M12 3s-6 6.6-6 11a6 6 0 0 0 12 0c0-4.4-6-11-6-11z",
  energy: "M13 2 4 14h7l-1 8 9-12h-7z",
  joy: "M12 21s-7-4.4-9.3-9A5.3 5.3 0 0 1 12 6.4 5.3 5.3 0 0 1 21.3 12C19 16.6 12 21 12 21z",
  focus: "M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
};
const Icon = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const Coin = () => <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#f2c94c" /><circle cx="12" cy="12" r="5.5" fill="none" stroke="#b8862f" strokeWidth="1.6" /></svg>;

function gainText(gain: PetGain) {
  const parts = [gain.xp ? `+${gain.xp} XP` : "", gain.coins ? `+${gain.coins} moedas` : ""].filter(Boolean).join(" · ");
  if (gain.capped === "coins") return "Moedas insuficientes";
  if (gain.capped === "level") return "Nível insuficiente";
  if (gain.capped === "minigame" && !gain.coins) return `${parts || "+0"} · moedas do dia esgotadas`;
  if (gain.capped && !parts) return "Por hoje chega disso";
  return gain.levelUp ? `${parts} · subiu de nível!` : parts;
}

type View = "home" | "shop" | "play" | "gole" | "gota" | { result: number; gain: PetGain | null };

export function PetPage({ pet, reducedMotion }: { pet?: PetControl; reducedMotion: boolean }) {
  const [view, setView] = useState<View>("home");
  const [renaming, setRenaming] = useState(false);
  if (!pet) return null;
  const state = pet.view;
  const finish = (game: "gole" | "gota") => (score: number) => setView({ result: score, gain: pet.event({ kind: "minigame", game, score }) });
  if (view === "gole") return <section className="pet-page" aria-label="Mini-jogo"><GoleCerto reducedMotion={reducedMotion} onEnd={finish("gole")} onExit={() => setView("home")} /></section>;
  if (view === "gota") return <section className="pet-page" aria-label="Mini-jogo"><PegaGota reducedMotion={reducedMotion} onEnd={finish("gota")} onExit={() => setView("home")} /></section>;
  if (typeof view === "object") return <section className="pet-page pet-center" aria-label="Resultado">
    <b className="pet-big">{view.result} pontos</b>
    <span className="pet-muted">{view.gain ? gainText(view.gain) : ""}</span>
    <span className="pet-actions"><button type="button" className="chip" onClick={() => setView("play")}>De novo</button><button type="button" className="chip" onClick={() => setView("home")}>Voltar</button></span>
  </section>;
  if (view === "play") return <section className="pet-page pet-center" aria-label="Brincar">
    <b className="pet-title">Do que vamos brincar?</b>
    <span className="pet-games">
      <button type="button" className="pet-pick" onClick={() => setView("gole")}><b>Gole certo</b><span>Aperte na hora em que o marcador passar pela faixa.</span></button>
      <button type="button" className="pet-pick" onClick={() => setView("gota")}><b>Pega-gota</b><span>Pegue as gotas antes que caiam no chão.</span></button>
    </span>
    <button type="button" className="text-button" onClick={() => setView("home")}>Voltar</button>
  </section>;
  if (view === "shop") return <section className="pet-page" aria-label="Loja">
    <header className="pet-shop-head"><button type="button" className="text-button" onClick={() => setView("home")}>‹ Voltar</button><b>Loja</b><span className="pet-coins"><Coin />{state.coins}</span></header>
    <div className="pet-shop">{cosmetics.map(item => {
      const owned = state.owned.includes(item.id), equipped = state.equipped[item.slot] === item.id, locked = pet.level < item.minLevel;
      return <div key={item.id} className="pet-card" data-equipped={equipped || undefined}>
        <b>{item.name}</b>
        {owned ? <button type="button" className="chip" aria-pressed={equipped} onClick={() => pet.event({ kind: "equip", slot: item.slot, id: equipped ? "" : item.id })}>{equipped ? "Usando" : "Usar"}</button>
          : locked ? <span className="pet-muted">Nível {item.minLevel}</span>
          : <button type="button" className="chip" disabled={state.coins < item.price} onClick={() => pet.event({ kind: "buy", id: item.id })}><Coin />{item.price}</button>}
      </div>;
    })}</div>
  </section>;
  const gain = pet.lastGain && Date.now() - pet.lastGain.key < 2500 ? pet.lastGain : null;
  return <section className="pet-page" aria-label={`Bichinho ${state.name}`}>
    <div className="pet-bars">{(Object.keys(statNames) as PetStat[]).map(stat => <div key={stat} className="pet-bar" data-low={state[stat] < 20 || undefined}>
      <span className="pet-bar-label"><Icon d={statIcons[stat]} />{statNames[stat]}</span>
      <span className="pet-track-bar" role="meter" aria-label={statNames[stat]} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state[stat])}><i style={{ transform: `scaleX(${state[stat] / 100})` }} /></span>
    </div>)}</div>
    <div className="pet-side">
      <div className="pet-head">
        {renaming ? <input className="pet-name-input" aria-label="Nome do bichinho" defaultValue={state.name} maxLength={20} autoFocus
          onBlur={event => { pet.event({ kind: "rename", name: event.target.value }); setRenaming(false); }}
          onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter") (event.target as HTMLInputElement).blur(); if (event.key === "Escape") setRenaming(false); }} />
          : <button type="button" className="pet-name" title="Mudar o nome" onClick={() => setRenaming(true)}>{state.name}</button>}
        <span className="pet-coins"><Coin />{state.coins}</span>
      </div>
      <span className="pet-level">Nível {pet.level} · {stageNames[pet.stage]}{state.streak.current > 1 ? ` · ${state.streak.current} dias seguidos` : ""}</span>
      <span className="pet-xp" role="meter" aria-label="Experiência até o próximo nível" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pet.progress * 100)}><i style={{ transform: `scaleX(${pet.progress})` }} /></span>
      <span className="pet-actions">
        <button type="button" className="chip" onClick={pet.feed}>Alimentar</button>
        <button type="button" className="chip" onClick={pet.pet}>Carinho</button>
        <button type="button" className="chip" onClick={() => setView("play")}>Brincar</button>
        <button type="button" className="chip" onClick={() => setView("shop")}>Loja</button>
      </span>
      {gain && <span className="pet-gain" key={gain.key} role="status">{gainText(gain.gain)}</span>}
    </div>
  </section>;
}
