// The thing you look at while you talk.
//
// One canvas, two figures, drawn from the REAL levels: the agent's from
// the playback and yours from the microphone. Both are drawn at all
// times, the speaking one dominant — the first version only drew the
// side that matched the call state, so when the state lagged the
// animation sat still while the agent talked (Rene, 2026-09-11: "sie
// reagiert nur auf meine eingabe aber nicht auf seine ausgabe"). An
// animation that can be wrong about who is speaking must not be the
// only thing that knows.

import { useEffect, useRef } from 'react';

export interface VoiceOrbProps {
  /** The speaking agent's colour; the agent figure takes it. */
  color: string;
  speaker: 'you' | 'agent';
  active: boolean;
  muted?: boolean;
  micLevel: () => number;
  agentLevel: () => number;
}

interface Trail {
  value: number;
  update(raw: number): number;
}

/** Attack fast, release slow: speech is spiky, and a figure that
 *  follows every consonant looks nervous rather than alive. */
function trail(): Trail {
  return {
    value: 0,
    update(raw: number): number {
      this.value = raw > this.value ? this.value + (raw - this.value) * 0.45 : this.value + (raw - this.value) * 0.07;
      return this.value;
    },
  };
}

export function VoiceOrb({ color, speaker, active, muted = false, micLevel, agentLevel }: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const raf = useRef<number>(0);
  const agentTrail = useRef<Trail>(trail());
  const micTrail = useRef<Trail>(trail());
  const phase = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;

    const ring = (
      cx: number,
      cy: number,
      base: number,
      level: number,
      lobes: number,
      spin: number,
      stroke: string,
      width: number,
      alpha: number,
      fill?: CanvasGradient,
    ): void => {
      const swell = base * (0.1 + level * 0.55);
      ctx.beginPath();
      const steps = 96;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const wobble =
          Math.sin(a * lobes + spin) * 0.55 +
          Math.sin(a * (lobes * 2 + 1) - spin * 0.6) * 0.25 +
          Math.sin(a * (lobes + 4) + spin * 1.7) * 0.12;
        const r = base + swell * wobble + swell * level * 0.5;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      if (fill) {
        ctx.globalAlpha = alpha * 0.6;
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();
    };

    const draw = (): void => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const agent = agentTrail.current.update(active ? Math.min(1, agentLevel() * 2.4) : 0);
      const mic = micTrail.current.update(active && !muted ? Math.min(1, micLevel() * 2.4) : 0);
      phase.current += 0.02 + agent * 0.05 + mic * 0.03;

      const cx = w / 2;
      const cy = h / 2;
      const base = Math.min(w, h) * 0.3;

      // Agent: soft, wide lobes, filled, in its colour.
      const glow = ctx.createRadialGradient(cx, cy, base * 0.1, cx, cy, base * 1.7);
      glow.addColorStop(0, color);
      glow.addColorStop(1, 'transparent');
      ring(cx, cy, base, agent, 3, phase.current, color, speaker === 'agent' ? 2.4 : 1.4, active ? 0.25 + agent * 0.65 : 0.12, glow);

      // You: a tighter, cooler figure just inside it, so both are
      // visible at once and neither hides the other.
      ring(
        cx,
        cy,
        base * 0.62,
        mic,
        7,
        -phase.current * 1.3,
        muted ? 'var(--text-3, #666)' : 'rgba(255,255,255,0.75)',
        speaker === 'you' ? 1.8 : 1,
        active ? 0.2 + mic * 0.7 : 0.1,
      );

      // A quiet resting pulse so an idle call still looks alive.
      if (active && agent < 0.02 && mic < 0.02) {
        const breath = (Math.sin(phase.current * 2) + 1) / 2;
        ring(cx, cy, base * 0.3, breath * 0.15, 2, phase.current * 0.5, color, 1, 0.25);
      }

      ctx.globalAlpha = 1;
      raf.current = requestAnimationFrame(draw);
    };
    raf.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf.current);
  }, [color, speaker, active, muted, micLevel, agentLevel]);

  return (
    <canvas
      data-testid="voice-orb"
      ref={canvasRef}
      style={{ width: '100%', height: '100%', display: 'block' }}
      aria-label={active ? `${speaker} speaking` : 'idle'}
    />
  );
}
