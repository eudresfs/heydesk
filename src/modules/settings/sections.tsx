// Seções da janela de configurações: cartões agrupados, cada opção com título e
// descrição, controles em tamanho de janela (não de notch) e prévia ao vivo onde ajuda.
import { useEffect, useState, type ReactNode } from "react";
import type { ShellBridge } from "../../lib/shellBridge";
import type { CalendarsControl } from "../context/useCalendars";
import type { SportsControl, TeamOption } from "../sports/useSports";
import type { useSettings } from "../../hooks/useSettings";
import { defaultMascot, defaultSounds, type MascotSettings, type SoundSettings, type ThemeSummary } from "../../lib/shellBridge";
import { forgetTheme, moodImage, useThemes, type ActiveTheme } from "../theme/useTheme";
import { noteLine, useUpdate } from "../update/useUpdate";

const noBridge = { desktop: false } as ShellBridge;
import { eyeColors, glowNames, glowPresets, optionalPages, orderPages, pageNames, shapes } from "../context/ContextPages";
import { Mascot } from "../context/Mascot";
import type { NotesControl } from "../context/useNotes";
import { SNOOZE_MIN, waterSettings } from "../context/waterPlan";
import { playSound } from "../sound/sounds";
import { setStoredFlag, useStoredFlag } from "../../lib/storedFlag";

type Settings = ReturnType<typeof useSettings>;

export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return <section className="set-group">{title && <h2>{title}</h2>}<div className="set-card">{children}</div></section>;
}
export function Row({ title, desc, children, wide }: { title: string; desc?: ReactNode; children: ReactNode; wide?: boolean }) {
  return <div className="set-row" data-wide={wide || undefined}><div className="set-text"><span className="set-title">{title}</span>{desc && <span className="set-desc">{desc}</span>}</div><div className="set-control">{children}</div></div>;
}
export function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange(next: boolean): void }) {
  return <button type="button" className="switch set-switch" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}><i /></button>;
}
export function Segmented<T extends string>({ value, options, label, onChange }: { value: T; options: readonly (readonly [T, string])[]; label: string; onChange(next: T): void }) {
  return <div className="segmented set-segmented" role="radiogroup" aria-label={label}>{options.map(([option, text]) => <button key={option} type="button" role="radio" aria-checked={value === option} onClick={() => onChange(option)}>{text}</button>)}</div>;
}
function Slider({ value, min, max, label, unit = "%", onChange }: { value: number; min: number; max: number; label: string; unit?: string; onChange(next: number): void }) {
  return <span className="set-slider"><input type="range" min={min} max={max} aria-label={label} style={{ ["--fill" as string]: `${(value - min) / (max - min) * 100}%` }} value={value} onChange={event => onChange(Number(event.target.value))} /><output>{value}{unit}</output></span>;
}

/** Prévia do notch fechado com o mascote do rascunho. */
function Preview({ settings, label, theme }: { settings: Settings; label: string; theme: ActiveTheme }) {
  const mascot = { ...defaultMascot, ...settings.draft.mascot };
  const glow = theme.hud && theme.glow ? theme.glow : mascot.glow === "custom" ? [mascot.glowColor, mascot.glowColor, mascot.glowColor] : glowPresets[mascot.glow];
  const hud = theme.hud;
  const border = hud?.border;
  const hudVars = hud ? {
    ["--preview-fill" as string]: hud.surface ? `color-mix(in srgb, ${hud.surface} ${settings.draft.appearance.opacity}%, transparent)` : undefined, ["--preview-texture" as string]: hud.texture ? `url("${hud.texture}")` : undefined, ["--preview-texture-opacity" as string]: hud.texture ? hud.textureOpacity : 0,
    ["--preview-edge" as string]: border ? `inset 1.5px 0 0 ${border}, inset -1.5px 0 0 ${border}, inset 0 -1.5px 0 ${border}` : undefined,
  } : {};
  return <div className="set-preview" aria-label={label} role="img" style={{ ["--preview-opacity" as string]: settings.draft.appearance.opacity / 100, ["--glow-a" as string]: glow[0], ["--glow-b" as string]: glow[1], ["--glow-c" as string]: glow[2], ["--accent" as string]: hud?.accent ?? settings.draft.appearance.accentColor, ...hudVars }}>
    <span className="set-preview-notch"><span className="set-preview-glow" /><time>09:41</time><Mascot expression="normal" image={moodImage("normal", theme.images)} pixelated={theme.pixelated} active={mascot.blink} reducedMotion={false} shape={mascot.eyeShape} color={mascot.eyeColor} blink={mascot.blink} bounce={mascot.bounce} pace={mascot.pace} /><i className="set-preview-dot" /></span>
  </div>;
}

const accents = ["#E5E5E5", "#0A84FF", "#30D158", "#00EB46", "#FFD60A", "#FF9F0A", "#FF453A", "#BF5AF2", "#FF375F"];

/** Mascote e visual do notch são escolhas separadas, de pacotes embutidos ou importados.
 *  Importar = escolher uma pasta com `theme.json`; o pacote aparece onde tiver conteúdo (imagens, HUD ou os dois). */
function ThemeGroup({ bridge, mascot, hud, onPick }: { bridge?: ShellBridge; mascot: string; hud: string; onPick(patch: Partial<MascotSettings>): void }) {
  const [themes, setThemes] = useState<ThemeSummary[]>([]);
  const [status, setStatus] = useState<{ busy?: boolean; error?: string; note?: string }>({});
  const [confirm, setConfirm] = useState<string | null>(null);
  const refresh = () => { void bridge?.themeList?.().then(setThemes).catch(() => setStatus({ error: "Não foi possível listar os temas." })); };
  useEffect(refresh, [bridge]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!bridge?.themeList) return null;
  const importFolder = async (list: FileList | null) => {
    const files = [...(list ?? [])];
    const folder = files[0]?.webkitRelativePath.split("/")[0] || "";
    if (!files.length || !folder || !bridge.themeImport) return;
    setStatus({ busy: true });
    try {
      const id = await bridge.themeImport(files, folder);
      forgetTheme(id);
      const next = await bridge.themeList?.() ?? [];
      setThemes(next);
      // Vai para onde o pacote tem conteúdo: mascote, notch ou os dois.
      const added = next.find(theme => theme.id === id);
      onPick({ ...(added?.hasImages ? { theme: id } : {}), ...(added?.hasHud ? { hud: id } : {}) });
      setStatus({ note: "Tema importado. Salve para aplicar no notch." });
    } catch (reason) { setStatus({ error: typeof reason === "string" ? reason : "Não foi possível importar o tema." }); }
  };
  const remove = async (id: string) => {
    setConfirm(null);
    try {
      await bridge.themeRemove?.(id); forgetTheme(id); refresh();
      const patch: Partial<MascotSettings> = { ...(mascot === id ? { theme: "eyes" } : {}), ...(hud === id ? { hud: "none" } : {}) };
      if (Object.keys(patch).length) { onPick(patch); setStatus({ note: "Tema removido. Salve para voltar ao padrão." }); }
    }
    catch (reason) { setStatus({ error: typeof reason === "string" ? reason : "Não foi possível remover o tema." }); }
  };
  const user = themes.find(theme => (theme.id === mascot || theme.id === hud) && !theme.builtIn);
  const broken = themes.filter(theme => theme.error);
  const mascots = themes.filter(theme => theme.id === "eyes" || theme.hasImages || (theme.error && !theme.builtIn));
  const huds = themes.filter(theme => theme.hasHud);
  return <Group title="Tema">
    <Row title="Mascote" desc="Os olhos padrão, um dos mascotes do Heydesk ou um pacote que você importou." wide>
      <span className="set-options">{mascots.map(theme => <button key={theme.id} type="button" className="set-option set-theme" aria-pressed={mascot === theme.id} disabled={Boolean(theme.error)} title={theme.error ?? theme.name} onClick={() => onPick({ theme: theme.id })}>
        <Mascot size="large" expression="normal" active={false} reducedMotion image={theme.hasImages ? theme.preview ?? undefined : undefined} />
        <span>{theme.name}</span>
      </button>)}</span>
      {broken.length > 0 && <span className="set-desc set-theme-errors" role="status">{broken.map(theme => <span key={theme.id}><b>{theme.name}</b>: {theme.error}</span>)}</span>}
    </Row>
    <Row title="Visual do notch" desc="Cores, moldura e ornamentos do notch. Combina com qualquer mascote." wide>
      <span className="set-options">
        <button type="button" className="set-option set-theme" data-hud="" aria-pressed={hud === "none"} onClick={() => onPick({ hud: "none" })} style={{ ["--theme-card" as string]: "#000", ["--theme-card-edge" as string]: "transparent" }}><i className="set-theme-crest" aria-hidden="true" /><span>Padrão</span></button>
        {huds.map(theme => <button key={theme.id} type="button" className="set-option set-theme" data-hud="" aria-pressed={hud === theme.id} disabled={Boolean(theme.error)} title={theme.error ?? theme.name} onClick={() => onPick({ hud: theme.id })}
          style={{ ["--theme-card" as string]: theme.surface ?? "#000", ["--theme-card-edge" as string]: theme.border ?? "transparent" }}>
          {!theme.hasImages && theme.preview ? <img className="set-theme-crest" src={theme.preview} alt="" />
            : <i className="set-theme-crest" aria-hidden="true" data-swatch={theme.glow ? "" : undefined} style={theme.glow ? { ["--swatch" as string]: `linear-gradient(90deg, ${theme.glow.join(", ")})`, ["--swatch-glow" as string]: theme.glow[0] } : undefined} />}
          <span>{theme.name}</span>
        </button>)}
      </span>
    </Row>
    <Row title="Importar tema" desc={status.error ? <span role="alert">{status.error}</span> : status.note ?? <>Escolha uma pasta com <code>theme.json</code> com as imagens do mascote (PNG ou SVG), o visual do notch ou os dois. Pastas em <code>%APPDATA%\dev.heydesk.app\themes</code> também aparecem.</>}>
      <span className="set-actions">
        {/* Input visualmente escondido mas focável: Tab chega nele e Enter/Espaço abre o seletor. */}
        <label className="set-button set-file" aria-disabled={status.busy || undefined}>{status.busy ? "Importando…" : "Importar pasta"}
          <input type="file" className="sr-only" multiple disabled={status.busy} aria-label="Importar pasta de tema" {...{ webkitdirectory: "" }} onChange={event => { void importFolder(event.target.files); event.target.value = ""; }} /></label>
        <button type="button" className="set-button" onClick={refresh}>Atualizar</button>
        {user && (confirm === user.id
          ? <button type="button" className="set-button set-danger" onClick={() => void remove(user.id)}>Remover {user.name}?</button>
          : <button type="button" className="set-button" onClick={() => setConfirm(user.id)}>Remover tema</button>)}
      </span>
    </Row>
  </Group>;
}

/** Geral: iniciar com o Windows e atualizações (salva na hora, sem o botão Salvar). */
export function GeneralSection({ bridge }: { bridge: ShellBridge }) {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const [version, setVersion] = useState("");
  const update = useUpdate(bridge, false);
  useEffect(() => {
    void bridge.getAutostart?.().then(setAutostart).catch(() => setAutostart(false));
    void bridge.appVersion?.().then(setVersion).catch(() => {});
  }, [bridge]);
  const toggle = (on: boolean) => {
    setAutostartError(null);
    void bridge.setAutostart?.(on).then(setAutostart).catch(reason => setAutostartError(typeof reason === "string" ? reason : "Não foi possível mudar o início com o Windows."));
  };
  const state = update.state;
  const status = state.kind === "checking" ? "Procurando…"
    : state.kind === "none" ? `Você já está na versão mais nova (${state.current}).`
    : state.kind === "available" ? `Versão ${state.info.version} disponível.${noteLine(state.info.notes) ? ` ${noteLine(state.info.notes)}` : ""}`
    : state.kind === "installing" ? `Baixando ${state.info.version}${state.percent ? `: ${state.percent}%` : "…"} O Heydesk reabre sozinho ao terminar.`
    : state.kind === "error" ? state.message : "Ao abrir, o Heydesk instala sozinho a versão nova. Aberto, procura a cada 30 minutos e pergunta antes de instalar.";
  return <>
    <Group title="Sistema">
      <Row title="Iniciar com o Windows" desc={autostartError ? <span role="alert">{autostartError}</span> : "Abre o Heydesk quando você entra no Windows."}>
        <Toggle label="Iniciar com o Windows" on={autostart === true} onChange={toggle} />
      </Row>
    </Group>
    <Group title="Atualizações">
      <Row title={version ? `Heydesk ${version}` : "Heydesk"} desc={<span role={state.kind === "error" ? "alert" : "status"}>{status}</span>}>
        <span className="set-actions">
          {state.kind === "available" || (state.kind === "error" && state.info)
            ? <button type="button" className="set-button set-primary" onClick={() => void update.install()}>{state.kind === "error" ? "Tentar de novo" : "Atualizar agora"}</button>
            : <button type="button" className="set-button" disabled={state.kind === "checking" || state.kind === "installing"} onClick={() => void update.check()}>Procurar atualização</button>}
        </span>
      </Row>
    </Group>
  </>;
}

/** Aparência e mascote numa seção só: a prévia mostra tudo junto. */
export function AppearanceSection({ settings, bridge }: { settings: Settings; bridge?: ShellBridge }) {
  const appearance = settings.draft.appearance;
  const mascot = { ...defaultMascot, ...settings.draft.mascot };
  const set = (patch: Partial<typeof appearance>) => settings.edit({ ...settings.draft, appearance: { ...appearance, ...patch } });
  const setMascot = (patch: Partial<MascotSettings>) => settings.edit({ ...settings.draft, mascot: { ...mascot, ...patch } });
  const theme = useThemes(bridge ?? noBridge, mascot.theme, mascot.hud);
  const themed = Boolean(theme.images);
  // Tema com HUD define brilho e destaque: os controles ficam desligados, com aviso.
  const hudOwns = Boolean(theme.hud);
  return <>
    <Preview settings={settings} label="Prévia do notch" theme={theme} />
    <ThemeGroup bridge={bridge} mascot={mascot.theme ?? "eyes"} hud={mascot.hud ?? "none"} onPick={setMascot} />
    <Group title="Ilha">
      {hudOwns && <p className="set-desc set-note">O tema escolhido define a cor de destaque e o brilho do notch.</p>}
      <Row title="Opacidade do notch fechado" desc="Quanto do fundo aparece através da ilha compacta. Aplicado ao salvar."><Slider value={appearance.opacity} min={30} max={100} label="Opacidade do notch fechado" onChange={opacity => set({ opacity })} /></Row>
      <Row title="Cor de destaque" desc="Botões principais, interruptores, barras de progresso e seleções." wide>
        <span className="set-swatches">{accents.map(color => <button key={color} type="button" className="set-swatch" disabled={hudOwns} style={{ ["--swatch" as string]: color }} aria-label={`Destaque ${color}`} aria-pressed={appearance.accentColor.toUpperCase() === color} onClick={() => set({ accentColor: color })} />)}
          <label className="set-swatch set-swatch-custom" title="Outra cor"><input type="color" aria-label="Outra cor de destaque" value={appearance.accentColor} onChange={event => set({ accentColor: event.target.value.toUpperCase() })} /></label></span>
      </Row>
      <Row title="Animações" desc="Reduzido troca molas e deslizes por transições curtas. Sistema segue o Windows."><Segmented label="Animações" value={settings.draft.motion.reducedMotion} options={[["system", "Sistema"], ["on", "Reduzido"], ["off", "Completo"]]} onChange={reducedMotion => settings.edit({ ...settings.draft, motion: { reducedMotion } })} /></Row>
    </Group>
    <Group title="Mascote">
      {themed && <p className="set-desc set-note">O tema escolhido traz o próprio mascote: formato e cor dos olhos não se aplicam.</p>}
      <Row title="Formato dos olhos" wide><span className="set-options">{shapes.map(([shape, label]) => <button key={shape} type="button" className="set-option" disabled={themed} aria-pressed={mascot.eyeShape === shape} onClick={() => setMascot({ eyeShape: shape })}><Mascot expression="normal" active={false} reducedMotion shape={shape} color={mascot.eyeColor} /><span>{label}</span></button>)}</span></Row>
      <Row title="Cor dos olhos" wide><span className="set-swatches">{eyeColors.map(([color, label]) => <button key={color} type="button" className="set-swatch" disabled={themed} style={{ ["--swatch" as string]: color }} aria-label={`Olhos ${label.toLowerCase()}`} title={label} aria-pressed={mascot.eyeColor.toUpperCase() === color} onClick={() => setMascot({ eyeColor: color })} />)}</span></Row>
      <Row title="Brilho" desc="A luz atrás do mascote, no notch e no painel." wide>
        <span className="set-swatches">{(Object.keys(glowPresets) as (keyof typeof glowPresets)[]).map(name => <button key={name} type="button" className="set-swatch" disabled={hudOwns} style={{ ["--swatch" as string]: `linear-gradient(135deg, ${glowPresets[name].join(", ")})` }} aria-label={`Brilho ${glowNames[name]}`} title={glowNames[name]} aria-pressed={mascot.glow === name} onClick={() => setMascot({ glow: name })} />)}
          <label className="set-swatch set-swatch-custom" title="Outra cor" data-active={mascot.glow === "custom" || undefined}><input type="color" aria-label="Outra cor de brilho" value={mascot.glowColor} onChange={event => setMascot({ glow: "custom", glowColor: event.target.value.toUpperCase() })} /></label></span>
      </Row>
      <Row title="Ritmo"><Segmented label="Ritmo" value={mascot.pace} options={[["calm", "Calmo"], ["lively", "Animado"]]} onChange={pace => setMascot({ pace })} /></Row>
      <Row title="Piscar" desc="Uma piscada de tempos em tempos."><Toggle label="Piscar" on={mascot.blink} onChange={blink => setMascot({ blink })} /></Row>
      <Row title="Seguir o cursor" desc="Os olhos acompanham o mouse perto do notch."><Toggle label="Seguir o cursor" on={mascot.look} onChange={look => setMascot({ look })} /></Row>
      <Row title="Reações" desc="Reage a toques, cócegas e avisos."><Toggle label="Reações" on={mascot.reactions} onChange={reactions => setMascot({ reactions })} /></Row>
      <Row title="Quique quando feliz" desc="Pula de leve com música tocando."><Toggle label="Quique quando feliz" on={mascot.bounce} onChange={bounce => setMascot({ bounce })} /></Row>
      <Row title="Mostrar no painel aberto" desc="Desligado, o mascote fica só no notch fechado."><Toggle label="Mostrar no painel aberto" on={mascot.inPanel !== false} onChange={inPanel => setMascot({ inPanel })} /></Row>
    </Group>
  </>;
}

export function SoundSection({ settings }: { settings: Settings }) {
  const sounds = { ...defaultSounds, ...settings.draft.sounds };
  const set = (patch: Partial<SoundSettings>) => settings.edit({ ...settings.draft, sounds: { ...sounds, ...patch } });
  return <>
    <Group title="Geral">
      <Row title="Sons" desc="Liga ou desliga todos os sons do Heydesk."><Toggle label="Sons" on={sounds.enabled} onChange={enabled => set({ enabled })} /></Row>
      <Row title="Volume"><span className="set-inline"><Slider value={sounds.volume} min={0} max={100} label="Volume" onChange={volume => set({ volume })} /><button type="button" className="set-button" onClick={() => playSound("reminder", sounds.pack, sounds.volume)}>Testar</button></span></Row>
      <Row title="Estilo" desc="Ao escolher, toca uma amostra."><Segmented label="Estilo dos sons" value={sounds.pack} options={[["soft", "Suave"], ["retro", "Retrô"], ["minimal", "Mínimo"]]} onChange={pack => { set({ pack }); playSound("notification", pack, sounds.volume); }} /></Row>
    </Group>
    <Group title="Quando tocar">
      <Row title="Notificações" desc="WhatsApp e outros avisos do Windows."><Toggle label="Notificações" on={sounds.notifications} onChange={notifications => set({ notifications })} /></Row>
      <Row title="Lembretes" desc="Água, agenda e tarefas."><Toggle label="Lembretes" on={sounds.reminders} onChange={reminders => set({ reminders })} /></Row>
      <Row title="Esportes" desc="Início de jogo e gols dos times seguidos."><Toggle label="Esportes" on={sounds.sports} onChange={sports => set({ sports })} /></Row>
      <Row title="Interações" desc="Abrir, fechar e tocar no mascote."><Toggle label="Interações" on={sounds.interactions} onChange={interactions => set({ interactions })} /></Row>
    </Group>
    <Group title="Silêncio">
      <Row title="Respeitar o Não perturbe" desc="Sem sons com o Não perturbe do Windows ligado ou com app em tela cheia."><Toggle label="Respeitar o Não perturbe" on={sounds.respectDnd} onChange={respectDnd => set({ respectDnd })} /></Row>
    </Group>
  </>;
}

// Páginas que dependem de um recurso: esconder a página também desliga a coleta dele.
const pageModule: Partial<Record<string, "claudeUsage" | "systemInfo">> = { limits: "claudeUsage", system: "systemInfo" };
const pageHints: Partial<Record<string, string>> = { media: "Música e vídeo tocando, com capa, controles e letra.", limits: "Cota de 5 horas e semanal do Claude.", system: "CPU, memória, bateria e rede.", sports: "Placar ao vivo dos times seguidos.", agenda: "Compromissos locais e agendas assinadas.", water: "Meta do dia e lembretes de água.", pet: "Bichinho virtual: barras, nível, missões, loja e mini-jogos. Escondido, o mascote perde os acessórios e o bichinho para de contar.", shelf: "Arquivos à mão, inclusive do celular.", prompter: "Roteiro rolando e gravação de tela." };

/** Páginas e recursos: arraste para ordenar; o interruptor mostra/esconde (e liga/desliga o recurso da página). */
export function PagesSection({ settings, notificationStatus }: { settings: Settings; notificationStatus?: string }) {
  const hidden = settings.draft.hiddenPages ?? [];
  const pages = orderPages(optionalPages, settings.draft.pageOrder);
  const modules = settings.draft.modules;
  const [drag, setDrag] = useState<{ index: number; dy: number; height: number } | null>(null);
  const target = drag ? Math.max(0, Math.min(pages.length - 1, drag.index + Math.round(drag.dy / drag.height))) : -1;
  const reorder = (from: number, to: number) => { if (from === to) return; const next = [...pages]; const [page] = next.splice(from, 1); next.splice(to, 0, page); settings.edit({ ...settings.draft, pageOrder: next }); };
  const toggle = (page: string, on: boolean) => {
    const module = pageModule[page];
    settings.edit({ ...settings.draft, hiddenPages: on ? hidden.filter(item => item !== page) : [...hidden, page], modules: module ? { ...modules, [module]: on } : modules });
  };
  const grab = (index: number) => (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const row = event.currentTarget.closest<HTMLElement>(".set-row"), startY = event.clientY;
    if (!row) return;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* sem captura: os eventos da janela bastam */ }
    const height = row.getBoundingClientRect().height;
    setDrag({ index, dy: 0, height });
    const move = (moveEvent: PointerEvent) => setDrag({ index, dy: moveEvent.clientY - startY, height });
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      setDrag(null); reorder(index, Math.max(0, Math.min(pages.length - 1, index + Math.round((upEvent.clientY - startY) / height))));
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  // Teclado: setas com o puxador focado.
  const keys = (index: number) => (event: React.KeyboardEvent) => {
    if (event.key === "ArrowUp" && index > 0) { event.preventDefault(); reorder(index, index - 1); }
    if (event.key === "ArrowDown" && index < pages.length - 1) { event.preventDefault(); reorder(index, index + 1); }
  };
  const shift = (index: number) => {
    if (!drag || index === drag.index) return undefined;
    if (drag.index < index && index <= target) return `translateY(${-drag.height}px)`;
    if (target <= index && index < drag.index) return `translateY(${drag.height}px)`;
    return undefined;
  };
  return <>
    <Group title={`Páginas · ${pages.length - hidden.length} de ${pages.length} visíveis · arraste para ordenar`}>
      <div className="set-row set-row-fixed"><span className="set-grip set-grip-off" aria-hidden="true" /><div className="set-text"><span className="set-title">{pageNames.home}</span><span className="set-desc">Sempre a primeira.</span></div></div>
      {pages.map((page, index) => <div key={page} className="set-row set-page" data-off={hidden.includes(page) || undefined} data-dragging={drag?.index === index || undefined}
        style={{ transform: drag?.index === index ? `translateY(${drag.dy}px)` : shift(index) }}>
        <button type="button" className="set-grip" aria-label={`Mover ${pageNames[page]} (setas)`} onPointerDown={grab(index)} onKeyDown={keys(index)}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" /></svg></button>
        <div className="set-text"><span className="set-title">{pageNames[page]}</span>{pageHints[page] && <span className="set-desc">{pageHints[page]}</span>}</div>
        <div className="set-control"><Toggle label={`Mostrar ${pageNames[page]}`} on={!hidden.includes(page)} onChange={on => toggle(page, on)} /></div>
      </div>)}
    </Group>
    <Group title="No notch fechado">
      <Row title="Música tocando" desc="Barras e faixa no notch; também alimenta a página Player."><Toggle label="Música tocando" on={modules.media !== false} onChange={media => settings.edit({ ...settings.draft, modules: { ...modules, media } })} /></Row>
      <Row title="Clima" desc={`Temperatura ao lado do relógio · ${settings.draft.weatherLocation?.city ?? "local não configurado"}.`}><Toggle label="Clima" on={modules.weather !== false} onChange={weather => settings.edit({ ...settings.draft, modules: { ...modules, weather } })} /></Row>
      <Row title="Avisos do WhatsApp" desc={notificationStatus === "denied" ? "O Windows negou o acesso aos avisos: Configurações › Privacidade › Notificações." : <>Chegam pelo Vincular ao Celular. No Windows, deixe ligados os avisos do WhatsApp em <b>Configurações › Sistema › Notificações</b>.</>}><Toggle label="Avisos do WhatsApp" on={modules.notifications !== false} onChange={notifications => settings.edit({ ...settings.draft, modules: { ...modules, notifications } })} /></Row>
      <Row title="Ocultar em tela cheia" desc="Some durante jogos, vídeos e apresentações."><Toggle label="Ocultar em tela cheia" on={modules.hideInFullscreen !== false} onChange={hideInFullscreen => settings.edit({ ...settings.draft, modules: { ...modules, hideInFullscreen } })} /></Row>
    </Group>
  </>;
}

const dayNames = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const minutesOf = (text: string) => { const [h, m] = text.split(":").map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null; };
const liters = (ml: number) => (ml / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });

/** Ajustes da água (salvos na hora, junto das notas). */
export function WaterSection({ notes }: { notes?: NotesControl }) {
  if (!notes) return <p className="settings-status">Água indisponível.</p>;
  const water = notes.water, settings = waterSettings(water), sips = Math.ceil(water.goalMl / settings.sip);
  const every = Math.round((settings.end - settings.start) / sips);
  const choose = (values: number[], current: number, key: "cupMl" | "bottleMl") => <span className="set-options">{values.map(value => <button key={value} type="button" className="set-chip" aria-pressed={current === value} onClick={() => notes.setWater(key === "bottleMl" ? { bottleMl: value, bottleLeftMl: Math.min(value, settings.left) } : { cupMl: value })}>{value >= 1000 ? `${liters(value)} L` : `${value} ml`}</button>)}</span>;
  return <>
    <div className="set-summary">
      <b>{sips} goles de {settings.sip} ml</b>
      <span>{water.reminders ? `Um a cada ~${every} min, das ${clock(settings.start)} às ${clock(settings.end)}` : "Lembretes desligados"}</span>
      <span className="set-summary-track" aria-hidden="true">{Array.from({ length: Math.min(sips, 40) }, (_, index) => <i key={index} style={{ left: `${(index + 1) / sips * 100}%` }} />)}</span>
    </div>
    <Group title="Meta">
      <Row title="Meta do dia" desc="Quanto beber até o fim do período.">
        <span className="set-stepper"><button type="button" aria-label="Menos 250 ml" disabled={water.goalMl <= 500} onClick={() => notes.setWater({ goalMl: water.goalMl - 250 })}>−</button><output>{liters(water.goalMl)} L</output><button type="button" aria-label="Mais 250 ml" disabled={water.goalMl >= 6000} onClick={() => notes.setWater({ goalMl: water.goalMl + 250 })}>+</button></span>
      </Row>
      <Row title="Gole" desc="Quanto cada lembrete pede." wide>{choose([50, 150, 200, 250, 300, 400, 500], settings.sip, "cupMl")}</Row>
      <Row title="Garrafa" desc="Quando acaba, o lembrete pede para encher." wide>{choose([500, 600, 750, 1000, 1500], settings.bottle, "bottleMl")}</Row>
    </Group>
    <Group title="Lembretes">
      <Row title="Lembrar de beber água"><Toggle label="Lembrar de beber água" on={water.reminders} onChange={reminders => notes.setWater({ reminders })} /></Row>
      <Row title="Período" desc="Os goles são distribuídos dentro dele.">
        <span className="set-inline"><input className="set-input" type="time" aria-label="Início" value={clock(settings.start)} onChange={event => { const n = minutesOf(event.target.value); if (n != null && n < settings.end) notes.setWater({ startMin: n }); }} /><span className="set-desc">até</span><input className="set-input" type="time" aria-label="Fim" value={clock(settings.end)} onChange={event => { const n = minutesOf(event.target.value); if (n != null && n > settings.start) notes.setWater({ endMin: n }); }} /></span>
      </Row>
      <Row title="Dias" wide><span className="set-options" role="group" aria-label="Dias com lembrete">{dayNames.map((name, day) => <button key={day} type="button" className="set-chip" aria-pressed={settings.days.includes(day)} onClick={() => notes.setWater({ days: settings.days.includes(day) ? settings.days.filter(item => item !== day) : [...settings.days, day].sort() })}>{name}</button>)}</span></Row>
      <Row title={`Soneca de ${SNOOZE_MIN} min`} desc="Ao recusar, o lembrete volta em 15 min. Desligada, o gole é pulado e a meta é redistribuída."><Toggle label="Soneca" on={settings.snooze} onChange={snooze => notes.setWater({ snooze })} /></Row>
    </Group>
  </>;
}

/** Esportes: modalidade → competições; times por competição com busca; chave do PandaScore. Salva na hora. */
export function SportsSection({ sports, bridge }: { sports?: SportsControl; bridge: ShellBridge }) {
  const [kind, setKind] = useState("Futebol");
  const [league, setLeague] = useState("");
  const [teams, setTeams] = useState<TeamOption[] | null>(null);
  const [teamsError, setTeamsError] = useState("");
  const [query, setQuery] = useState("");
  const [token, setToken] = useState("");
  const [tokenStatus, setTokenStatus] = useState("");
  const pip = useStoredFlag("heydesk.sports.pip");
  const config = sports?.config;
  const chosen = config?.leagues ?? [];
  useEffect(() => { if ((!league || !chosen.includes(league)) && chosen.length) setLeague(chosen[0]); }, [chosen.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!league || !bridge.getLeagueTeams) return;
    let active = true; setTeams(null); setTeamsError("");
    bridge.getLeagueTeams(league).then(list => { if (active) setTeams(list); }).catch(reason => { if (active) setTeamsError(typeof reason === "string" ? reason : "Não foi possível listar os times."); });
    return () => { active = false; };
  }, [league, bridge]);
  if (!sports?.available || !config) return <p className="settings-status">Esportes indisponíveis.</p>;
  const groups = sports.catalog.reduce<Record<string, [string, string][]>>((all, [id, name, group]) => ({ ...all, [group]: [...(all[group] ?? []), [id, name]] }), {});
  const nameOf = (id: string) => sports.catalog.find(item => item[0] === id)?.[1] ?? id;
  const toggleLeague = (id: string) => void sports.save(chosen.includes(id) ? chosen.filter(item => item !== id) : [...chosen, id], config.teams);
  const toggleTeam = (id: string) => { const key = `${league}|${id}`; void sports.save(chosen, config.teams.includes(key) ? config.teams.filter(item => item !== key) : [...config.teams, key]); };
  const saveToken = (value: string) => sports.save(chosen, config.teams, value).then(() => { setToken(""); setTokenStatus(value ? "Chave salva." : "Chave removida."); }).catch(() => setTokenStatus("Chave recusada. Confira e tente de novo."));
  const filtered = (teams ?? []).filter(team => team.name.toLowerCase().includes(query.trim().toLowerCase()));
  const followed = (id: string) => config.teams.filter(key => key.startsWith(`${id}|`)).length;
  return <>
    <Group title="Competições">
      <div className="set-block">
        <span className="set-options">{Object.keys(groups).map(name => { const count = groups[name].filter(([id]) => chosen.includes(id)).length; return <button key={name} type="button" className="set-chip set-tab" aria-pressed={kind === name} onClick={() => setKind(name)}>{name}{count ? <i className="set-count">{count}</i> : null}</button>; })}</span>
        <span className="set-options set-grid">{(groups[kind] ?? []).map(([id, name]) => <button key={id} type="button" className="set-pick" aria-pressed={chosen.includes(id)} onClick={() => toggleLeague(id)}><span className="set-check" aria-hidden="true" />{name}</button>)}</span>
      </div>
    </Group>
    <Group title="Times seguidos">
      {chosen.length ? <div className="set-block">
        <span className="set-options">{chosen.map(id => <button key={id} type="button" className="set-chip set-tab" aria-pressed={league === id} onClick={() => { setLeague(id); setQuery(""); }}>{nameOf(id)}{followed(id) ? <i className="set-count">{followed(id)}</i> : null}</button>)}</span>
        <input className="set-input set-search" aria-label="Buscar time" placeholder={`Buscar time em ${nameOf(league)}`} value={query} onChange={event => setQuery(event.target.value)} />
        <span className="set-options set-grid">
          {teamsError ? <span className="set-desc">{teamsError}</span> : !teams ? <span className="set-desc hd-shimmer">Carregando times…</span>
            : filtered.length ? filtered.slice(0, 60).map(team => <button key={team.id} type="button" className="set-pick" aria-pressed={config.teams.includes(`${league}|${team.id}`)} onClick={() => toggleTeam(team.id)}>{team.logo ? <img src={team.logo} alt="" /> : <span className="set-check" aria-hidden="true" />}{team.name}</button>)
            : <span className="set-desc">Nenhum time com esse nome.</span>}
        </span>
      </div> : <div className="set-block"><span className="set-desc">Escolha uma competição acima para seguir times dela.</span></div>}
    </Group>
    <Group title="Transmissão">
      <Row title="Abrir a transmissão em PiP" desc="Quando um time seguido de CS2 entra ao vivo, um vídeo pequeno abre logo abaixo do notch, sem som, no canal em português mais assistido. Também dá para abrir pelo botão Assistir."><Toggle label="Abrir a transmissão em PiP" on={pip} onChange={on => setStoredFlag("heydesk.sports.pip", on)} /></Row>
    </Group>
    <Group title="Chave do PandaScore">
      <Row title="CS2, Valorant, LoL e Dota" desc={<>Grátis em pandascore.co. A chave fica só neste computador.{tokenStatus && <b className="set-note"> {tokenStatus}</b>}</>} wide>
        <span className="set-inline set-grow">
          <input className="set-input set-grow" type="password" aria-label="Chave do PandaScore" placeholder={config.hasToken ? "Chave salva · cole outra para trocar" : "Cole a chave"} value={token} onChange={event => setToken(event.target.value.trim())} onKeyDown={event => { if (event.key === "Enter" && token) { event.preventDefault(); void saveToken(token); } }} />
          <button type="button" className="set-button set-primary" disabled={!token} onClick={() => void saveToken(token)}>Salvar</button>
          {config.hasToken && <button type="button" className="set-button" onClick={() => void saveToken("")}>Remover</button>}
        </span>
      </Row>
    </Group>
  </>;
}

const feedColors = ["#4285F4", "#34A853", "#FBBC05", "#EA4335", "#A142F4", "#FF8A1F"];
/** Agendas assinadas por link ICS (só leitura) e como achar o link em cada serviço. */
export function CalendarsSection({ calendars }: { calendars?: CalendarsControl }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  if (!calendars) return <p className="settings-status">Agendas indisponíveis.</p>;
  const keep = calendars.feeds.map(feed => ({ id: feed.id, name: feed.name, color: feed.color }));
  const run = (inputs: Parameters<CalendarsControl["save"]>[0], done: string) => { setStatus("Salvando…"); calendars.save(inputs).then(() => { setStatus(done); setName(""); setUrl(""); }).catch(error => setStatus(String(error?.message ?? error))); };
  const add = () => {
    if (!url.trim()) return;
    const color = feedColors.find(color => !calendars.feeds.some(feed => feed.color === color)) ?? feedColors[0];
    run([...keep, { id: `f${Date.now().toString(36)}`, name: name.trim(), color, url: url.trim() }], "Agenda adicionada. Os eventos chegam em alguns segundos.");
  };
  return <>
    <Group title="Agendas assinadas">
      {calendars.feeds.length ? calendars.feeds.map(feed => <div key={feed.id} className="set-row">
        <span className="set-dot" style={{ background: feed.color }} aria-hidden="true" />
        <div className="set-text"><span className="set-title">{feed.name}</span><span className="set-desc">{feed.host} · atualiza a cada 15 min</span></div>
        <div className="set-control"><button type="button" className="set-button" onClick={() => run(keep.filter(item => item.id !== feed.id), "Agenda removida.")}>Remover</button></div>
      </div>) : <div className="set-block"><span className="set-desc">Nenhuma agenda ainda. Os compromissos criados no notch continuam funcionando.</span></div>}
      {calendars.errors.length > 0 && <div className="set-block"><span className="set-desc set-warn">{calendars.errors.join(" · ")}</span></div>}
    </Group>
    <Group title="Adicionar agenda">
      <div className="set-block set-form">
        <label className="set-field"><span>Nome</span><input className="set-input" placeholder="Trabalho" maxLength={40} value={name} onChange={event => setName(event.target.value)} /></label>
        <label className="set-field set-grow"><span>Link ICS</span><input className="set-input" placeholder="https://… ou webcal://…" value={url} onChange={event => setUrl(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); add(); } }} /></label>
        <button type="button" className="set-button set-primary" disabled={!url.trim()} onClick={add}>Assinar</button>
      </div>
      {status && <div className="set-block"><span className="set-desc" role="status">{status}</span></div>}
    </Group>
    <Group title="Onde achar o link">
      <Row title="Google Agenda" desc={<>Configurações da agenda › Integrar agenda › <b>Endereço secreto no formato iCal</b>. Link de compartilhamento também serve.</>}><span /></Row>
      <Row title="iCloud" desc={<>App Calendário › Compartilhar › <b>Calendário público</b> › copiar link.</>}><span /></Row>
      <Row title="Outlook" desc={<>Configurações › Calendário › Calendários compartilhados › <b>Publicar</b> › link ICS.</>}><span /></Row>
    </Group>
  </>;
}
