import { useEffect, useMemo, useState } from "react";
import type { ShellBridge } from "../../lib/shellBridge";
import { csSide, kickoffLabel, type CsLive, type SportGame, type SportsControl, type TeamOption } from "./useSports";
import { Digits } from "../ui/Digits";

function Logo({ src, size = 28, name }: { src: string | null; size?: number; name: string }) {
  const [failed, setFailed] = useState(false);
  return <span className="team-logo" style={{ width: size, height: size }} aria-hidden="true">
    {src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : <span>{name.slice(0, 1)}</span>}
  </span>;
}

function status(game: SportGame) {
  // Com mapas, o mapa atual já aparece na faixa de mapas: o selo diz só "AO VIVO".
  if (game.state === "in") return <span className="hd-badge" data-tone="live"><span className="live-dot" />AO VIVO{game.clock && !game.maps?.length ? ` ${game.clock}` : ""}</span>;
  if (game.state === "post") return <span className="hd-badge">FIM</span>;
  return <span className="hd-badge">{kickoffLabel(game.start, Date.now())}</span>;
}

/** Placar em destaque: logos, siglas e números leves; ponto novo acende o dígito. */
function PinButton({ game, onToggle, small }: { game: SportGame; onToggle(id: string): void; small?: boolean }) {
  return <button type="button" className={`pin-game${small ? " small" : ""}`} aria-pressed={Boolean(game.pinned)} aria-label={game.pinned ? `Parar de acompanhar ${game.home.name} × ${game.away.name}` : `Acompanhar ${game.home.name} × ${game.away.name}`} title={game.pinned ? "Acompanhando no notch" : "Acompanhar no notch"} onClick={() => onToggle(game.id)}>
    <svg width="12" height="12" viewBox="0 0 24 24" fill={game.pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
    {!small && (game.pinned ? "Acompanhando" : "Acompanhar")}
  </button>;
}

// Motivo do fim do round em ícone: explodiu, desarmou, eliminação, tempo.
const roundGlyph: Record<string, [string, string]> = {
  bomb: ["M11 5h2M12 3v2M9 8a6 6 0 1 0 6 0zM16 4l2-2", "bomba explodiu"],
  defuse: ["M4 20l7-7M14 4l6 6-8 8-6-6zM15 9l-2 2", "bomba desarmada"],
  elimination: ["M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12 2v5M12 17v5M2 12h5M17 12h5", "eliminação"],
  time: ["M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "acabou o tempo"],
};
const sameTeam = (a: string, b: string) => { const clean = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, ""); const x = clean(a), y = clean(b); return !!x && !!y && (x === y || (x.length >= 4 && y.includes(x)) || (y.length >= 4 && x.includes(y))); };

/** CS2 ao vivo (HLTV): lado de cada time, round atual e os últimos 5 rounds com o motivo. */
function CsRounds({ game, live }: { game: SportGame; live: CsLive }) {
  const homeCt = sameTeam(live.ctTeam, game.home.name) || sameTeam(live.ctTeam, game.home.short);
  const side = (home: boolean) => (home === homeCt ? "CT" : "TR");
  const last = live.history.slice(-5);
  return <div className="cs-live" aria-label="Rounds ao vivo">
    <span className="cs-side" data-side={side(true)}>{side(true)}</span>
    <span className="cs-head">R{live.round}</span>
    <span className="cs-last">{last.map(round => { const [d, label] = roundGlyph[round.reason] ?? roundGlyph.elimination; const team = round.team || (round.winner === "CT" ? live.ctTeam : live.tTeam);
      return <span key={round.round} className="cs-round" data-side={round.winner} title={`R${round.round}: ${team} (${round.winner === "CT" ? "CT" : "TR"}) · ${label}`} aria-label={`Round ${round.round}: ${team}, ${label}`}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg></span>; })}
      {!last.length && <span className="cs-wait">aguardando rounds</span>}</span>
    <span className="cs-side" data-side={side(false)}>{side(false)}</span>
  </div>;
}

/** Placar do mapa ao vivo pelo HLTV (mandante–visitante), quando o mapa é o mesmo. */
function liveScore(game: SportGame, map: { name: string | null }, live?: CsLive | null) {
  if (!live || live.gameId !== game.id || (map.name && live.map && map.name.toLowerCase() !== live.map.toLowerCase())) return null;
  const homeCt = csSide(live, game.home) === "CT";
  return homeCt ? `${live.ctScore}–${live.tScore}` : `${live.tScore}–${live.ctScore}`;
}

// Por que não há rounds ao vivo (CS2 acompanhado): procurando, fora do HLTV, verificação.
const csNote: Partial<Record<string, string>> = { searching: "Procurando a partida no HLTV…", missing: "Rounds ao vivo indisponíveis: esta partida não está no HLTV.", blocked: "HLTV pediu verificação; rounds ao vivo pausados por 30 min." };

function Scoreboard({ game, onPin, live, note }: { game: SportGame; onPin(id: string): void; live?: CsLive | null; note?: string }) {
  return <div className="scoreboard hd-enter">
    <div className="scoreboard-head"><span>{game.leagueName}</span><span className="scoreboard-actions"><PinButton game={game} onToggle={onPin} />{status(game)}</span></div>
    <div className="scoreboard-row">
      <div className="score-team"><Logo src={game.home.logo} size={34} name={game.home.name} /><span className="score-team-name"><strong title={game.home.name}>{game.home.name}</strong>{game.home.short !== game.home.name && <small>{game.home.short}</small>}</span></div>
      <div className="score-center">
        <div className="score-numbers">{game.state === "pre" ? <span className="score-vs">×</span> : <><Digits value={game.home.score ?? "0"} /><span className="score-dash">–</span><Digits value={game.away.score ?? "0"} /></>}</div>
        {game.maps && game.maps.length > 1 && <span className="score-series">MD{game.maps.length}</span>}
      </div>
      <div className="score-team away"><span className="score-team-name"><strong title={game.away.name}>{game.away.name}</strong>{game.away.short !== game.away.name && <small>{game.away.short}</small>}</span><Logo src={game.away.logo} size={34} name={game.away.name} /></div>
    </div>
    {live && live.gameId === game.id ? <CsRounds game={game} live={live} /> : note && <p className="cs-note">{note}</p>}
    {game.maps && game.maps.length > 0 && <div className="map-strip" aria-label="Mapas da série">{game.maps.map((map, index) => <div key={index} className="map-chip" data-result={map.result}>
      <span className="map-name">{map.name ?? (map.result === "live" && live?.gameId === game.id && live.map ? live.map : `Mapa ${index + 1}`)}</span>
      {map.result === "live" ? <span className="map-live"><span className="live-dot" />{liveScore(game, map, live) ?? (map.homeRounds != null && map.awayRounds != null ? `${map.homeRounds}–${map.awayRounds}` : "ao vivo")}</span>
        : map.homeRounds != null && map.awayRounds != null ? <span className="map-score"><b data-win={map.result === "home" || undefined}>{map.homeRounds}</b>–<b data-win={map.result === "away" || undefined}>{map.awayRounds}</b></span>
        : map.result === "pending" ? <span className="map-pending">a jogar</span> : map.result === "done" ? <span className="map-pending">encerrado</span> : <span className="map-score">{map.result === "home" ? game.home.short : game.away.short}</span>}
    </div>)}</div>}
  </div>;
}

function Row({ game, index, onPin }: { game: SportGame; index: number; onPin(id: string): void }) {
  return <li className="game-row hd-enter" style={{ ["--i" as string]: index }} data-followed={game.followed || undefined}>
    <span className="game-when">{game.state === "in" ? <span className="live-dot game-live" /> : null}{game.state === "in" ? (game.clock ?? "") : game.state === "post" ? "fim" : kickoffLabel(game.start, Date.now())}</span>
    <span className="game-teams"><Logo src={game.home.logo} size={14} name={game.home.name} />{game.home.short}
      <em>{game.state === "pre" ? "×" : `${game.home.score ?? 0}–${game.away.score ?? 0}`}</em>
      {game.away.short}<Logo src={game.away.logo} size={14} name={game.away.name} /></span>
    <span className="game-league">{game.leagueName}</span>
    <PinButton game={game} onToggle={onPin} small />
  </li>;
}

export function SportsPage({ sports, onConfigure }: { sports?: SportsControl; onConfigure(): void }) {
  if (!sports?.available) return <div className="statement-page"><p className="context-note">Esportes aparecem no app desktop.</p></div>;
  const games = sports.snapshot?.games ?? [];
  if (!sports.config?.leagues.length) return <div className="statement-page sports-empty hd-enter">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7l4 3-1.5 4.5h-5L8 10zM12 3v4M21 10l-5 0M3 10h5M7 20l2-5.5M17 20l-2-5.5" /></svg>
    <p className="context-note">Escolha esportes, competições e times para acompanhar. Placar ao vivo e avisos antes do jogo aparecem no notch.</p>
    <button type="button" className="save-button sports-cta" onClick={onConfigure}>Escolher</button>
  </div>;
  // Destaque: jogo do time seguido; senão, um com mapa em andamento identificado.
  const live = games.find(game => game.pinned && game.state !== "post") ?? games.find(game => game.state === "in" && game.followed) ?? games.find(game => game.state === "in" && game.clock) ?? games.find(game => game.state === "in");
  const next = games.filter(game => game !== live && game.state !== "post");
  const rounds = live && (sports.csLive?.gameId === live.id || sports.csStatus?.gameId === live.id);
  const list = (next.length ? next : games.filter(game => game !== live)).slice(0, live ? (rounds ? 0 : live.maps?.length ? 1 : 2) : 4);
  const error = sports.snapshot?.errors[0];
  return <div className="sports-page">
    {live && <Scoreboard game={live} onPin={sports.togglePin} live={sports.csLive} note={sports.csStatus?.gameId === live.id ? csNote[sports.csStatus.state] : undefined} />}
    {list.length ? <ul className="game-list">{list.map((game, index) => <Row key={game.id} game={game} index={index} onPin={sports.togglePin} />)}</ul>
      : !live && <p className="context-note">{sports.snapshot ? "Sem jogos hoje nem nos próximos 3 dias." : "Buscando jogos…"}</p>}
    {error && <p className="sports-error" role="status">{error}</p>}
  </div>;
}

type Tab = "leagues" | "teams" | "key";
export function SportsPreferences({ sports, bridge }: { sports?: SportsControl; bridge: ShellBridge }) {
  const [tab, setTab] = useState<Tab>("leagues");
  const [kind, setKind] = useState("Futebol");
  const [league, setLeague] = useState("");
  const [teams, setTeams] = useState<TeamOption[] | null>(null);
  const [teamsError, setTeamsError] = useState("");
  const [query, setQuery] = useState("");
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState("");
  const [shake, setShake] = useState(0);
  const config = sports?.config;
  const chosen = config?.leagues ?? [];
  useEffect(() => { if (!league && chosen.length) setLeague(chosen[0]); }, [chosen.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tab !== "teams" || !league || !bridge.getLeagueTeams) return;
    let active = true; setTeams(null); setTeamsError("");
    bridge.getLeagueTeams(league).then(list => { if (active) setTeams(list); }).catch(reason => { if (active) setTeamsError(typeof reason === "string" ? reason : "Não foi possível listar os times."); });
    return () => { active = false; };
  }, [tab, league, bridge]);
  const filtered = useMemo(() => (teams ?? []).filter(team => team.name.toLowerCase().includes(query.trim().toLowerCase())), [teams, query]);
  if (!sports?.available || !config) return <p className="context-note">Preferências de esportes no app desktop.</p>;
  const toggleLeague = (id: string) => void sports.save(chosen.includes(id) ? chosen.filter(item => item !== id) : [...chosen, id], config.teams);
  const toggleTeam = (id: string) => { const key = `${league}|${id}`; void sports.save(chosen, config.teams.includes(key) ? config.teams.filter(item => item !== key) : [...config.teams, key]); };
  const saveToken = (value: string) => sports.save(chosen, config.teams, value).then(() => { setToken(""); setSaved(value ? "Chave salva" : "Chave removida"); }).catch(() => { setShake(count => count + 1); setSaved(""); });
  const groups = sports.catalog.reduce<Record<string, [string, string][]>>((all, [id, name, kind]) => ({ ...all, [kind]: [...(all[kind] ?? []), [id, name]] }), {});
  const visible = 8;
  return <div className="sports-prefs">
    <div className="seg" role="tablist" aria-label="Esportes">
      {([["leagues", "Competições"], ["teams", "Times"], ["key", "Chave"]] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className="seg-item" onClick={() => setTab(id)}>{label}{id === "teams" && config.teams.length ? <i>{config.teams.length}</i> : null}</button>)}
    </div>
    {tab === "leagues" && <div className="chip-groups hd-enter">
      {/* Modalidade primeiro, competições dela depois: tudo cabe sem rolagem. */}
      <div className="kind-row">{Object.keys(groups).map(name => {
        const count = groups[name].filter(([id]) => chosen.includes(id)).length;
        return <button key={name} type="button" className="kind" aria-pressed={kind === name} onClick={() => setKind(name)}>{name}{count ? <i>{count}</i> : null}</button>;
      })}</div>
      <div className="chip-group" key={kind}>{(groups[kind] ?? []).map(([id, name]) => <button key={id} type="button" className="chip hd-enter" aria-pressed={chosen.includes(id)} onClick={() => toggleLeague(id)}>{name}</button>)}</div>
    </div>}
    {tab === "teams" && <div className="team-picker hd-enter">
      {chosen.length ? <>
        <div className="team-tools">
          <select aria-label="Competição" value={league} onChange={event => setLeague(event.target.value)}>{chosen.map(id => <option key={id} value={id}>{sports.catalog.find(item => item[0] === id)?.[1] ?? id}</option>)}</select>
          <input className="hd-input" aria-label="Buscar time" placeholder="Buscar time" value={query} onChange={event => setQuery(event.target.value)} />
        </div>
        <div className="chip-row">
          {teamsError ? <span className="sports-error">{teamsError}</span> : !teams ? <span className="hd-shimmer">Carregando times</span>
            : filtered.slice(0, visible).map(team => <button key={team.id} type="button" className="chip team-chip" aria-pressed={config.teams.includes(`${league}|${team.id}`)} onClick={() => toggleTeam(team.id)}>{team.logo && <img src={team.logo} alt="" />}{team.name}</button>)}
          {teams && filtered.length > visible && <span className="chip-more">+{filtered.length - visible} · busque</span>}
        </div>
      </> : <p className="context-note">Escolha uma competição primeiro.</p>}
    </div>}
    {tab === "key" && <div className="key-panel hd-enter">
      <p className="key-help">PandaScore (grátis) para CS2, Valorant, LoL e Dota. Crie a conta em pandascore.co e cole a chave. Fica só neste computador.</p>
      <div className="key-row" data-shake={shake || undefined} key={shake}>
        <input className="hd-input key-input" type="password" aria-label="Chave do PandaScore" placeholder={config.hasToken ? "Chave salva · cole outra para trocar" : "Cole a chave"} value={token} onChange={event => setToken(event.target.value.trim())}
          onKeyDown={event => { if (event.key === "Enter" && token) { event.preventDefault(); void saveToken(token); } }} />
        <button type="button" className="save-button" disabled={!token} onClick={() => void saveToken(token)}>Salvar</button>
        {config.hasToken && <button type="button" className="text-button" onClick={() => void saveToken("")}>Remover</button>}
      </div>
      {(saved || config.hasToken) && <span className="hd-badge" data-tone="ok">{saved || "Chave configurada"}</span>}
    </div>}
  </div>;
}
