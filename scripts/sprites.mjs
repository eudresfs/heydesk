// Gera os mascotes embutidos (src-tauri/themes/<id>/<humor>.svg) a partir das grades
// 16×16 em pixel art. Arte original do Heydesk; rode `node scripts/sprites.mjs`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const grids = {
  geleu: { name: "Geléu", eyes: [[5, 9], [10, 9]], rows: [
    "................", "........xx......", ".......xxx......", "........o.......",
    ".....oooooo.....", "...oobbbbbboo...", "..obhhbbbbbbbo..", ".obhhbbbbbbbbbo.",
    ".obhbbbbbbbbbbo.", "obbbbbbbbbbbbbbo", "obbbbbbbbbbbbbbo", "obbbbbbbbbbbbsbo",
    "obsbbbbbbbbbssbo", "osssbbbbbbbsssso", ".osssssssssssso.", "..oooooooooooo.."] },
  lunito: { name: "Lunito", eyes: [[5, 8], [10, 8]], rows: [
    "....oo....oo....", "...obxo..oxbo...", "...obxo..oxbo...", "...obxo..oxbo...",
    "...obbo..obbo...", "..oobbbbbbbboo..", ".obhhbbbbbbbbbo.", ".obhbbbbbbbbbbo.",
    "obbbbbbbbbbbbbbo", "obbbbbbbbbbbbbbo", "obxbbbbbbbbbbxbo", "obbbbbbbbbbbbbbo",
    ".obbbbbbbbbbbbo.", ".osbbbbbbbbbbso.", "..osssssssssso..", "...oooooooooo..."] },
  taturi: { name: "Taturi", eyes: [[10, 9], [13, 9]], rows: [
    "................", "................", "................", "................",
    "..........o..o..", "...........oo...", ".........oooooo.", "........obhhbbbo",
    "........obhbbbbo", "...oooo.obbbbbbo", "..obhbboobbbbbbo", ".obbbbbbobbbbbbo",
    ".obbbbbbobxbbxbo", ".osbbbbsobbbbbso", "..ossssoossssso.", "...oooo..oooooo."] },
  zunzum: { name: "Zunzum", eyes: [[5, 8], [10, 8]], rows: [
    "................", "..www......www..", ".wwwww....wwwww.", ".wwwwwo..owwwww.",
    "..wwwoooooowww..", "....obbbbbbo....", "...obhhbbbbbo...", "..obhbbbbbbbbo..",
    "..obbbbbbbbbbo..", "..obbbbbbbbbbo..", "..oxxxxxxxxxxo..", "..obbbbbbbbbbo..",
    "...osssssssso...", "....oooooooo....", ".....o....o.....", "................"] },
};
const palettes = {
  geleu: { o: "#1d3b34", b: "#5fd3a8", h: "#c8ffe9", s: "#2f9a78", x: "#7bc043", w: "#ffffff", e: "#14102a" },
  lunito: { o: "#3a2d4f", b: "#f1ecff", h: "#ffffff", s: "#bdb2e3", x: "#ff9fc4", w: "#ffffff", e: "#14102a" },
  taturi: { o: "#24361a", b: "#a3d65c", h: "#e2f7b5", s: "#6f9e34", x: "#ffb36b", w: "#ffffff", e: "#14102a" },
  zunzum: { o: "#1c1a2b", b: "#5b5a7a", h: "#9a99c2", s: "#3a3955", x: "#f2c94c", w: "#cfe8ff", e: "#f4f1ff" },
};
const angry = { o: "#4a0d10", b: "#e5484d", h: "#ff9a9a", s: "#a8232a", x: "#ff6b6b", e: "#2a0507" };
// Olhos por humor: deslocamentos a partir da âncora de cada olho (o direito espelha o bravo).
const eyes = {
  calm: [[0, 0], [0, 1]],
  happy: [[-1, 1], [0, 0], [1, 1]],
  angry: [[-1, -1], [0, 0], [0, 1], [0, 2]],
  sleepy: [[-1, 1], [0, 1], [1, 1]],
  wide: [[0, -1], [0, 0], [0, 1]],
};
const glows = { geleu: ["#5fd3a8", "#2f9a78", "#19b8ff"], lunito: ["#f1ecff", "#bdb2e3", "#ff9fc4"], taturi: ["#a3d65c", "#6f9e34", "#ffb36b"], zunzum: ["#f2c94c", "#5b5a7a", "#cfe8ff"] };

function svg(id, mood) {
  const grid = grids[id];
  const colors = mood === "angry" ? { ...palettes[id], ...angry } : palettes[id];
  const cells = [];
  grid.rows.forEach((row, y) => [...row].forEach((key, x) => { if (colors[key]) cells.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${colors[key]}"${key === "w" ? ' fill-opacity=".75"' : ""}/>`); }));
  grid.eyes.forEach(([ax, ay], side) => eyes[mood].forEach(([dx, dy]) => cells.push(`<rect x="${ax + (side && mood === "angry" ? -dx : dx)}" y="${ay + dy}" width="1" height="1" fill="${colors.e}"/>`)));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">${cells.join("")}</svg>\n`;
}

const root = join(import.meta.dirname, "..", "src-tauri", "themes");
for (const id of Object.keys(grids)) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  for (const mood of Object.keys(eyes)) writeFileSync(join(dir, `${mood}.svg`), svg(id, mood));
  writeFileSync(join(dir, "theme.json"), JSON.stringify({
    schema: 1, name: grids[id].name, author: "Heydesk",
    images: { calm: "calm.svg", happy: "happy.svg", angry: "angry.svg", sleepy: "sleepy.svg", wide: "wide.svg", pixelated: true },
    colors: { glow: glows[id] },
  }, null, 2) + "\n");
}
mkdirSync(join(root, "eyes"), { recursive: true });
writeFileSync(join(root, "eyes", "theme.json"), JSON.stringify({ schema: 1, name: "Olhos", author: "Heydesk" }, null, 2) + "\n");
console.log("temas gerados em", root);
