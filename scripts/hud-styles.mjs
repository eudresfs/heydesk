// Gera os estilos de HUD embutidos (src-tauri/themes/<id>/): textura, joia das junções,
// brasão do topo e fundo do painel, em SVG. Arte original do Heydesk; os filetes da
// moldura são desenhados pelo app seguindo o formato do notch. Rode `node scripts/hud-styles.mjs`.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>\n`;
const glow = (id, blur, color) => `<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${blur}" result="b"/><feFlood flood-color="${color}"/><feComposite in2="b" operator="in" result="g"/><feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
const shadow = `<filter id="sh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy=".8" stdDeviation=".7" flood-color="#000" flood-opacity=".75"/></filter>`;
/** Textura que repete sem emenda: ruído fractal na cor da superfície, mais um grão fino. */
const noise = (base, [r, g, b], { freq, octaves = 4, alpha = .38, grain = .08, seed = 3 }) => svg(128, 128,
  `<filter id="n" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${octaves}" seed="${seed}" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  0 0 0 ${alpha * 2.2} -${alpha * .55}"/></filter>` +
  `<filter id="g" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="1" seed="${seed + 4}" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 ${grain * 3} -${grain}"/></filter>` +
  `<rect width="128" height="128" fill="${base}"/><rect width="128" height="128" filter="url(#n)"/><rect width="128" height="128" filter="url(#g)"/>`);
/** Joia lapidada de 20×20 (losango com facetas), usada nas junções da moldura. */
const gem = (rim, [light, mid, dark], extra = "") => svg(20, 20, `<defs>${shadow}<linearGradient id="f" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${light}"/><stop offset=".5" stop-color="${mid}"/><stop offset="1" stop-color="${dark}"/></linearGradient></defs>
<g filter="url(#sh)"><polygon points="10,1.5 18.5,10 10,18.5 1.5,10" fill="${rim}"/><polygon points="10,4 16,10 10,16 4,10" fill="url(#f)"/>
<polygon points="10,4 13,10 10,16 7,10" fill="#fff" opacity=".14"/><polygon points="10,4 13,10 7,10" fill="#fff" opacity=".35"/><circle cx="8.4" cy="7.6" r="1" fill="#fff" opacity=".85"/></g>${extra}`);

const styles = {
  reliquia: {
    name: "Relíquia",
    hud: { surface: "#16120d", text: "#f3e6c4", muted: "#cbba98", accent: "#d9a845", border: "#c29038", textureOpacity: .5, panelOpacity: .9, bevel: true, shimmer: true,
      lines: [{ color: "#d9a845", inset: 5, width: 1.5 }, { color: "#8a6224", inset: 9, width: .8 }] },
    glow: ["#d9a845", "#ff7a3d", "#ffd98a"],
    // Pedra: grão fino e veios largos e fracos (o ruído grosso parecia fumaça).
    texture: () => noise("#16120d", [.42, .33, .24], { freq: .085, octaves: 5, alpha: .3, grain: .11, seed: 7 }),
    corner: () => gem("#e7c068", ["#ffc2b4", "#c8203a", "#4a0510"]),
    crest() {
      const gold = `<linearGradient id="au" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff2c2"/><stop offset=".5" stop-color="#d9a845"/><stop offset="1" stop-color="#7a5520"/></linearGradient>`;
      const wing = `<path d="M60 7C49 3.5 37 4.5 25 12.5C37 10.5 47 12 56.5 17.5Z" fill="url(#au)"/><path d="M57 10.5C48 9 39 10 31.5 13.5M55.5 14C47.5 13.2 41 14 35.5 16" stroke="#5a3a12" stroke-width=".8" fill="none" opacity=".75"/>`;
      return svg(140, 32, `<defs>${gold}<linearGradient id="ruby" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb3a6"/><stop offset=".55" stop-color="#c41f33"/><stop offset="1" stop-color="#4a0510"/></linearGradient>${shadow}${glow("r", 2.2, "#ff5a3d")}</defs>
<g filter="url(#sh)">${wing}<g transform="matrix(-1 0 0 1 140 0)">${wing}</g>
<polygon points="70,2.5 80.5,15.5 70,28.5 59.5,15.5" fill="url(#au)"/></g>
<polygon points="70,5.5 77.5,15.5 70,25.5 62.5,15.5" fill="url(#ruby)" filter="url(#r)"/><polygon points="70,5.5 73.5,13 70,15.5 66.5,13" fill="#fff" opacity=".45"/>`);
    },
    panel: () => svg(680, 300, `<defs><radialGradient id="a" cx="340" cy="-40" r="420" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#6a4a20" stop-opacity=".85"/><stop offset=".45" stop-color="#2a1d0f" stop-opacity=".45"/><stop offset="1" stop-color="#16120d" stop-opacity="0"/></radialGradient></defs>
<rect width="680" height="300" fill="url(#a)"/><g fill="none" stroke="#d9a845" stroke-width="1">${[150, 205, 265, 335].map((r, i) => `<circle cx="340" cy="-40" r="${r}" opacity="${(.12 - i * .025).toFixed(3)}"/>`).join("")}</g>`),
  },
  arcano: {
    name: "Arcano",
    hud: { surface: "#140e1d", text: "#ece4ff", muted: "#b6a9d6", accent: "#a86bff", border: "#8a5cf0", textureOpacity: .42, panelOpacity: .95, bevel: true, shimmer: true,
      lines: [{ color: "#a86bff", inset: 6, width: 1.2, glow: true }] },
    glow: ["#a86bff", "#5b8cff", "#e06bff"],
    texture: () => noise("#140e1d", [.34, .2, .4], { freq: .055, octaves: 3, seed: 11 }),
    corner: () => svg(20, 20, `<defs>${glow("v", 1.6, "#a86bff")}<radialGradient id="p"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#d4b8ff"/><stop offset="1" stop-color="#7b4bd6"/></radialGradient></defs>
<g filter="url(#v)"><circle cx="10" cy="10" r="6.5" fill="#140e1d" stroke="#b98cff" stroke-width="1.2"/><circle cx="10" cy="10" r="3" fill="url(#p)"/></g>`),
    crest: () => svg(140, 32, `<defs>${glow("v", 1.8, "#a86bff")}<radialGradient id="p"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#d4b8ff"/><stop offset="1" stop-color="#7b4bd6"/></radialGradient></defs>
<g transform="translate(0 2.5)"><circle cx="70" cy="14" r="12.5" fill="#140e1d"/><g filter="url(#v)" fill="none" stroke-linecap="round"><circle cx="70" cy="14" r="12" stroke="#b98cff" stroke-width="1.4"/>
<path d="M70 3.6L80 20.5H60Z" stroke="#7b4bd6" stroke-width=".9"/><path d="M57.5 14Q70 5 82.5 14Q70 23 57.5 14Z" stroke="#e6d4ff" stroke-width="1.2"/>
<path d="M44 6.5H54M86 6.5H96" stroke="#a86bff" stroke-width="1.2"/></g><circle cx="70" cy="14" r="3.2" fill="url(#p)" filter="url(#v)"/></g>`),
    panel: () => {
      const stars = Array.from({ length: 52 }, (_, i) => { const x = (i * 137.5) % 680, y = (i * 61.7) % 300; return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${((i % 3) * .35 + .45).toFixed(2)}" opacity="${(.14 + (i % 4) * .09).toFixed(2)}"/>`; }).join("");
      return svg(680, 300, `<defs><radialGradient id="a" cx="520" cy="40" r="300" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#6a33b8" stop-opacity=".7"/><stop offset="1" stop-color="#140e1d" stop-opacity="0"/></radialGradient><radialGradient id="b" cx="130" cy="290" r="260" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2a3a9a" stop-opacity=".55"/><stop offset="1" stop-color="#140e1d" stop-opacity="0"/></radialGradient></defs>
<rect width="680" height="300" fill="url(#a)"/><rect width="680" height="300" fill="url(#b)"/><g fill="#efe4ff">${stars}</g>`);
    },
  },
  neon: {
    name: "Neon",
    hud: { surface: "#0b0c13", text: "#eaf6ff", muted: "#a3b6ca", accent: "#ff3ea5", border: "#3cf2ff", textureOpacity: .3, panelOpacity: .95, bevel: false, shimmer: true,
      lines: [{ color: "#3cf2ff", inset: 5, width: 1.3, glow: true }, { color: "#ff3ea5", inset: 9, width: .7 }] },
    glow: ["#3cf2ff", "#ff3ea5", "#8b5cff"],
    texture: () => svg(128, 128, `<filter id="n" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".004 .9" numOctaves="2" seed="5" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 .55  0 0 0 0 .62  0 0 0 0 .75  0 0 0 .6 -.25"/></filter>
<rect width="128" height="128" fill="#0b0c13"/><rect width="128" height="128" filter="url(#n)"/><g fill="#fff" opacity=".04">${Array.from({ length: 43 }, (_, i) => `<rect y="${i * 3}" width="128" height="1"/>`).join("")}</g>`),
    corner: () => svg(20, 20, `<defs>${glow("m", 1.4, "#ff3ea5")}</defs><g filter="url(#m)"><rect x="5" y="5" width="10" height="10" fill="#0b0c13" stroke="#ff3ea5" stroke-width="1.4" transform="rotate(45 10 10)"/><rect x="8" y="8" width="4" height="4" fill="#3cf2ff" transform="rotate(45 10 10)"/></g>`),
    crest: () => svg(140, 32, `<defs>${glow("c", 1.6, "#3cf2ff")}${glow("m", 1.8, "#ff3ea5")}</defs>
<g filter="url(#c)" fill="#3cf2ff">${[0, 1, 2, 3].map(i => `<rect x="${32 + i * 6}" y="4" width="3.5" height="2.5"/><rect x="${104.5 - i * 6}" y="4" width="3.5" height="2.5"/>`).join("")}</g>
<polygon points="70,2.5 81,8.8 81,21.2 70,27.5 59,21.2 59,8.8" fill="#0b0c13" stroke="#ff3ea5" stroke-width="1.6" filter="url(#m)"/><polygon points="70,9 76,15 70,21 64,15" fill="#3cf2ff" filter="url(#c)"/>`),
    panel: () => {
      const v = Array.from({ length: 23 }, (_, i) => `<path d="M340 26L${i * 64 - 364} 300"/>`).join("");
      const h = [34, 44, 58, 78, 106, 146, 206, 290].map(y => `<path d="M0 ${y}H680"/>`).join("");
      return svg(680, 300, `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a1050" stop-opacity=".75"/><stop offset=".3" stop-color="#140a22" stop-opacity=".25"/><stop offset="1" stop-color="#0b0c13" stop-opacity="0"/></linearGradient><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity=".15"/></linearGradient><mask id="m"><rect width="680" height="300" fill="url(#fade)"/></mask></defs>
<rect width="680" height="300" fill="url(#s)"/><g stroke="#ff3ea5" stroke-width=".8" opacity=".14" mask="url(#m)">${v}${h}</g>`);
    },
  },
  // Final de campeonato (Major de CS2): entra sozinho durante jogo ao vivo de time seguido.
  // Arte original: louros, estrela e holofotes; nada de marca ou logo de torneio.
  major: {
    name: "Major",
    hud: { surface: "#0b1322", text: "#f4f1e6", muted: "#c3c8d4", accent: "#f2c14e", border: "#e2b445", textureOpacity: .45, panelOpacity: .95, bevel: true, shimmer: true,
      lines: [{ color: "#f2c14e", inset: 5, width: 1.5, glow: true }, { color: "#f4f1e6", inset: 9, width: .6 }] },
    glow: ["#f2c14e", "#4f8cff", "#ffe7a3"],
    // Metal escovado: ruído esticado na horizontal, bem fraco.
    texture: () => noise("#0b1322", [.3, .38, .55], { freq: ".012 .5", octaves: 2, alpha: .28, grain: .06, seed: 21 }),
    corner: () => svg(20, 20, `<defs>${shadow}${glow("s", 1.3, "#f2c14e")}<linearGradient id="au" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff4cf"/><stop offset=".55" stop-color="#f2c14e"/><stop offset="1" stop-color="#8a6116"/></linearGradient></defs>
<g filter="url(#s)"><polygon points="10,2 12.1,7.6 18,7.8 13.4,11.5 15,17.3 10,13.9 5,17.3 6.6,11.5 2,7.8 7.9,7.6" fill="url(#au)" stroke="#5a3d0c" stroke-width=".5"/><circle cx="8.6" cy="7.4" r=".9" fill="#fff" opacity=".85"/></g>`),
    crest() {
      const gold = `<linearGradient id="au" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff4cf"/><stop offset=".5" stop-color="#f2c14e"/><stop offset="1" stop-color="#8a6116"/></linearGradient>`;
      // Meio ramo de louro: folhas em arco subindo para o centro.
      const leaves = Array.from({ length: 6 }, (_, i) => { const t = i / 5, x = 30 + t * 26, y = 22 - Math.sin(t * Math.PI * .55) * 12, a = -40 + t * 55;
        return `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="4.2" ry="1.9" transform="rotate(${a.toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`; }).join("");
      const branch = `<path d="M28 24Q44 20 57 10" stroke="#8a6116" stroke-width="1" fill="none"/><g fill="url(#au)">${leaves}</g>`;
      return svg(140, 32, `<defs>${gold}${shadow}${glow("g", 2, "#f2c14e")}</defs>
<g filter="url(#sh)">${branch}<g transform="matrix(-1 0 0 1 140 0)">${branch}</g>
<circle cx="70" cy="15" r="11" fill="#0b1322" stroke="url(#au)" stroke-width="1.6"/></g>
<polygon points="70,6.5 72.6,12.4 79,12.8 74.1,16.9 75.7,23.2 70,19.6 64.3,23.2 65.9,16.9 61,12.8 67.4,12.4" fill="url(#au)" filter="url(#g)"/>`);
    },
    panel: () => {
      const beams = [-1, 1].map(side => `<path d="M${340 + side * 150} -20L${340 + side * 40} 300L${340 + side * 250} 300Z" fill="url(#beam)"/>`).join("");
      const confetti = Array.from({ length: 34 }, (_, i) => { const x = (i * 97.3) % 680, y = (i * 43.1) % 300, c = ["#f2c14e", "#4f8cff", "#f4f1e6"][i % 3];
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="3" height="1.4" fill="${c}" opacity="${(.18 + (i % 4) * .07).toFixed(2)}" transform="rotate(${(i * 37) % 180} ${x.toFixed(1)} ${y.toFixed(1)})"/>`; }).join("");
      return svg(680, 300, `<defs><radialGradient id="a" cx="340" cy="-30" r="380" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2b4a8a" stop-opacity=".8"/><stop offset=".5" stop-color="#132240" stop-opacity=".35"/><stop offset="1" stop-color="#0b1322" stop-opacity="0"/></radialGradient>
<linearGradient id="beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe7a3" stop-opacity=".16"/><stop offset="1" stop-color="#ffe7a3" stop-opacity="0"/></linearGradient></defs>
<rect width="680" height="300" fill="url(#a)"/>${beams}${confetti}`);
    },
  },
  // Vidro fosco no espírito do macOS/iOS: cinza grafite, borda fina, azul de sistema e
  // reflexos coloridos desfocados. Sem joias nem brasão; nenhuma marca ou ícone da Apple.
  vidro: {
    name: "Vidro",
    hud: { surface: "#1c1c1e", text: "#f5f5f7", muted: "#a1a1a6", accent: "#0a84ff", border: "#48484a", card: "#2c2c2e", textureOpacity: .35, panelOpacity: .9, bevel: false, shimmer: false,
      lines: [{ color: "#4a4a4e", inset: 1, width: .6 }] },
    glow: ["#0a84ff", "#5e5ce6", "#64d2ff"],
    // Só o grão fino do vidro fosco, sem veios.
    texture: () => noise("#1c1c1e", [.11, .11, .12], { freq: .9, octaves: 1, alpha: .12, grain: .05, seed: 31 }),
    panel: () => {
      const blob = (cx, cy, r, color, o) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" opacity="${o}"/>`;
      return svg(680, 300, `<defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="60"/></filter>
<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".07"/><stop offset=".35" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
<g filter="url(#b)">${blob(170, 10, 120, "#0a84ff", .32)}${blob(470, -10, 140, "#5e5ce6", .28)}${blob(600, 200, 110, "#64d2ff", .14)}${blob(60, 260, 100, "#bf5af2", .12)}</g>
<rect width="680" height="300" fill="url(#sheen)"/>`);
    },
  },
};

const root = join(import.meta.dirname, "..", "src-tauri", "themes");
for (const [id, style] of Object.entries(styles)) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, "frame.svg"), { force: true });
  const parts = ["texture", "corner", "crest", "panel"].filter(part => style[part]);
  for (const part of ["corner", "crest"]) if (!style[part]) rmSync(join(dir, `${part}.svg`), { force: true });
  for (const part of parts) writeFileSync(join(dir, `${part}.svg`), style[part]());
  writeFileSync(join(dir, "theme.json"), JSON.stringify({
    schema: 1, name: style.name, author: "Heydesk",
    colors: { glow: style.glow },
    hud: { ...style.hud, ...Object.fromEntries(parts.map(part => [part, `${part}.svg`])) },
  }, null, 2) + "\n");
}
console.log("estilos de HUD gerados em", root);
