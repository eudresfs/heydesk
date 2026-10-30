// Seções da janela de configurações: cartões agrupados, cada opção com título e
// descrição, controles em tamanho de janela (não de notch) e prévia ao vivo onde ajuda.
import type { ReactNode } from "react";
import type { useSettings } from "../../hooks/useSettings";
import { defaultMascot, defaultSounds, type MascotSettings, type SoundSettings } from "../../lib/shellBridge";
import { eyeColors, glowNames, glowPresets, optionalPages, orderPages, pageNames, shapes } from "../context/ContextPages";
import { Mascot } from "../context/Mascot";
import type { NotesControl } from "../context/useNotes";
import { SNOOZE_MIN, waterSettings } from "../context/waterPlan";
import { playSound } from "../sound/sounds";

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
function Preview({ settings, label }: { settings: Settings; label: string }) {
  const mascot = { ...defaultMascot, ...settings.draft.mascot };
  const glow = mascot.glow === "custom" ? [mascot.glowColor, mascot.glowColor, mascot.glowColor] : glowPresets[mascot.glow];
  return <div className="set-preview" aria-label={label} role="img" style={{ ["--preview-opacity" as string]: settings.draft.appearance.opacity / 100, ["--glow-a" as string]: glow[0], ["--glow-b" as string]: glow[1], ["--glow-c" as string]: glow[2], ["--accent" as string]: settings.draft.appearance.accentColor }}>
    <span className="set-preview-notch"><span className="set-preview-glow" /><time>09:41</time><Mascot expression="normal" active={mascot.blink} reducedMotion={false} shape={mascot.eyeShape} color={mascot.eyeColor} blink={mascot.blink} bounce={mascot.bounce} pace={mascot.pace} /><i className="set-preview-dot" /></span>
  </div>;
}

const accents = ["#E5E5E5", "#0A84FF", "#30D158", "#00EB46", "#FFD60A", "#FF9F0A", "#FF453A", "#BF5AF2", "#FF375F"];

export function AppearanceSection({ settings }: { settings: Settings }) {
  const appearance = settings.draft.appearance;
  const set = (patch: Partial<typeof appearance>) => settings.edit({ ...settings.draft, appearance: { ...appearance, ...patch } });
  return <>
    <Preview settings={settings} label="Prévia do notch" />
    <Group title="Ilha">
      <Row title="Opacidade do notch fechado" desc="Quanto do fundo aparece através da ilha quando ela está compacta."><Slider value={appearance.opacity} min={70} max={100} label="Opacidade do notch fechado" onChange={opacity => set({ opacity })} /></Row>
      <Row title="Cor de destaque" desc="Pinta botões principais, interruptores, barras de progresso e seleções." wide>
        <span className="set-swatches">{accents.map(color => <button key={color} type="button" className="set-swatch" style={{ ["--swatch" as string]: color }} aria-label={`Destaque ${color}`} aria-pressed={appearance.accentColor.toUpperCase() === color} onClick={() => set({ accentColor: color })} />)}
          <label className="set-swatch set-swatch-custom" title="Outra cor"><input type="color" aria-label="Outra cor de destaque" value={appearance.accentColor} onChange={event => set({ accentColor: event.target.value.toUpperCase() })} /></label></span>
      </Row>
    </Group>
    <Group title="Movimento">
      <Row title="Animações" desc="Reduzido troca molas e deslizes por transições curtas. Sistema segue o Windows."><Segmented label="Animações" value={settings.draft.motion.reducedMotion} options={[["system", "Sistema"], ["on", "Reduzido"], ["off", "Completo"]]} onChange={reducedMotion => settings.edit({ ...settings.draft, motion: { reducedMotion } })} /></Row>
    </Group>
  </>;
}

export function MascotSection({ settings }: { settings: Settings }) {
  const mascot = { ...defaultMascot, ...settings.draft.mascot };
  const set = (patch: Partial<MascotSettings>) => settings.edit({ ...settings.draft, mascot: { ...mascot, ...patch } });
  return <>
    <Preview settings={settings} label="Prévia do mascote" />
    <Group title="Rosto">
      <Row title="Formato dos olhos" wide><span className="set-options">{shapes.map(([shape, label]) => <button key={shape} type="button" className="set-option" aria-pressed={mascot.eyeShape === shape} onClick={() => set({ eyeShape: shape })}><Mascot expression="normal" active={false} reducedMotion shape={shape} color={mascot.eyeColor} /><span>{label}</span></button>)}</span></Row>
      <Row title="Cor dos olhos" wide><span className="set-swatches">{eyeColors.map(([color, label]) => <button key={color} type="button" className="set-swatch" style={{ ["--swatch" as string]: color }} aria-label={`Olhos ${label.toLowerCase()}`} title={label} aria-pressed={mascot.eyeColor.toUpperCase() === color} onClick={() => set({ eyeColor: color })} />)}</span></Row>
      <Row title="Brilho" desc="A luz atrás do mascote, no notch e no painel." wide>
        <span className="set-swatches">{(Object.keys(glowPresets) as (keyof typeof glowPresets)[]).map(name => <button key={name} type="button" className="set-swatch" style={{ ["--swatch" as string]: `linear-gradient(135deg, ${glowPresets[name].join(", ")})` }} aria-label={`Brilho ${glowNames[name]}`} title={glowNames[name]} aria-pressed={mascot.glow === name} onClick={() => set({ glow: name })} />)}
          <label className="set-swatch set-swatch-custom" title="Outra cor" data-active={mascot.glow === "custom" || undefined}><input type="color" aria-label="Outra cor de brilho" value={mascot.glowColor} onChange={event => set({ glow: "custom", glowColor: event.target.value.toUpperCase() })} /></label></span>
      </Row>
    </Group>
    <Group title="Comportamento">
      <Row title="Piscar" desc="Uma piscada de tempos em tempos."><Toggle label="Piscar" on={mascot.blink} onChange={blink => set({ blink })} /></Row>
      <Row title="Seguir o cursor" desc="Os olhos acompanham o mouse perto do notch."><Toggle label="Seguir o cursor" on={mascot.look} onChange={look => set({ look })} /></Row>
      <Row title="Reações" desc="Reage a toques, cócegas e avisos."><Toggle label="Reações" on={mascot.reactions} onChange={reactions => set({ reactions })} /></Row>
      <Row title="Quique quando feliz" desc="Pula de leve com música tocando."><Toggle label="Quique quando feliz" on={mascot.bounce} onChange={bounce => set({ bounce })} /></Row>
      <Row title="Ritmo"><Segmented label="Ritmo" value={mascot.pace} options={[["calm", "Calmo"], ["lively", "Animado"]]} onChange={pace => set({ pace })} /></Row>
      <Row title="Mostrar no painel aberto" desc="Desligado, o mascote fica só no notch fechado."><Toggle label="Mostrar no painel aberto" on={mascot.inPanel !== false} onChange={inPanel => set({ inPanel })} /></Row>
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

const moduleRows = [
  ["media", "Player do Windows", "Música e vídeo tocando, com capa, controles e letra."],
  ["claudeUsage", "Uso do Claude", "Cota de 5 horas e semanal da sua conta."],
  ["systemInfo", "CPU e memória", "Uso do sistema, bateria e rede na página Sistema."],
  ["weather", "Clima no notch fechado", null],
  ["notifications", "Avisos do WhatsApp", "Mensagens que chegam pelo Vincular ao Celular."],
  ["hideInFullscreen", "Ocultar em tela cheia", "Some durante jogos, vídeos e apresentações."],
] as const;

export function ModulesSection({ settings, notificationStatus }: { settings: Settings; notificationStatus?: string }) {
  const modules = settings.draft.modules;
  return <Group title="O que o notch acompanha">
    {moduleRows.map(([key, title, desc]) => <Row key={key} title={title} desc={key === "weather" ? `Local: ${settings.draft.weatherLocation?.city ?? "não configurado"}.` : key === "notifications" && notificationStatus === "denied" ? "Permita em Configurações do Windows › Privacidade › Notificações." : desc}>
      <Toggle label={title} on={modules[key] !== false} onChange={on => settings.edit({ ...settings.draft, modules: { ...modules, [key]: on } })} />
    </Row>)}
  </Group>;
}

export function PagesSection({ settings }: { settings: Settings }) {
  const hidden = settings.draft.hiddenPages ?? [];
  const pages = orderPages(optionalPages, settings.draft.pageOrder);
  const move = (index: number, by: number) => { const next = [...pages]; const [page] = next.splice(index, 1); next.splice(index + by, 0, page); settings.edit({ ...settings.draft, pageOrder: next }); };
  const toggle = (page: string, on: boolean) => settings.edit({ ...settings.draft, hiddenPages: on ? hidden.filter(item => item !== page) : [...hidden, page] });
  return <Group title={`Ordem no dock · ${pages.length - hidden.length} de ${pages.length} visíveis`}>
    <div className="set-row set-row-fixed"><span className="set-order">1</span><div className="set-text"><span className="set-title">{pageNames.home}</span><span className="set-desc">Sempre a primeira.</span></div></div>
    {pages.map((page, index) => <div key={page} className="set-row" data-off={hidden.includes(page) || undefined}>
      <span className="set-order">{index + 2}</span>
      <div className="set-text"><span className="set-title">{pageNames[page]}</span></div>
      <div className="set-control">
        <button type="button" className="set-icon" aria-label={`Subir ${pageNames[page]}`} disabled={index === 0} onClick={() => move(index, -1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg></button>
        <button type="button" className="set-icon" aria-label={`Descer ${pageNames[page]}`} disabled={index === pages.length - 1} onClick={() => move(index, 1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg></button>
        <Toggle label={`Mostrar ${pageNames[page]}`} on={!hidden.includes(page)} onChange={on => toggle(page, on)} />
      </div>
    </div>)}
  </Group>;
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
      <Row title="Gole" desc="Quanto cada lembrete pede." wide>{choose([150, 200, 250, 300, 400, 500], settings.sip, "cupMl")}</Row>
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
