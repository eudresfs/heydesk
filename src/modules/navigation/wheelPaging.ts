// Deltas de roda/touchpad só viram navegação depois de um gesto deliberado.
export class WheelPaging {
  private lastAt = -Infinity;
  private sum = 0;
  private direction = 0;
  private latched = false;
  reset() { this.lastAt = -Infinity; this.sum = 0; this.direction = 0; this.latched = false; }
  accept(delta: number, mode: number, now: number): -1 | 0 | 1 {
    if (!Number.isFinite(delta) || !Number.isFinite(now) || delta === 0) return 0;
    const direction = Math.sign(delta);
    if (now - this.lastAt > 180 || direction !== this.direction) { this.sum = 0; this.latched = false; }
    this.lastAt = now; this.direction = direction;
    if (this.latched) return 0;
    // Acumular pixels evita que nove deltas de 10 terminem em 0.89999…
    this.sum += mode === 1 ? delta * (100 / 3) : mode === 2 ? direction * 100 : delta;
    if (Math.abs(this.sum) < 90) return 0;
    this.latched = true; this.sum = 0;
    return direction as -1 | 1;
  }
}
