"use client";

// Canvas charts (no chart library — deps stay minimal). Every series is REAL
// on-chain data passed in by the parent (indexed daily volume / cumulative
// volume). Ported drawing style from the approved mockup.

import { useEffect, useRef } from "react";

type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

function useCanvas(draw: Draw, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const render = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const rect = cv.getBoundingClientRect();
      if (rect.width === 0) return;
      cv.width = rect.width * dpr;
      cv.height = rect.height * dpr;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      draw(ctx, rect.width, rect.height);
    };
    render();
    window.addEventListener("resize", render);
    return () => window.removeEventListener("resize", render);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

// Normalize a series so a flat/all-zero array still renders a baseline.
function norm(data: number[]): { d: number[]; max: number; min: number } {
  const d = data.length ? data : [0];
  const max = Math.max(...d), min = Math.min(...d);
  return { d, max, min };
}

// A series is "empty" (nothing to chart yet) if it has no points or every
// point is zero — drawing a flat line at 0 in that case reads as real data.
export function isEmptySeries(data: number[]): boolean {
  return data.length === 0 || data.every((v) => v === 0);
}

// Centered muted message for an empty chart — honest, not a misleading line.
function drawEmpty(x: CanvasRenderingContext2D, w: number, h: number, label: string) {
  x.fillStyle = "rgba(255,255,255,0.35)";
  x.font = "12px ui-sans-serif, system-ui, sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(label, w / 2, h / 2);
}

export function AreaChartData({ data, color, height = 220, emptyLabel = "No activity yet" }: { data: number[]; color: string; height?: number; emptyLabel?: string }) {
  const ref = useCanvas(
    (x, w, h) => {
      if (isEmptySeries(data)) { drawEmpty(x, w, h, emptyLabel); return; }
      const { d, max, min } = norm(data);
      const pad = 6;
      const span = (max - min) || 1;
      const dTop = max + span * 0.15; // headroom so the peak isn't glued to the top edge
      const X = (i: number) => pad + (d.length === 1 ? 0.5 : i / (d.length - 1)) * (w - pad * 2);
      const Y = (v: number) => h - pad - ((v - min) / ((dTop - min) || 1)) * (h - pad * 2);
      // faint baseline so a mostly-flat series still reads as a chart with an axis
      x.strokeStyle = "rgba(255,255,255,.06)"; x.lineWidth = 1;
      x.beginPath(); x.moveTo(pad, h - pad); x.lineTo(w - pad, h - pad); x.stroke();
      const g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, color + "44"); g.addColorStop(1, color + "00");
      x.beginPath();
      d.forEach((v, i) => { const px = X(i), py = Y(v); i ? x.lineTo(px, py) : x.moveTo(px, py); });
      x.lineTo(X(d.length - 1), h - pad); x.lineTo(X(0), h - pad); x.closePath();
      x.fillStyle = g; x.fill();
      x.beginPath();
      d.forEach((v, i) => { const px = X(i), py = Y(v); i ? x.lineTo(px, py) : x.moveTo(px, py); });
      x.strokeStyle = color; x.lineWidth = 2; x.stroke();
      const lx = X(d.length - 1), ly = Y(d[d.length - 1]);
      x.beginPath(); x.arc(lx, ly, 3.5, 0, 7); x.fillStyle = color; x.fill();
    },
    [JSON.stringify(data), color],
  );
  return <canvas ref={ref} style={{ width: "100%", height, display: "block", marginTop: 8 }} />;
}

export function BarsChartData({ data, color, height = 150, emptyLabel = "No activity yet" }: { data: number[]; color: string; height?: number; emptyLabel?: string }) {
  const ref = useCanvas(
    (x, w, h) => {
      if (isEmptySeries(data)) { drawEmpty(x, w, h, emptyLabel); return; }
      const { d, max } = norm(data);
      const pad = 4, bw = (w - pad * 2) / d.length;
      d.forEach((v, i) => {
        const frac = max > 0 ? v / max : 0;
        // every day gets a faint 2px floor so the whole window reads as a chart,
        // not an empty box with a couple of bars stranded on the right edge.
        const bh = frac > 0 ? Math.max(3, frac * (h - pad * 2)) : 2;
        x.fillStyle = v === 0 ? color + "2E" : i === d.length - 1 ? color : color + "99";
        x.fillRect(pad + i * bw + 1, h - pad - bh, Math.max(1, bw - 2), bh);
      });
    },
    [JSON.stringify(data), color],
  );
  return <canvas ref={ref} style={{ width: "100%", height, display: "block", marginTop: 12 }} />;
}

export function SparklineData({ data }: { data: number[] }) {
  const ref = useCanvas(
    (x, w, h) => {
      const { d, max, min } = norm(data);
      const up = d.length > 1 ? d[d.length - 1] >= d[0] : true;
      const col = up ? "#21C08A" : "#F0616A";
      const X = (i: number) => (d.length === 1 ? 0.5 : i / (d.length - 1)) * w;
      const Y = (v: number) => h - 2 - ((v - min) / (max - min || 1)) * (h - 4);
      x.beginPath();
      d.forEach((v, i) => { const px = X(i), py = Y(v); i ? x.lineTo(px, py) : x.moveTo(px, py); });
      x.strokeStyle = col; x.lineWidth = 1.5; x.stroke();
    },
    [JSON.stringify(data)],
  );
  return <canvas ref={ref} className="spark" />;
}
