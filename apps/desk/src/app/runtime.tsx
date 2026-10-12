import { createContext, useContext } from 'react';
import { BrowserRepository, type StorageLike, type LockRunner } from '../adapters/browser-repository';
import { BrowserTabView } from '../adapters/browser-tab-view';
import { BrowserCanvas } from '../adapters/browser-canvas';
import { BrowserRoadmap, type RoadmapMove } from '../adapters/browser-roadmap';
import { BrowserIdentityStore } from '../adapters/browser-identity';
import { DEFAULT_LAYOUT, loadLayout, saveLayout, type LayoutPreferences } from '../adapters/browser-layout';
import type { WorkspaceRepository } from '../adapters/workspace-repository';
import type { CanvasLayoutRecord } from '../domain/canvas-layout';
import type { RoadmapPlacement } from '../domain/recovery-roadmap';
import { validParticipantChoice, participantChoiceKey, sameParticipantIdentity, type ParticipantChoice } from '../domain/participant-choices';
import type { ParticipantPort } from '../adapters/participant-runtime';
import type { ParticipantIdentity } from '../domain/conversation-run-types';
import type { NativeParticipantConnection } from '../adapters/native-participant-port';
import type { NativeParticipantConfirmation } from '../adapters/native-participant-codec';

export interface RuntimeLifecycle {
  isActive(): boolean;
  subscribeInvalidation(changed: () => void): () => void;
  revoke(): void;
}
export interface TemporaryCanvas { layout: CanvasLayoutRecord; revision: number; pending: number; warning: string | null }
export interface CanvasVisit {
  temporary?: TemporaryCanvas;
  listeners: Set<() => void>;
  retain(next?: TemporaryCanvas): void;
}
export interface RoadmapVisit {
  temporary?: { placement: RoadmapPlacement; warning: string };
  pendingPlacement?: RoadmapPlacement;
  pendingMove?: RoadmapMove;
  listeners: Set<(settled: boolean) => void>;
  hasUnsaved(): boolean;
  changed(settled: boolean): void;
}
export interface DeskRuntime extends RuntimeLifecycle {
  readonly mode: 'browser' | 'native-proof';
  readonly createId?: () => string;
  readonly participant?: ParticipantPort;
  /** Explicit integration catalog, never loaded from saved workspace authority. */
  readonly participantChoices?: readonly ParticipantChoice[];
  /** Native recovery retains the original pin even after a build changes it. */
  readonly participantForRun?: (identity: Readonly<ParticipantIdentity>) => ParticipantPort;
  readonly participantConfirmation?: NativeParticipantConfirmation;
  /** A connection check is missing/failed; never evidence that a saved pin was removed. */
  readonly participantAvailabilityMessage?: string;
  readonly participantAvailabilityChecking?: boolean;
  readonly participantInputLimit?: number;
  readonly subscribeParticipants?: (listener: () => void) => () => void;
  readonly refreshParticipants?: () => Promise<void>;
  readonly workspace: WorkspaceRepository;
  readonly tabView: Pick<BrowserTabView, 'load' | 'save'>;
  readonly identity: Pick<BrowserIdentityStore, 'load' | 'save' | 'subscribe'>;
  readonly layout: { load(): { preferences: LayoutPreferences; warning: string | null }; save(value: LayoutPreferences): string | null };
  readonly canvas: Pick<BrowserCanvas, 'loadLatest' | 'save' | 'subscribe'>;
  readonly roadmap: Pick<BrowserRoadmap, 'loadLatest' | 'saveMove' | 'subscribe'>;
  readonly canvasVisit: CanvasVisit;
  readonly roadmapVisit: RoadmapVisit;
}

export const DeskRuntimeContext = createContext<DeskRuntime | null>(null);
export function useDeskRuntime(): DeskRuntime {
  const runtime = useContext(DeskRuntimeContext);
  if (!runtime) throw new Error('Desk runtime must be selected before mounting the app.');
  return runtime;
}

/** No browser APIs. Each proof runtime owns and clears these records. */
class VisitStorage implements StorageLike {
  private values = new Map<string, string>();
  constructor(private readonly active: () => boolean) {}
  getItem(key: string) { if (!this.active()) throw new Error('Runtime unavailable.'); return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (!this.active()) throw new Error('Runtime unavailable.'); this.values.set(key, value); }
  clear() { this.values.clear(); }
}
class VisitRecord {
  private raw: string | null = null;
  private listeners = new Set<() => void>();
  constructor(private readonly active: () => boolean) {}
  async read() { if (!this.active()) throw new Error('Runtime unavailable.'); return this.raw; }
  async update<T>(operation: (raw: string | null) => { result: T; raw?: string }): Promise<T> {
    if (!this.active()) throw new Error('Runtime unavailable.');
    const change = operation(this.raw);
    if (!this.active()) throw new Error('Runtime unavailable.');
    if (change.raw !== undefined) {
      this.raw = change.raw;
      for (const listener of this.listeners) listener();
    }
    return change.result;
  }
  subscribe(changed: () => void) { this.listeners.add(changed); return () => { this.listeners.delete(changed); }; }
  clear() { this.raw = null; this.listeners.clear(); }
}

/** Capture only own data fields; getters and later caller reads are not catalog evidence. */
function captureCatalogRecord(value: unknown, withIdentity: boolean): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid participant catalog.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const field = Object.getOwnPropertyDescriptor(descriptors, key)!.value as PropertyDescriptor;
    if (!field.enumerable || !Object.hasOwn(field, 'value')) throw new Error('Invalid participant catalog.');
  }
  if (withIdentity && Object.hasOwn(descriptors, 'identity')) {
    descriptors.identity = { ...descriptors.identity, value: captureCatalogRecord(descriptors.identity!.value, false) };
  }
  return Object.freeze(Object.defineProperties({}, descriptors));
}

function captureParticipantCatalog(value: readonly ParticipantChoice[] | undefined): readonly ParticipantChoice[] | undefined {
  if (value === undefined) return;
  try {
    if (!Array.isArray(value)) throw new Error();
    const slots = Object.getOwnPropertyDescriptors(value as object);
    const length = slots.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 32 || Reflect.ownKeys(slots).length !== length + 1) throw new Error();
    const entries: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const slot = slots[String(index)];
      if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw new Error();
      entries.push(captureCatalogRecord(slot.value, true));
    }
    const copied = Object.freeze(entries);
    if (!copied.every(validParticipantChoice) || copied.filter((choice) => choice.approved).length > 1
      || new Set(copied.map((choice) => participantChoiceKey(choice.identity))).size !== copied.length) throw new Error();
    return copied;
  } catch { throw new Error('Invalid participant catalog.'); }
}

function createRuntime(mode: DeskRuntime['mode'], workspace: WorkspaceRepository, host?: RuntimeLifecycle, createId?: () => string, participant?: ParticipantPort, participantChoices?: readonly ParticipantChoice[], nativeParticipants?: NativeParticipantConnection): DeskRuntime {
  const choices = captureParticipantCatalog(participantChoices)?.map((choice) => {
    const connected = !!participant && sameParticipantIdentity(participant.identity, choice.identity);
    return Object.freeze({ ...choice, identity: Object.freeze({ ...choice.identity }),
      available: choice.available && connected,
      unavailableReason: choice.available && !connected ? 'This participant has no matching connection. No other model will be used.' : choice.unavailableReason,
    });
  });
  let active = true;
  const invalidations = new Set<() => void>();
  const isActive = () => active && (host?.isActive() ?? true);
  const memory = mode === 'native-proof' ? new VisitStorage(isActive) : null;
  const identityRecord = memory ? new VisitRecord(isActive) : null;
  const canvasRecord = memory ? new VisitRecord(isActive) : null;
  let visitLayout: LayoutPreferences = { ...DEFAULT_LAYOUT };
  let lockTail = Promise.resolve();
  const withVisitLock: LockRunner = async (operation) => {
    const previous = lockTail;
    let release!: () => void;
    lockTail = new Promise<void>((done) => { release = done; });
    await previous;
    try {
      if (!isActive()) throw new Error('Runtime unavailable.');
      return await operation();
    } finally { release(); }
  };
  let protectedUnload = false;
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if ((!runtime.roadmapVisit.hasUnsaved() && !runtime.canvasVisit.temporary) || !isActive()) return;
    event.preventDefault(); event.returnValue = '';
  };
  const updateUnloadProtection = () => {
    const protect = !!runtime.canvasVisit.temporary || runtime.roadmapVisit.hasUnsaved();
    if (protect && !protectedUnload) window.addEventListener('beforeunload', onBeforeUnload);
    if (!protect && protectedUnload) window.removeEventListener('beforeunload', onBeforeUnload);
    protectedUnload = protect;
  };
  const canvasVisit: CanvasVisit = {
    listeners: new Set(),
    retain(next) {
      if (!isActive()) return;
      this.temporary = next;
      updateUnloadProtection();
      for (const listener of this.listeners) listener();
    },
  };
  const roadmapVisit: RoadmapVisit = {
    listeners: new Set(),
    hasUnsaved() { return !!this.temporary || !!this.pendingPlacement; },
    changed(settled) {
      if (!isActive()) return;
      updateUnloadProtection();
      for (const listener of this.listeners) listener(settled);
    },
  };
  let detachHost: (() => void) | undefined;
  const runtime: DeskRuntime = {
    mode, workspace, isActive, canvasVisit, roadmapVisit, createId,
    get participant() {
      const entry = nativeParticipants?.snapshot.entry;
      return nativeParticipants ? entry && isActive() ? nativeParticipants.portFor({ id: entry.id, label: entry.label, model: entry.model, executionHost: entry.executionHost }) : undefined : participant;
    },
    get participantChoices() {
      if (!nativeParticipants) return choices && Object.freeze(choices);
      const snapshot = nativeParticipants.snapshot;
      const entry = isActive() ? snapshot.entry : null;
      if (!entry) return Object.freeze([]);
      const { id, label, model, executionHost, reason, confirmation } = entry;
      const available = snapshot.available;
      return Object.freeze([Object.freeze({ identity: Object.freeze({ id, label, model, executionHost }),
        provider: 'Claude subscription', destination: 'Anthropic cloud', approved: true,
        available, unavailableReason: available ? null : snapshot.checking ? availabilityChecking
          : snapshot.error ? availabilityCheckFailed : nativeAvailabilityMessage(reason, !!confirmation),
      })]);
    },
    get participantAvailabilityMessage() {
      if (!nativeParticipants || !isActive()) return undefined;
      const snapshot = nativeParticipants.snapshot;
      return snapshot.checking ? availabilityChecking : snapshot.error ? availabilityCheckFailed
        : !snapshot.entry ? 'Participant availability has not been checked. Your draft is kept.' : undefined;
    },
    get participantAvailabilityChecking() { return nativeParticipants && isActive() ? nativeParticipants.snapshot.checking : undefined; },
    participantForRun: nativeParticipants ? (identity) => nativeParticipants.portFor(identity) : undefined,
    get participantConfirmation() {
      const snapshot = nativeParticipants?.snapshot;
      return isActive() && snapshot && !snapshot.checking && !snapshot.error ? snapshot.entry?.confirmation : undefined;
    },
    participantInputLimit: nativeParticipants ? 4096 : undefined,
    subscribeParticipants: nativeParticipants ? (listener) => nativeParticipants.subscribeChanges(listener) : undefined,
    refreshParticipants: nativeParticipants ? () => nativeParticipants.refreshAvailability() : undefined,
    tabView: new BrowserTabView(memory ?? undefined),
    identity: identityRecord && memory ? new BrowserIdentityStore(identityRecord, memory) : new BrowserIdentityStore(),
    canvas: new BrowserCanvas(canvasRecord ?? undefined),
    roadmap: memory ? new BrowserRoadmap(memory, withVisitLock) : new BrowserRoadmap(),
    layout: memory ? {
      load: () => ({ preferences: { ...visitLayout }, warning: null }),
      save: (value) => { if (!isActive()) return 'This visit has ended.'; visitLayout = { ...value }; return null; },
    } : { load: loadLayout, save: saveLayout },
    subscribeInvalidation(listener) { invalidations.add(listener); return () => { invalidations.delete(listener); }; },
    revoke() {
      if (!active) return;
      active = false;
      try { detachHost?.(); } catch { /* Local revocation still clears the visit. */ }
      detachHost = undefined;
      memory?.clear(); identityRecord?.clear(); canvasRecord?.clear();
      visitLayout = { ...DEFAULT_LAYOUT };
      canvasVisit.temporary = undefined; canvasVisit.listeners.clear();
      roadmapVisit.temporary = undefined; roadmapVisit.pendingPlacement = undefined; roadmapVisit.pendingMove = undefined; roadmapVisit.listeners.clear();
      if (protectedUnload) window.removeEventListener('beforeunload', onBeforeUnload);
      protectedUnload = false;
      for (const listener of invalidations) {
        try { listener(); } catch { /* One failed view cannot prevent other invalidations. */ }
      }
      invalidations.clear();
      try { host?.revoke(); } catch { /* This runtime remains unavailable without a fallback. */ }
    },
  };
  if (host) {
    const detach = host.subscribeInvalidation(() => runtime.revoke());
    if (active) detachHost = detach; else detach();
    if (!host.isActive()) runtime.revoke();
  }
  return runtime;
}

/** Browser entry explicitly chooses its existing sample authority. */
export function createBrowserRuntime(): DeskRuntime { return createRuntime('browser', new BrowserRepository()); }

/**
 * Called only by an explicit integration with an injected native repository and
 * lifecycle. This factory neither discovers a host nor authenticates JavaScript
 * globals/URLs. Workspace writes go solely to the supplied native authority;
 * auxiliary identity, geometry, placement and preferences last for this visit.
 */
export function createNativeProofRuntime(workspace: WorkspaceRepository, lifecycle: RuntimeLifecycle, options: { createId?: () => string; participant?: ParticipantPort; participantChoices?: readonly ParticipantChoice[]; nativeParticipants?: NativeParticipantConnection } = {}): DeskRuntime {
  return createRuntime('native-proof', workspace, lifecycle, options.createId, options.participant, options.participantChoices, options.nativeParticipants);
}

const availabilityCheckFailed = 'The Mac app could not confirm participant availability. Your draft is kept. Check availability again in the participant picker.';
const availabilityChecking = 'Checking participant availability. Your draft is kept.';
function nativeAvailabilityMessage(reason: string | null, hasConfirmation: boolean): string {
  switch (reason) {
    case 'overflow-unverified': return hasConfirmation
      ? 'Confirm paid usage is off in the Mac app before sending. True Convo cannot see your billing setting.'
      : 'Paid usage has not been confirmed off. This Mac app cannot send to the participant yet. True Convo cannot see your billing setting.';
    case 'cli-missing': return 'The approved Claude participant is not installed on this Mac.';
    case 'cli-version-mismatch': return 'The installed Claude version does not match this app build.';
    case 'provider-override': return 'The Claude configuration does not match the approved subscription route.';
    case 'signed-out': return 'Claude is signed out on this Mac.';
    case 'not-subscription': return 'Claude is not using the approved subscription login.';
    default: return 'The Mac app could not confirm participant availability. Your draft is kept.';
  }
}
