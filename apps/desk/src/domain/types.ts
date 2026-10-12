import type { FolderIconName } from './folder-icons';
import type { ConversationRun, ParticipantIdentity } from './conversation-run-types';

export type DeskRoute = 'setup' | 'sessions' | 'work' | 'memory' | 'data';
export type ThemePreference = 'system' | 'light' | 'dark';
export type NexusView = 'navigator' | 'canvas' | 'atlas' | 'roadmap';

export interface Goal {
  id: string;
  /** Missing on earlier saved goals; those remain root domains. */
  parentId?: string | null;
  title: string;
  /** Optional explanation of the domain's grouping intent; absent on earlier saves. */
  purpose?: string;
  /** Missing or false means unpinned; pinning does not change placement. */
  pinned?: boolean;
  /** Missing retains the original folder icon; explicit choices are local Lucide symbols. */
  icon?: FolderIconName;
  nextStep: string;
  createdAt: string;
  updatedAt: string;
}

export interface GoalDraft {
  nextStep: string | null;
  workTitle: string;
  /** Null or absent means no domain note form is being edited. */
  purpose?: string | null;
}

export type GoalDraftField = keyof GoalDraft;

export interface SessionTextRevision {
  text: string;
  /** When this value was recorded, not an inferred session creation time. */
  createdAt: string;
}

export interface Session {
  id: string;
  goalId: string | null;
  title: string;
  pinned?: boolean;
  /** A saved choice only; current runtime eligibility and availability still govern sending. */
  participantChoice?: ParticipantIdentity;
  /** First entry records the observed name before the first explicit rename. */
  titleHistory?: SessionTextRevision[];
  /** Explicitly supplied by the user; never inferred from a name or message. */
  intent?: string;
  intentHistory?: SessionTextRevision[];
  /** Separate recoverable form text; absent means the intent form is closed. */
  intentDraft?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  body: string;
  status: 'complete' | 'running' | 'stopped' | 'interrupted';
  provenance: 'simulation';
  createdAt: string;
}

export interface WorkItem {
  id: string;
  goalId: string;
  title: string;
  status: 'planned' | 'active' | 'returned';
  /** New user proposals enter Suggested; earlier records retain their original status mapping. */
  roadmapColumn?: 'suggested';
  createdAt: string;
}

export interface Note {
  id: string;
  goalId: string;
  body: string;
  createdAt: string;
}

/** Invented-data CONTINUITY records. Saving these never grants external use. */
export type MemorySource = { kind: 'direct' } | { kind: 'message' | 'note'; id: string };
export type MemoryUse = 'active' | 'view-only' | 'trashed';
export interface MemoryValue { body: string; use: MemoryUse }
export type MemoryOperation = 'remember' | 'correct' | 'forget' | 'restore' | 'undo';
export interface MemoryHistoryEntry extends MemoryValue {
  revision: number;
  operation: MemoryOperation;
  changedAt: string;
}
export interface MemoryEntry extends MemoryValue {
  id: string;
  /** Fixed at explicit Save; refiling its source does not widen its scope. */
  goalId: string;
  source: MemorySource;
  revision: number;
  createdAt: string;
  updatedAt: string;
  history: MemoryHistoryEntry[];
  /** One flat prior value, never a recursively nested workspace snapshot. */
  undo: { operation: Exclude<MemoryOperation, 'undo'>; afterRevision: number; previous: MemoryValue | null } | null;
  correctionDraft?: string;
}
export interface MemoryDraft {
  memoryId: string;
  body: string;
  source: MemorySource;
  /** Observed text for explicit source review; never used as model context. */
  sourceBody?: string;
}
export type MemoryCommand =
  | { type: 'set-memory-draft'; goalId: string; draft: MemoryDraft | null }
  | { type: 'set-memory-correction-draft'; memoryId: string; expectedRevision: number; text: string | null }
  | { type: 'remember-memory'; memoryId: string; goalId: string; body: string; source: MemorySource; expectedSourceBody?: string }
  | { type: 'correct-memory'; memoryId: string; expectedRevision: number; body: string }
  | { type: 'forget-memory'; memoryId: string; expectedRevision: number }
  | { type: 'restore-memory'; memoryId: string; expectedRevision: number; use: 'active' | 'view-only' }
  | { type: 'undo-memory'; memoryId: string; expectedRevision: number };

export interface Activity {
  id: string;
  goalId: string | null;
  sessionId: string | null;
  kind: 'created' | 'edited' | 'sent' | 'responded' | 'stopped' | 'interrupted' | 'noted';
  summary: string;
  createdAt: string;
}

/** D1 invented-data preview. This is not the protected private-data schema. */
export interface DeskState {
  schemaVersion: 1 | 2;
  revision: number;
  updatedAt: string;
  goals: Goal[];
  sessions: Session[];
  messages: Message[];
  /** Required only in schema 2. Literal participant runs never relabel simulation messages. */
  conversationRuns?: ConversationRun[];
  drafts: Record<string, string>;
  goalDrafts: Record<string, GoalDraft>;
  workItems: WorkItem[];
  notes: Note[];
  /** Absent in earlier saves; opening CONTINUITY never initializes this field. */
  memories?: MemoryEntry[];
  /** Recoverable unsent teaching forms, kept separately from usable memories. */
  memoryDrafts?: Record<string, MemoryDraft>;
  activity: Activity[];
  selection: { goalId: string | null; sessionId: string | null; route: DeskRoute };
  preferences: { theme: ThemePreference; nexusView?: NexusView };
  /** Saved sample-mode metadata, never runtime authority or a live-connection assertion. */
  capabilities: { mode: 'synthetic'; provider: 'demo-only' | 'runtime-selected'; native: 'unavailable' };
}

export type WorkspaceState = DeskState;

export interface DomainOptions {
  now?: () => string;
  id?: () => string;
}

export type DeskCommand =
  | MemoryCommand
  | { type: 'create-goal'; title: string; nextStep?: string; parentId?: string | null; empty?: boolean }
  | { type: 'rename-domain'; domainId: string; title: string }
  | { type: 'set-domain-pinned'; domainId: string; pinned: boolean }
  | { type: 'set-folder-icon'; domainId: string; icon: FolderIconName }
  | { type: 'create-session'; goalId: string | null; title?: string }
  | { type: 'rename-session'; sessionId: string; title: string; expectedTitle?: string }
  | { type: 'set-session-pinned'; sessionId: string; pinned: boolean }
  | { type: 'set-participant-choice'; sessionId: string; participant: ParticipantIdentity }
  | { type: 'edit-session-intent'; sessionId: string; intent: string; expectedIntent?: string }
  | { type: 'set-session-intent-draft'; sessionId: string; text: string | null }
  | { type: 'move-session'; sessionId: string; goalId: string | null }
  | { type: 'select-goal'; goalId: string }
  | { type: 'select-session'; sessionId: string }
  | { type: 'select-ungrouped' }
  | { type: 'navigate'; route: DeskRoute }
  | { type: 'set-theme'; theme: ThemePreference }
  | { type: 'set-nexus-view'; view: NexusView }
  | { type: 'edit-next-step'; goalId: string; nextStep: string; expectedNextStep?: string }
  | { type: 'edit-domain-note'; goalId: string; purpose: string; expectedPurpose?: string }
  | { type: 'set-goal-draft'; goalId: string; field: GoalDraftField; value: string | null }
  | { type: 'set-draft'; sessionId: string; text: string; expectedText?: string }
  | { type: 'send-demo'; sessionId: string; expectedDraft?: string }
  | { type: 'interrupt-runs' }
  | { type: 'add-work'; goalId: string; title: string; roadmapColumn?: 'suggested' }
  | { type: 'add-note'; goalId: string; body: string };
