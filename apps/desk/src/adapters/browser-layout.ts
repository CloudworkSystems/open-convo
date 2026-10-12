export type RailMode = 'expanded' | 'icons' | 'hover' | 'hidden';
export interface LayoutPreferences { mode: RailMode; railWidth: number; inspectorWidth: number }
export const LAYOUT_KEY = 'true-convo:desk:layout:v1';
export const DEFAULT_LAYOUT: LayoutPreferences = { mode: 'expanded', railWidth: 260, inspectorWidth: 294 };
export const RAIL_MODES: RailMode[] = ['expanded', 'icons', 'hover', 'hidden'];
const warning = 'Layout settings could not be restored or saved. Your sessions and drafts are kept separately.';

/** Browser layout only. This never opens or changes the workspace store. */
export function loadLayout(): { preferences: LayoutPreferences; warning: string | null } {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw === null) return { preferences: { ...DEFAULT_LAYOUT }, warning: null };
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'inspectorWidth,mode,railWidth'
      || !RAIL_MODES.includes(value.mode)
      || !Number.isFinite(value.railWidth) || value.railWidth < 200 || value.railWidth > 400
      || !Number.isFinite(value.inspectorWidth) || value.inspectorWidth < 220 || value.inspectorWidth > 1100) {
      return { preferences: { ...DEFAULT_LAYOUT }, warning };
    }
    return { preferences: value, warning: null };
  } catch { return { preferences: { ...DEFAULT_LAYOUT }, warning }; }
}

export function saveLayout(preferences: LayoutPreferences): string | null {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(preferences)); return null; }
  catch { return warning; }
}

export function snapWidth(width: number, min: number, max: number, stops: readonly number[]): number {
  const clamped = Math.max(min, Math.min(max, Math.round(width)));
  return stops.find((stop) => Math.abs(stop - clamped) <= 9) ?? clamped;
}
