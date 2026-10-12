import type { CSSProperties, ReactNode } from 'react';
const brandMark = new URL('../../brand/logo.png', import.meta.url).href;

export type IconName =
  | 'desk'
  | 'work'
  | 'memory'
  | 'data'
  | 'plus'
  | 'arrow'
  | 'sun'
  | 'moon'
  | 'menu'
  | 'close'
  | 'check'
  | 'chevron'
  | 'edit'
  | 'panel'
  | 'shield'
  | 'spark'
  | 'return' | 'folder' | 'user' | 'help' | 'monitor' | 'rail-open' | 'rail-closed'
  | 'canvas' | 'atlas' | 'pin' | 'pin-filled' | 'ellipsis';
// These controls are interface symbols, separate from the recovered brand mark.

const paths: Record<IconName, ReactNode> = {
  ellipsis: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
  pin: <g transform="rotate(40 12 12)"><path d="M8 3h8v2h-1v5l3 3v2H6v-2l3-3V5H8V3Z" /><path d="M12 15v7" /></g>,
  'pin-filled': <g transform="rotate(40 12 12)"><path d="M8 3h8v2h-1v5l3 3v2H6v-2l3-3V5H8V3Z" fill="currentColor" /><path d="M12 15v7" /></g>,
  folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9 8a3 3 0 0 1 6 1c0 2-3 2-3 4M12 17h.01" /></>,
  monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  'rail-open': <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16M6 8v8" /></>,
  'rail-closed': <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M7 4v16" /></>,
  canvas: <><rect x="3" y="4" width="18" height="16" rx="2" /><rect x="6" y="7" width="5" height="4" rx="1" /><path d="M15 8h3M15 11h3M6 15h12M6 17h8" /></>,
  atlas: <><circle cx="12" cy="12" r="3" /><circle cx="5" cy="5" r="2" /><circle cx="20" cy="7" r="2" /><circle cx="7" cy="20" r="2" /><path d="m6.5 6.5 3.4 3.4m4.8.8 3.5-2.5M10.5 14.5l-2.4 3.7" /></>,
  desk: (
    <>
      <path d="M4 5h16v12H4z" />
      <path d="M8 21h8M12 17v4M7 9h6M7 12h9" />
    </>
  ),
  work: (
    <>
      <rect x="4" y="6" width="16" height="15" rx="2" />
      <path d="M8 6V3h8v3M4 12h16M10 12v3h4v-3" />
    </>
  ),
  memory: (
    <>
      <path d="M8 4H6a2 2 0 0 0-2 2v14l4-3h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
      <path d="M9 3h6v6H9zM8 12h8" />
    </>
  ),
  data: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: (
    <>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" />
    </>
  ),
  moon: <path d="M21 13a9 9 0 0 1-10-10A9 9 0 1 0 21 13Z" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  edit: (
    <>
      <path d="m15 4 5 5M4 20l5-1 12-12-5-5L4 14v6Z" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  spark: (
    <>
      <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" />
    </>
  ),
  return: (
    <>
      <path d="M8 8H4V4M4 8a8 8 0 1 1-1 7" />
      <path d="M12 7v5l3 2" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      {paths[name]}
    </svg>
  );
}

export function EmberMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`ember-mark${small ? ' ember-mark-small' : ''}`} aria-hidden="true">
      <img src={brandMark} alt="" />
    </span>
  );
}
