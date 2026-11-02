export interface SpringState { x: number; velocity: number }
export interface FrameScheduler {
  now(): number;
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

// Equação e constantes recuperadas do assembly. A paginação reutiliza esta
// física por adaptação explícita; coeficientes próprios dela não foram recuperados.
// Fechar usa mola criticamente amortecida (sem quique): antes a mola de abrir era
// cortada no alvo ainda em velocidade, um batente seco a cada recolhida.
const openSpring = { stiffness: 230, damping: 19 }, closeSpring = { stiffness: 260, damping: 32 };
function integrate(state: SpringState, target: number, elapsedSeconds: number, snap: boolean, spring = openSpring): SpringState {
  const dt = Math.min(Math.max(elapsedSeconds, 0), .05);
  const steps = Math.max(1, Math.ceil(dt / .004));
  const h = dt / steps;
  let { x, velocity } = state;
  for (let step = 0; step < steps; step++) {
    velocity += (-spring.stiffness * (x - target) - spring.damping * velocity) * h;
    x += velocity * h;
    if (snap && Math.abs(x - target) < .002 && Math.abs(velocity) < .05) return { x: target, velocity: 0 };
  }
  return { x, velocity };
}

export function advanceSpring(state: SpringState, target: number, elapsedSeconds: number): SpringState {
  return integrate(state, target, elapsedSeconds, true);
}

export interface BodyState { width: SpringState; height: SpringState }
export type BodyPhase = boolean | "peek";
export interface BodySize { width: number; height: number }
/** Fase nomeada ou tamanho explícito (ex.: atividade que alarga o compacto). */
export type BodyGoal = BodyPhase | BodySize;
// Tamanhos do corpo da direção B: compacto com hora, olhos e clima; aberto com a
// coluna do mascote e uma página. A janela nativa (680 × 230) comporta o overshoot.
export const compactBody = { width: 220, height: 32 } as const;
export const peekBody = { width: 232, height: 36 } as const;
export const openBody = { width: 580, height: 200 } as const;
export function bodyTarget(phase: BodyGoal): BodySize {
  if (typeof phase === "object") return phase;
  return phase === "peek" ? peekBody : phase ? openBody : compactBody;
}
export function advanceBodySpring(state: BodyState, expanded: BodyGoal, elapsedSeconds: number, collapsing = false): BodyState {
  const { width: widthTarget, height: heightTarget } = bodyTarget(expanded);
  const spring = collapsing ? closeSpring : openSpring;
  let width = integrate(state.width, widthTarget, elapsedSeconds, false, spring);
  let height = integrate(state.height, heightTarget, elapsedSeconds, false, spring);
  // Ao encolher para compacto, peek ou atividade, o overshoot da mola deixaria o corpo menor
  // que o conteúdo (medido: 19 px de altura na janela real). O corpo pousa no alvo.
  if (expanded !== true) {
    if (width.x < widthTarget && width.velocity < 0) width = { x: widthTarget, velocity: 0 };
    if (height.x < heightTarget && height.velocity < 0) height = { x: heightTarget, velocity: 0 };
  }
  // O renderizador aplica um único snap depois do frame completo. Estes
  // limiares são em pixels e pixels/s, diferentes do helper genérico acima.
  // Meio pixel não se vê; limiares menores só esticavam a cauda (~0,5 s de quadros parados).
  if (Math.abs(width.x - widthTarget) < .5 && Math.abs(width.velocity) < 4 && Math.abs(height.x - heightTarget) < .5 && Math.abs(height.velocity) < 4) {
    return { width: { x: widthTarget, velocity: 0 }, height: { x: heightTarget, velocity: 0 } };
  }
  return { width, height };
}

const browserFrames: FrameScheduler = {
  now: () => performance.now(),
  request: callback => requestAnimationFrame(callback),
  cancel: handle => cancelAnimationFrame(handle),
};

export class SpringDriver {
  private state: SpringState = { x: 0, velocity: 0 };
  private destination = 0;
  private frame: number | undefined;
  private lastTime = 0;
  private resolve: ((settled: boolean) => void) | undefined;

  constructor(private readonly paint: (position: number) => void, private readonly frames = browserFrames) {}
  get position() { return this.state.x; }
  get velocity() { return this.state.velocity; }
  get moving() { return this.frame !== undefined; }

  interrupt() { this.resolve?.(false); this.resolve = undefined; }

  cancel() {
    if (this.frame !== undefined) this.frames.cancel(this.frame);
    this.frame = undefined;
    this.interrupt();
  }

  animateTo(target: number, immediate = false): Promise<boolean> {
    this.interrupt();
    this.destination = target;
    if (immediate || (Math.abs(target - this.state.x) < .002 && Math.abs(this.state.velocity) < .05)) {
      this.cancel();
      this.state = { x: target, velocity: 0 };
      this.paint(target);
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      this.resolve = resolve;
      if (!this.moving) { this.lastTime = this.frames.now(); this.frame = this.frames.request(this.tick); }
    });
  }

  private tick = (now: number) => {
    this.frame = undefined;
    this.state = advanceSpring(this.state, this.destination, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.paint(this.state.x);
    if (this.state.x === this.destination && this.state.velocity === 0) {
      this.resolve?.(true); this.resolve = undefined;
    } else this.frame = this.frames.request(this.tick);
  };
}

export class BodySpringDriver {
  private state: BodyState = { width: { x: compactBody.width, velocity: 0 }, height: { x: compactBody.height, velocity: 0 } };
  private destination: BodyGoal = false;
  private collapsing = false;
  private frame: number | undefined;
  private lastTime = 0;
  private resolve: ((settled: boolean) => void) | undefined;
  constructor(private readonly paint: (width: number, height: number) => void, private readonly frames = browserFrames) {}
  get width() { return this.state.width.x; }
  get height() { return this.state.height.x; }
  get widthVelocity() { return this.state.width.velocity; }
  get heightVelocity() { return this.state.height.velocity; }
  get moving() { return this.frame !== undefined; }
  interrupt() { this.resolve?.(false); this.resolve = undefined; }
  cancel() {
    if (this.frame !== undefined) this.frames.cancel(this.frame);
    this.frame = undefined;
    this.interrupt();
  }
  animateTo(expanded: BodyGoal, immediate = false): Promise<boolean> {
    this.interrupt(); this.destination = expanded;
    const { width, height } = bodyTarget(expanded);
    // Decidido uma vez por pedido: encolher (fechar, fim de aviso) assenta sem quique.
    this.collapsing = height < this.state.height.x;
    if (immediate) this.state = { width: { x: width, velocity: 0 }, height: { x: height, velocity: 0 } };
    if (this.state.width.x === width && this.state.height.x === height && this.widthVelocity === 0 && this.heightVelocity === 0) {
      this.cancel();
      this.paint(width, height); return Promise.resolve(true);
    }
    return new Promise(resolve => {
      this.resolve = resolve;
      if (!this.moving) { this.lastTime = this.frames.now(); this.frame = this.frames.request(this.tick); }
    });
  }
  private tick = (now: number) => {
    this.frame = undefined;
    this.state = advanceBodySpring(this.state, this.destination, (now - this.lastTime) / 1000, this.collapsing);
    this.lastTime = now;
    this.paint(this.width, this.height);
    const target = bodyTarget(this.destination);
    if (this.width === target.width && this.height === target.height && this.widthVelocity === 0 && this.heightVelocity === 0) {
      this.resolve?.(true); this.resolve = undefined;
    } else this.frame = this.frames.request(this.tick);
  };
}
