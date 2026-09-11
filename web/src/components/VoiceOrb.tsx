// The thing you look at while you talk.
//
// Two shapes, one canvas: a round, breathing blob in the speaking
// agent's colour when the agent talks, and a cooler, tighter ring when
// you do. Both are driven by the REAL audio level — the microphone's
// on your side, the playback's on the agent's — because an animation
// that ignores the audio is a decoration, and you cannot tell from it
// whether the call is alive.

import { useEffect, useRef } from 'react';

export interface VoiceOrbProps {
  /** The speaking agent's colour; the whole figure takes it. */
  color: string;
  speaker: 'you' | 'agent';
  active: boolean;
  micLevel: () => number;
  agentLevel: () => number;
}

/** A blob that breathes: radius modulated per angle so it never reads
 *  as a plain circle, and smoothed over frames so a loud consonant
 *  does not make it flicker. */
export function VoiceOrb({ color, speaker, active, micLevel, agentLevel }: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const raf = useRef<number>(0);
  const smoothed = useRef(0);
  const phase = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;

    const draw = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const raw = active ? (speaker === 'agent' ? agentLevel() : micLevel()) : 0;
      // Attack fast, release slow: speech is spiky, and a figure that
      // follows every spike looks nervous rather than alive.
      smoothed.current = raw > smoothed.current
        ? smoothed.current + (raw - smoothed.current) * 0.5
        : smoothed.current + (raw - smoothed.current) * 0.08;
      const level = Math.min(1, smoothed.current * 2.2);
      phase.current += speaker === 'agent' ? 0.03 : 0.05;

      const cx = w / 2;
      const cy = h / 2;
      const base = Math.min(w, h) * 0.24;
      const swell = base * (0.12 + level * 0.5);

      ctx.save();
      ctx.translate(cx, cy);
      ctx.beginPath();
      const steps = 72;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        // The agent gets soft, rounded lobes; you get a tighter figure
        // with more edges, so it is obvious at a glance who is talking
        // without reading a label.
        const wobble =
          speaker === 'agent'
            ? Math.sin(a * 3 + phase.current) * 0.5 + Math.sin(a * 5 - phase.current * 0.7) * 0.25
            : Math.sin(a * 6 + phase.current) * 0.35 + Math.sin(a * 11 - phase.current) * 0.15;
        const r = base + swell * wobble + swell * level * 0.4;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();

      const grad = ctx.createRadialGradient(0, 0, base * 0.2, 0, 0, base + swell);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'transparent');
      ctx.globalAlpha = active ? 0.35 + level * 0.5 : 0.12;
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.globalAlpha = active ? 0.8 : 0.25;
      ctx.strokeStyle = color;
      ctx.lineWidth = speaker === 'agent' ? 2 : 1.2;
      ctx.stroke();
      ctx.restore();

      raf.current = requestAnimationFrame(draw);
    };
    raf.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf.current);
  }, [color, speaker, active, micLevel, agentLevel]);

  return (
    <canvas
      data-testid="voice-orb"
      ref={canvasRef}
      style={{ width: '100%', height: 180, display: 'block' }}
      aria-label={active ? `${speaker} speaking` : 'idle'}
    />
  );
}
