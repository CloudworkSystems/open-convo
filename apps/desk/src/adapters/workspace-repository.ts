import type { DeskState } from '../domain/types';
import type { LoadResult, SaveResult } from './browser-repository';

export type WorkspaceLoadResult = LoadResult;
export type UnknownWorkspaceSave = {
  kind: 'unknown';
  error: string;
  attemptedState: DeskState;
  requestId: string;
};
export type WorkspaceSaveResult = SaveResult | UnknownWorkspaceSave | { kind: 'unavailable'; error: string };

/** Only a native authority understands a dictation delivery; others refuse it. */
export interface WorkspaceSaveOptions { readonly dictationDeliveryId?: string }

/** One explicit authority per mounted runtime. Native failures never yield empty. */
export interface WorkspaceRepository {
  loadLatest(): Promise<WorkspaceLoadResult>;
  save(state: DeskState, expectedRevision: number | null, options?: WorkspaceSaveOptions): Promise<WorkspaceSaveResult>;
  subscribe(changed: () => void): () => void;
  /** Reconcile the original request; never substitute the latest visible state. */
  reconcilePending?(): Promise<WorkspaceSaveResult>;
}
