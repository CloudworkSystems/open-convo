import { useRef } from 'react';

export function ResizeHandle({ label, value, min, max, direction = 1, onChange }: {
  label: string; value: number; min: number; max: number;
  direction?: 1 | -1; onChange: (value: number) => void;
}) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const finish = () => { drag.current = null; };
  return <div role="separator" className="resize-handle" tabIndex={0}
    aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, x: event.clientX, width: value };
    }}
    onPointerMove={(event) => {
      const origin = drag.current;
      if (origin?.pointerId === event.pointerId) onChange(origin.width + direction * (event.clientX - origin.x));
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { finish(); return; }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      onChange(event.key === 'Home' ? min : event.key === 'End' ? max
        : value + direction * (event.key === 'ArrowRight' ? 20 : -20));
    }} />;
}
