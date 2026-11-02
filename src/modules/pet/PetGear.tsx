// Acessórios da loja, desenhados no mesmo espaço do mascote (viewBox 30 × 16; olhos em
// x 6,5 e 23,5, y 8). Arte original do Heydesk; ficam fora do grupo que segue o cursor.
import type { PetStage } from "./petSim";

export function Hat({ id }: { id: string }) {
  if (id === "hat_cap") return <g className="mascot-hat" aria-hidden="true">
    <path d="M7.5 1.2Q15 -8.6 22.5 1.2Z" fill="#3d7bd9" /><path d="M15 -6.6V-3" stroke="#fff" strokeOpacity=".5" strokeWidth=".8" />
    <path d="M5.5 1.2H27" stroke="#2a5ba8" strokeWidth="1.8" strokeLinecap="round" /><circle cx="15" cy="-6.6" r="1" fill="#2a5ba8" />
  </g>;
  if (id === "hat_scarf") return <g className="mascot-hat" aria-hidden="true">
    <path d="M3.5 14.2Q15 18.6 26.5 14.2" fill="none" stroke="#e5484d" strokeWidth="2.6" strokeLinecap="round" />
    <path d="M21 15.6l1.6 4.4 2.6-.8-1.2-4.6" fill="#c8323a" /><path d="M7 15.4Q15 18 23 15.4" fill="none" stroke="#fff" strokeOpacity=".35" strokeWidth=".7" strokeDasharray="1.2 1.4" />
  </g>;
  if (id === "hat_headphones") return <g className="mascot-hat" aria-hidden="true">
    <path d="M2.6 8A12.4 10 0 0 1 27.4 8" fill="none" stroke="#2c2c34" strokeWidth="2" strokeLinecap="round" />
    <rect x="-.6" y="5.6" width="4.2" height="6.4" rx="1.6" fill="#ff3ea5" /><rect x="26.4" y="5.6" width="4.2" height="6.4" rx="1.6" fill="#ff3ea5" />
  </g>;
  if (id === "hat_crown") return <g className="mascot-hat" aria-hidden="true">
    <path d="M8.4 1.2V-4.2L11.8-.8 15-6.4 18.2-.8 21.6-4.2V1.2Z" fill="#f2c94c" stroke="#b8862f" strokeWidth=".6" strokeLinejoin="round" />
    <circle cx="15" cy="-1.6" r="1.1" fill="#e5484d" /><circle cx="11" cy="-.3" r=".6" fill="#5fd3a8" /><circle cx="19" cy="-.3" r=".6" fill="#5fd3a8" />
  </g>;
  if (id === "hat_beanie") return <g className="mascot-hat" aria-hidden="true">
    <path d="M6.5 1.4Q6.6-6 15-6T23.5 1.4Z" fill="#5fd3a8" /><path d="M6 1.4H24" stroke="#2f9a78" strokeWidth="2.2" strokeLinecap="round" />
    <path d="M10-2.4V.4M15-3.6V.4M20-2.4V.4" stroke="#2f9a78" strokeWidth=".7" /><circle cx="15" cy="-6.4" r="1.4" fill="#e2f7b5" />
  </g>;
  if (id === "hat_glasses") return <g className="mascot-hat" aria-hidden="true">
    <rect x="1.6" y="3.4" width="9.8" height="9.2" rx="2.6" fill="#8fd6ff" fillOpacity=".18" stroke="#e8e8ee" strokeWidth="1.1" />
    <rect x="18.6" y="3.4" width="9.8" height="9.2" rx="2.6" fill="#8fd6ff" fillOpacity=".18" stroke="#e8e8ee" strokeWidth="1.1" />
    <path d="M11.4 7.2Q15 5.6 18.6 7.2" fill="none" stroke="#e8e8ee" strokeWidth="1.1" />
  </g>;
  if (id === "hat_halo") return <g className="mascot-hat" aria-hidden="true">
    <ellipse cx="15" cy="-2.6" rx="7.4" ry="1.9" fill="none" stroke="#ffe9a8" strokeWidth="1.4" />
    <ellipse cx="15" cy="-2.6" rx="7.4" ry="1.9" fill="none" stroke="#fff" strokeOpacity=".6" strokeWidth=".5" />
  </g>;
  if (id === "hat_star") return <g className="mascot-hat" aria-hidden="true">
    <path d="M8 1.2V-3.6L11.4-1 15-6.6 18.6-1 22-3.6V1.2Z" fill="#8b5cff" stroke="#c8b4ff" strokeWidth=".6" strokeLinejoin="round" />
    <path d="M15-4.2l.7 1.5 1.6.2-1.2 1.1.3 1.6-1.4-.8-1.4.8.3-1.6-1.2-1.1 1.6-.2z" fill="#ffd166" />
  </g>;
  return null;
}

/** Estágio no visual: adulto ganha um brilho, lenda três. */
export function StageMark({ stage }: { stage?: PetStage }) {
  if (stage !== "lenda" && stage !== "adulto") return null;
  const spark = (x: number, y: number, s: number) => `M${x} ${y - s}L${x + s * .35} ${y - s * .35}L${x + s} ${y}L${x + s * .35} ${y + s * .35}L${x} ${y + s}L${x - s * .35} ${y + s * .35}L${x - s} ${y}L${x - s * .35} ${y - s * .35}Z`;
  const marks = stage === "lenda" ? `${spark(-1.5, 1, 1.6)}${spark(31.5, 2, 1.3)}${spark(30, 15, 1)}` : spark(31, 2, 1.1);
  return <path className="mascot-sparkle" aria-hidden="true" d={marks} fill="#ffd166" />;
}
