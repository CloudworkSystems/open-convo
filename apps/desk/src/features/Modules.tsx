import { useEffect, useMemo, useRef, useState } from 'react';
import type { DeskState } from '../domain/types';
import { Icon } from '../ui/Icon';
import { RoadmapBoard } from './RoadmapBoard';
import { workspaceRoadmapCards } from '../domain/recovery-roadmap';
import { folderOptions } from '../domain/folder-paths';
import { useDeskRuntime } from '../app/runtime';

export interface SaveStatus {
  kind: 'saved' | 'saving' | 'error' | 'memory';
  message: string;
}

export function Work({
  state,
  onWorkCreate,
  onDraftChange,
  readOnly = false,
  active = state.selection.route === 'work',
}: {
  state: DeskState;
  onWorkCreate: (goalId: string, title: string) => void;
  onDraftChange: (goalId: string, value: string) => void;
  readOnly?: boolean;
  active?: boolean;
}) {
  const [folderChoice, setFolderChoice] = useState<{ selectionId: string | null; goalId: string } | null>(null);
  const selectedFolder = state.goals.find((goal) => goal.id === state.selection.goalId);
  // Card context can be chosen without changing the current session or creating
  // a folder. Each existing folder keeps its own durable, recoverable draft.
  const goalId = folderChoice?.selectionId === state.selection.goalId && state.goals.some((goal) => goal.id === folderChoice.goalId)
    ? folderChoice.goalId : selectedFolder?.id ?? state.goals[0]?.id ?? null;
  const title = goalId ? state.goalDrafts[goalId]?.workTitle ?? '' : '';
  const titleInput = useRef<HTMLInputElement>(null);
  const workspaceCards = useMemo(() => workspaceRoadmapCards(state.workItems), [state.workItems]);

  useEffect(() => {
    // A shared folder change ends the explicit card context. Returning to an
    // earlier folder must not revive a choice made before leaving it.
    setFolderChoice(null);
  }, [state.selection.goalId]);

  useEffect(() => {
    // Entry starts a card; changing its folder must keep focus in the picker
    // or rail. Disabled inputs naturally decline focus in read-only/no-folder views.
    if (active) titleInput.current?.focus();
  }, [active]);
  return (
    <div className="module-page work-page">
      <RoadmapBoard workspaceCards={workspaceCards} createCard={
        <form
          className="roadmap-create"
          aria-label="Create a suggested card"
          data-preview-refresh-hold={title ? 'card-title' : undefined}
          onSubmit={(event) => {
            event.preventDefault();
            if (!readOnly && goalId && title.trim()) onWorkCreate(goalId, title.trim());
          }}
        >
          <label htmlFor="work-folder">Session folder</label>
          <select id="work-folder" value={goalId ?? ''} disabled={readOnly || !state.goals.length}
            onChange={(event) => setFolderChoice({ selectionId: state.selection.goalId, goalId: event.target.value })}>
            {!state.goals.length && <option value="">No session folders</option>}
            {folderOptions(state.goals).map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
          </select>
          <label htmlFor="work-title">Card title</label>
          <input
            id="work-title"
            ref={titleInput}
            value={title}
            onChange={(event) => goalId && onDraftChange(goalId, event.target.value)}
            placeholder="Suggest a piece of work…"
            maxLength={180}
            disabled={readOnly || !goalId}
          />
          <button type="submit" className="secondary-button" disabled={readOnly || !goalId || !title.trim()}>
            <Icon name="plus" size={16} />
            Create card
          </button>
          {!goalId && <p>Create a session folder to add a card.</p>}
        </form>
      } />
    </div>
  );
}

export function Data({ saveStatus, onSetup, onReadHistory }: { saveStatus: SaveStatus; onSetup: () => void; onReadHistory?: () => void }) {
  const nativeProof = useDeskRuntime().mode === 'native-proof';
  return (
    <div className="module-page">
      <div className="module-page-heading">
        <span className="eyebrow">DATA & CONTROL</span>
        <h2>
          Know what's here.
          <br />
          Know what it can do.
        </h2>
        <p>Clear limits are part of a dependable workspace.</p>
      </div>
      <section className="data-status-card">
        <span className="data-status-icon">
          <Icon name="shield" size={28} />
        </span>
        <div>
          <span className="eyebrow">THIS BUILD</span>
          <h3>Sample data only</h3>
          <p>
            {nativeProof ? 'This native proof uses invented data. Protected private storage is not ready.'
              : 'This foundation has no encryption or lock. Please keep private details out until protected storage is ready.'}
          </p>
        </div>
      </section>
      <div className="data-rows">
        <div>
          <span>{nativeProof ? 'Invented native workspace saving' : 'Sample workspace saving'}</span>
          <strong>{saveStatus.message}</strong>
        </div>
        <div>
          <span>Connected AI models</span>
          <strong>None · demo replies only</strong>
        </div>
        <div>
          <span>Learning from your records</span>
          <strong>Off · not implemented</strong>
        </div>
        <div>
          <span>Mac dictation connection</span>
          <strong>Not connected in this preview</strong>
        </div>
      </div>
      <section className="data-planned" aria-label="Old saved sessions">
        <h3>Your old sessions</h3>
        <p>{nativeProof ? 'Reading old saved sessions is unavailable in this invented native proof.'
          : 'Choose a saved-session file in the local Mac preview to read it. The file stays unchanged and is kept out of this sample workspace.'}</p>
        <button type="button" className="secondary-button" disabled={!onReadHistory} onClick={onReadHistory}>Read old sessions</button>
      </section>
      <div className="data-planned">
        <h3>Your controls, before private use.</h3>
        <p>
          Encrypted storage, locking, retention, Trash, and selected encrypted transfer need working
          privacy checks before they become available.
        </p>
        <div className="planned-controls">
          {['Lock workspace', 'Encrypted transfer', 'Manage Trash'].map((label) => (
            <button key={label} type="button" className="secondary-button" disabled>
              {label}
              <span className="planned-label">Planned</span>
            </button>
          ))}
        </div>
      </div>
      <button type="button" className="text-button setup-link" onClick={onSetup}>
        View setup <Icon name="arrow" size={16} />
      </button>
    </div>
  );
}

export function Setup({ onReturn }: { onReturn: () => void }) {
  return (
    <div className="module-page">
      <div className="module-page-heading">
        <span className="eyebrow">SETUP</span>
        <h2>
          A simple place
          <br />
          to begin.
        </h2>
        <p>
          Try the whole workspace with invented details. Your model and native connections come in
          later build stages.
        </p>
      </div>
      <div className="setup-card">
        <span className="setup-step">01</span>
        <div>
          <h3>A sample workspace</h3>
          <p>
            Create a domain, start a session, and choose a next step. These controls work in this
            preview.
          </p>
          <span className="available-label">
            <Icon name="check" size={14} />
            Available now
          </span>
        </div>
      </div>
      <div className="setup-card">
        <span className="setup-step">02</span>
        <div>
          <h3>A model you choose</h3>
          <p>
            Demo responses let you try the conversation flow. No provider is connected and no AI
            calls are made.
          </p>
          <span className="quiet-badge">Demo only</span>
        </div>
      </div>
      <div className="setup-card">
        <span className="setup-step">03</span>
        <div>
          <h3>Your native tools</h3>
          <p>
            Dictation is being tested separately on your Mac. This preview has no microphone, file,
            or keychain access.
          </p>
          <span className="quiet-badge">Connection planned</span>
        </div>
      </div>
      <button type="button" className="primary-button" onClick={onReturn}>
        Go to Nexus <Icon name="arrow" size={18} />
      </button>
    </div>
  );
}
