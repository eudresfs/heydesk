// Mini-jogos de 10 s do bichinho. Mouse ou teclado; com movimento reduzido andam em
// degraus (4 por segundo) em vez de animar. Só transform/opacity na tela.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

const DURATION = 10_000;

/** Relógio do jogo: chama `frame(t)` (ms desde o início) até 10 s e então `end`. */
function useGameClock(reducedMotion: boolean, frame: (t: number) => void, end: () => void) {
  const latest = useRef({ frame, end });
  latest.current = { frame, end };
  useEffect(() => {
    const start = performance.now();
    let raf = 0, interval = 0, done = false;
    const tick = () => {
      const t = performance.now() - start;
      if (t >= DURATION) { if (!done) { done = true; latest.current.end(); } return false; }
      latest.current.frame(t);
      return true;
    };
    if (reducedMotion) interval = window.setInterval(() => { if (!tick()) window.clearInterval(interval); }, 250);
    else { const loop = () => { if (tick()) raf = requestAnimationFrame(loop); }; raf = requestAnimationFrame(loop); }
    return () => { cancelAnimationFrame(raf); window.clearInterval(interval); };
  }, [reducedMotion]);
}

const left = (t: number) => Math.max(0, Math.ceil((DURATION - t) / 1000));

/** Gole certo: aperte quando o marcador passar pela faixa. Acerta → fica mais rápido. */
export function GoleCerto({ reducedMotion, onEnd, onExit }: { reducedMotion: boolean; onEnd(score: number): void; onExit(): void }) {
  const [view, setView] = useState({ p: 0, t: 0, zone: .5, score: 0, flash: 0 });
  const game = useRef({ period: 1200, phase: 0, last: 0, zone: .5, score: 0, p: 0 });
  useGameClock(reducedMotion, t => {
    const g = game.current;
    g.phase += (t - g.last) / g.period; g.last = t;
    const cycle = g.phase % 2;
    g.p = cycle < 1 ? cycle : 2 - cycle;
    setView(current => ({ ...current, p: g.p, t, zone: g.zone, score: g.score }));
  }, () => onEnd(game.current.score));
  const hit = () => {
    const g = game.current, distance = Math.abs(g.p - g.zone);
    if (distance <= .09) { g.score += distance <= .03 ? 15 : 10; g.period = Math.max(450, g.period * .92); g.zone = .15 + Math.random() * .7; setView(current => ({ ...current, flash: Date.now() })); }
    else g.period = 1200;
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === " " || event.key === "Enter") { event.preventDefault(); event.stopPropagation(); hit(); }
    if (event.key === "Escape") { event.stopPropagation(); onExit(); }
  };
  return <div className="pet-game" tabIndex={0} ref={node => node?.focus()} onKeyDown={key} onClick={hit} role="application" aria-label="Gole certo: aperte espaço quando o marcador estiver na faixa">
    <div className="pet-game-head"><b>Gole certo</b><span>{view.score} pts · {left(view.t)} s</span></div>
    <div className="pet-track"><i className="pet-zone" style={{ left: `${(view.zone - .09) * 100}%` }} data-flash={view.flash || undefined} key={view.flash} /><i className="pet-marker" style={{ left: `calc(${view.p * 100}% - ${view.p * 8}px + 2px)` }} /></div>
    <span className="pet-game-hint">Espaço ou clique na hora certa · Esc sai</span>
  </div>;
}

interface Drop { id: number; lane: number; born: number }
/** Pega-gota: clique nas gotas (ou teclas 1–5) antes que caiam. Cinco seguidas, bônus. */
export function PegaGota({ reducedMotion, onEnd, onExit }: { reducedMotion: boolean; onEnd(score: number): void; onExit(): void }) {
  const [view, setView] = useState<{ drops: Drop[]; t: number; score: number; combo: number }>({ drops: [], t: 0, score: 0, combo: 0 });
  const game = useRef({ drops: [] as Drop[], next: 0, id: 0, score: 0, combo: 0, t: 0 });
  const fall = reducedMotion ? 1200 : 1600;
  useGameClock(reducedMotion, t => {
    const g = game.current;
    g.t = t;
    if (t >= g.next) { g.drops.push({ id: ++g.id, lane: Math.floor(Math.random() * 5), born: t }); g.next = t + 600; }
    const before = g.drops.length;
    g.drops = g.drops.filter(drop => t - drop.born < fall);
    if (g.drops.length < before) g.combo = 0;
    setView({ drops: [...g.drops], t, score: g.score, combo: g.combo });
  }, () => onEnd(game.current.score));
  const catchDrop = (id: number) => {
    const g = game.current;
    if (!g.drops.some(drop => drop.id === id)) return;
    g.drops = g.drops.filter(drop => drop.id !== id);
    g.combo++; g.score += 5 + (g.combo % 5 === 0 ? 10 : 0);
    setView({ drops: [...g.drops], t: g.t, score: g.score, combo: g.combo });
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.stopPropagation(); onExit(); return; }
    const lane = Number(event.key) - 1;
    if (lane >= 0 && lane < 5) {
      event.preventDefault(); event.stopPropagation();
      const lowest = game.current.drops.filter(drop => drop.lane === lane).sort((a, b) => a.born - b.born)[0];
      if (lowest) catchDrop(lowest.id);
    }
  };
  return <div className="pet-game" tabIndex={0} ref={node => node?.focus()} onKeyDown={key} role="application" aria-label="Pega-gota: clique nas gotas ou use as teclas 1 a 5">
    <div className="pet-game-head"><b>Pega-gota</b><span>{view.score} pts{view.combo >= 2 ? ` · ${view.combo} seguidas` : ""} · {left(view.t)} s</span></div>
    <div className="pet-lanes">
      {[0, 1, 2, 3, 4].map(lane => <span key={lane} className="pet-lane"><small>{lane + 1}</small></span>)}
      {view.drops.map(drop => <button key={drop.id} type="button" className="pet-drop" aria-label={`Gota na faixa ${drop.lane + 1}`}
        style={{ left: `${drop.lane * 20 + 10}%`, transform: `translate(-50%, ${Math.min(1, (view.t - drop.born) / fall) * 64}px)` }} onClick={event => { event.stopPropagation(); catchDrop(drop.id); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3s-6 6.6-6 11a6 6 0 0 0 12 0c0-4.4-6-11-6-11z" /></svg>
      </button>)}
    </div>
    <span className="pet-game-hint">Clique nas gotas ou teclas 1–5 · Esc sai</span>
  </div>;
}
