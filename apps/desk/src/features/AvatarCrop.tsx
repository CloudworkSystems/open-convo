import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { avatarCropGeometry, INITIAL_AVATAR_CROP, panAvatarCrop, renderAvatarCrop, type AvatarCrop as Crop } from './avatar-crop';

export type AvatarCropHandle = { render: () => string };

export function AvatarCrop({ image, disabled, onApply, onCancel, ref }: {
  image: HTMLImageElement; disabled: boolean; onApply: (image: string) => void; onCancel: () => void;
  ref?: Ref<AvatarCropHandle>;
}) {
  const [crop, setCrop] = useState<Crop>({ ...INITIAL_AVATAR_CROP });
  const [problem, setProblem] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState(220);
  const drag = useRef<{ pointerId: number; x: number; y: number; crop: Crop } | null>(null);
  const geometry = avatarCropGeometry(image.naturalWidth, image.naturalHeight, crop);
  const scale = frameSize / geometry.size;
  useImperativeHandle(ref, () => ({ render: () => renderAvatarCrop(image, crop) }), [image, crop]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resize = () => { if (element.clientWidth > 0) setFrameSize(element.clientWidth); };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const pan = (origin: Crop, dx: number, dy: number) => setCrop(panAvatarCrop(image.naturalWidth, image.naturalHeight, frameSize, origin, dx, dy));
  return <div className="avatar-crop-editor">
    <p id="avatar-crop-help" className="field-hint">Drag your photo inside the circle. Use the arrow keys to move it, and the zoom control to adjust the crop.</p>
    <div ref={viewport} className="avatar-crop-frame" role="group" aria-label="Avatar crop" aria-describedby="avatar-crop-help" tabIndex={disabled ? -1 : 0}
      onKeyDown={(event) => {
        if (disabled) return;
        const step = event.shiftKey ? 40 : 10;
        const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
        if (delta) { event.preventDefault(); pan(crop, delta[0], delta[1]); }
        else if (['+', '=', '-'].includes(event.key)) {
          event.preventDefault(); setCrop({ ...crop, zoom: Math.min(4, Math.max(1, crop.zoom + (event.key === '-' ? -0.1 : 0.1))) });
        }
      }}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, crop };
      }}
      onPointerMove={(event) => {
        const origin = drag.current;
        if (!origin || disabled || origin.pointerId !== event.pointerId) return;
        pan(origin.crop, event.clientX - origin.x, event.clientY - origin.y);
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      <img src={image.src} alt="" draggable={false} style={{ width: image.naturalWidth * scale, height: image.naturalHeight * scale,
        left: -geometry.x * scale, top: -geometry.y * scale }} />
    </div>
    <label className="avatar-zoom" htmlFor="avatar-crop-zoom">Zoom <input id="avatar-crop-zoom" type="range" min={1} max={4} step={0.05} value={crop.zoom} disabled={disabled}
      onChange={(event) => setCrop({ ...crop, zoom: Number(event.target.value) })} /><output>{Math.round(crop.zoom * 100)}%</output></label>
    <div className="avatar-crop-actions"><button type="button" className="primary-button" disabled={disabled} onClick={() => {
      try { onApply(renderAvatarCrop(image, crop)); } catch (error) { setProblem(error instanceof Error ? error.message : 'The photo could not be cropped.'); }
    }}>Use this crop</button><button type="button" className="text-button" disabled={disabled} onClick={onCancel}>Cancel crop</button></div>
    {problem && <p className="settings-warning" role="status">{problem}</p>}
  </div>;
}
