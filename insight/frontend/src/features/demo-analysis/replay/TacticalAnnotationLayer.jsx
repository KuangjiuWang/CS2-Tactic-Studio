import { useState } from "react";

const clamp = (value) => Math.max(0, Math.min(100, value));

function shape(annotation, color, onDelete, erasing) {
  const [a, b = a] = annotation.points || [];
  if (!a) return null;
  const common = { stroke: color, strokeWidth: 0.45, fill: "none" };
  const erase = erasing ? { onPointerDown: (event) => { event.stopPropagation(); onDelete?.(annotation.id); }, style: { cursor: "crosshair", pointerEvents: "stroke" } } : {};
  if (annotation.type === "pen") return <polyline points={annotation.points.map((point) => `${point.x},${point.y}`).join(" ")} {...common} {...erase} />;
  if (["line", "arrow"].includes(annotation.type)) return <g {...erase}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...common} />{annotation.type === "arrow" && <circle cx={b.x} cy={b.y} r="0.9" fill={color} />}</g>;
  if (annotation.type === "rectangle") return <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} {...common} {...erase} />;
  if (["circle", "smoke"].includes(annotation.type)) return <circle cx={a.x} cy={a.y} r={Math.hypot(b.x - a.x, b.y - a.y)} stroke={color} strokeWidth="0.45" fill={annotation.type === "smoke" ? `${color}55` : "none"} {...erase} />;
  return <g {...erase}><circle cx={a.x} cy={a.y} r="2.2" fill={color} opacity="0.85" /><text x={a.x} y={a.y + 0.8} textAnchor="middle" fontSize="2.1" fill="#111">{annotation.text || annotation.type.toUpperCase()}</text></g>;
}

export default function TacticalAnnotationLayer({ annotations = [], mode = "select", color = "#fbbf24", onCommit, onDelete }) {
  const [draft, setDraft] = useState(null);
  const point = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: clamp((event.clientX - rect.left) / rect.width * 100), y: clamp((event.clientY - rect.top) / rect.height * 100) };
  };
  const start = (event) => {
    if (["select", "eraser"].includes(mode)) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const p = point(event);
    if (!p) return;
    setDraft({ id: crypto.randomUUID(), type: mode, points: [p], color, text: "", createdAt: new Date().toISOString() });
  };
  const move = (event) => {
    if (!draft) return;
    event.stopPropagation();
    const p = point(event);
    if (!p) return;
    setDraft((current) => current && ({ ...current, points: current.type === "pen" ? [...current.points, p] : [current.points[0], p] }));
  };
  const finish = (event) => {
    if (!draft) return;
    event.stopPropagation();
    onCommit?.(draft);
    setDraft(null);
  };
  return <svg data-testid="tactical-annotations" viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 z-[24] h-full w-full" style={{ pointerEvents: mode === "select" ? "none" : "auto", touchAction: "none" }} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={() => setDraft(null)}>
    {[...annotations, ...(draft ? [draft] : [])].map((annotation) => <g key={annotation.id}>{shape(annotation, annotation.color || color, onDelete, mode === "eraser")}</g>)}
  </svg>;
}
