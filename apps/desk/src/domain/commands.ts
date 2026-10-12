import { isFolderIcon } from './folder-icons';
import { demoResponse, domainClock } from './demo';
import { defaultSessionTitle } from './session-naming';
import { sameParticipantIdentity, validParticipantIdentity } from './participant-choices';
import { isMemoryCommand, mutateMemory } from './memory';
import type { Activity, DeskCommand, DeskState, DomainOptions, Goal, Session } from './types';

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

function requireText(value: string, label: string): void {
  if (!value.trim()) throw new DomainError(`${label} cannot be empty.`);
}

/** These choices belong to this tab's view, not the shared content revision. */
export function isViewCommand(command: DeskCommand): boolean {
  return command.type === 'navigate' || command.type === 'select-goal' || command.type === 'select-session' || command.type === 'select-ungrouped' || command.type === 'set-theme' || command.type === 'set-nexus-view';
}

function logicalCommandTime(state: DeskState, wallTime: string): string {
  const wallMilliseconds = Date.parse(wallTime);
  if (!Number.isFinite(wallMilliseconds)) throw new DomainError('The command timestamp is invalid. Your attempted work has not been applied.');
  let latest = Math.max(wallMilliseconds, Date.parse(state.updatedAt));
  for (const value of [...state.goals, ...state.sessions]) {
    latest = Math.max(latest, Date.parse(value.createdAt), Date.parse(value.updatedAt));
  }
  for (const value of [...state.messages, ...state.workItems, ...state.notes, ...state.activity]) {
    latest = Math.max(latest, Date.parse(value.createdAt));
  }
  for (const value of state.memories ?? []) latest = Math.max(latest, Date.parse(value.createdAt), Date.parse(value.updatedAt));
  // Revisions order writes; timestamps must remain valid even when the device clock moves back.
  return new Date(latest).toISOString();
}

/** Selection never determines a content command's target: every command carries its origin ID. */
export function applyCommand(state: DeskState, command: DeskCommand, options: DomainOptions = {}): DeskState {
  const { now: wallTime, id } = domainClock(options);
  const now = isViewCommand(command) ? state.updatedAt : logicalCommandTime(state, wallTime);
  const next = structuredClone(state);
  const goal = (goalId: string): Goal => {
    const found = next.goals.find((value) => value.id === goalId);
    if (!found) throw new DomainError('The goal no longer exists. Your attempted edit has not been applied.');
    return found;
  };
  const session = (sessionId: string): Session => {
    const found = next.sessions.find((value) => value.id === sessionId);
    if (!found) throw new DomainError('The session no longer exists. Your attempted edit has not been applied.');
    return found;
  };
  const event = (kind: Activity['kind'], summary: string, goalId: string | null, sessionId: string | null = null) => {
    next.activity.push({ id: id(), kind, summary, goalId, sessionId, createdAt: now });
  };

  if (isMemoryCommand(command)) {
    try {
      const result = mutateMemory(next, command, now);
      if (!result.changed) return state;
      if (result.summary) event('noted', result.summary, result.goalId ?? null);
    } catch (error) {
      throw new DomainError(error instanceof Error ? error.message : 'The memory change could not be applied.');
    }
  } else switch (command.type) {
    case 'create-goal': {
      requireText(command.title, 'Domain name');
      if (command.parentId) goal(command.parentId);
      const goalId = id();
      const sessionId = command.empty ? null : id();
      next.goals.push({ id: goalId, parentId: command.parentId ?? null, title: command.title.trim(), nextStep: command.nextStep ?? '', createdAt: now, updatedAt: now });
      if (sessionId) {
        next.sessions.push({ id: sessionId, goalId, title: defaultSessionTitle(now), createdAt: now, updatedAt: now });
        next.drafts[sessionId] = '';
      }
      next.goalDrafts[goalId] = { nextStep: null, workTitle: '' };
      next.selection = { goalId, sessionId, route: 'sessions' };
      next.preferences.nexusView = 'navigator';
      event('created', sessionId ? 'Domain and session created.' : 'Domain created.', goalId, sessionId);
      break;
    }
    case 'rename-domain': {
      const target = goal(command.domainId);
      const title = command.title.trim();
      requireText(title, 'Domain name');
      if (title.length > 180) throw new DomainError('Domain name must be 180 characters or fewer.');
      if (target.title === title) return state;
      target.title = title;
      target.updatedAt = now;
      event('edited', 'Domain renamed.', target.id);
      break;
    }
    case 'create-session': {
      if (command.goalId !== null) goal(command.goalId);
      const sessionId = id();
      const title = command.title?.trim() || defaultSessionTitle(now);
      next.sessions.push({ id: sessionId, goalId: command.goalId, title, createdAt: now, updatedAt: now });
      next.drafts[sessionId] = '';
      next.selection = { goalId: command.goalId, sessionId, route: 'sessions' };
      next.preferences.nexusView = 'navigator';
      event('created', 'Session created.', command.goalId, sessionId);
      break;
    }
    case 'set-domain-pinned': {
      const target = goal(command.domainId);
      if (typeof command.pinned !== 'boolean') throw new DomainError('A domain pin setting must be true or false.');
      if ((target.pinned ?? false) === command.pinned) return state;
      if (command.pinned) target.pinned = true;
      else delete target.pinned;
      target.updatedAt = now;
      event('edited', command.pinned ? 'Domain pinned.' : 'Domain unpinned.', target.id);
      break;
    }
    case 'set-folder-icon': {
      const target = goal(command.domainId);
      if (!isFolderIcon(command.icon)) throw new DomainError('Choose an available folder icon.');
      if ((target.icon ?? 'default') === command.icon) return state;
      if (command.icon === 'default') delete target.icon;
      else target.icon = command.icon;
      target.updatedAt = now;
      event('edited', 'Folder icon changed.', target.id);
      break;
    }
    case 'rename-session': {
      const target = session(command.sessionId);
      const title = command.title.trim();
      requireText(title, 'Session name');
      if (title.length > 180) throw new DomainError('Session name must be 180 characters or fewer.');
      if (command.expectedTitle !== undefined && target.title !== command.expectedTitle) {
        throw new DomainError('The session name changed while you were editing. Keep your edit and reload before trying again.');
      }
      if (target.title === title) return state;
      target.titleHistory ??= [{ text: target.title, createdAt: now }];
      target.titleHistory.push({ text: title, createdAt: now });
      target.title = title;
      target.updatedAt = now;
      event('edited', 'Session renamed.', target.goalId, target.id);
      break;
    }
    case 'set-session-pinned': {
      const target = session(command.sessionId);
      if (typeof command.pinned !== 'boolean') throw new DomainError('A session pin setting must be true or false.');
      if ((target.pinned ?? false) === command.pinned) return state;
      if (command.pinned) target.pinned = true;
      else delete target.pinned;
      target.updatedAt = now;
      event('edited', command.pinned ? 'Session pinned.' : 'Session unpinned.', target.goalId, target.id);
      break;
    }
    case 'edit-session-intent': {
      const target = session(command.sessionId);
      const intent = command.intent.trim();
      if (intent.length > 4000) throw new DomainError('Session intent must be 4000 characters or fewer.');
      if (command.expectedIntent !== undefined && (target.intent ?? '') !== command.expectedIntent) {
        throw new DomainError('The session intent changed while you were editing. Keep your edit and reload before trying again.');
      }
      const changed = (target.intent ?? '') !== intent;
      if (!changed && target.intentDraft === undefined) return state;
      if (changed) {
        target.intentHistory ??= target.intent === undefined ? [] : [{ text: target.intent, createdAt: now }];
        target.intentHistory.push({ text: intent, createdAt: now });
        if (intent) target.intent = intent;
        else delete target.intent;
      }
      delete target.intentDraft;
      target.updatedAt = now;
      event('edited', changed ? intent ? 'Session intent saved.' : 'Session intent cleared.' : 'Session intent draft closed.', target.goalId, target.id);
      break;
    }
    case 'set-session-intent-draft': {
      const target = session(command.sessionId);
      if (command.text !== null && command.text.length > 4000) throw new DomainError('A session intent draft must be 4000 characters or fewer.');
      if ((target.intentDraft ?? null) === command.text) return state;
      if (command.text === null) delete target.intentDraft;
      else target.intentDraft = command.text;
      break;
    }
    case 'set-participant-choice': {
      if (!validParticipantIdentity(command.participant)) throw new DomainError('Choose a valid participant. The saved choice was kept.');
      const target = session(command.sessionId);
      if (target.participantChoice && sameParticipantIdentity(target.participantChoice, command.participant)) return state;
      target.participantChoice = { ...command.participant };
      target.updatedAt = now;
      event('edited', 'Participant choice saved for this session.', target.goalId, target.id);
      break;
    }
    case 'select-goal': {
      goal(command.goalId);
      next.selection.goalId = command.goalId;
      next.selection.sessionId = null;
      break;
    }
    case 'select-session': {
      const target = session(command.sessionId);
      next.selection = { goalId: target.goalId, sessionId: target.id, route: 'sessions' };
      next.preferences.nexusView = 'navigator';
      break;
    }
    case 'select-ungrouped': {
      next.selection = { goalId: null, sessionId: null, route: 'sessions' };
      next.preferences.nexusView = 'navigator';
      break;
    }
    case 'move-session': {
      const target = session(command.sessionId);
      if (command.goalId !== null) goal(command.goalId);
      if (target.goalId === command.goalId) return state;
      target.goalId = command.goalId;
      target.updatedAt = now;
      if (next.selection.sessionId === target.id) next.selection.goalId = command.goalId;
      event('edited', command.goalId === null ? 'Session returned to unassigned sessions.' : 'Session placed in a domain.', command.goalId, target.id);
      break;
    }
    case 'navigate':
      next.selection.route = command.route;
      break;
    case 'set-theme':
      next.preferences.theme = command.theme;
      break;
    case 'set-nexus-view':
      next.preferences.nexusView = command.view;
      next.selection.route = 'sessions';
      break;
    case 'edit-next-step': {
      const target = goal(command.goalId);
      if (command.expectedNextStep !== undefined && target.nextStep !== command.expectedNextStep) {
        throw new DomainError('The next step changed while you were editing. Keep your edit and reload before trying again.');
      }
      if (target.nextStep === command.nextStep && next.goalDrafts[target.id].nextStep === null) return state;
      target.nextStep = command.nextStep;
      target.updatedAt = now;
      next.goalDrafts[target.id].nextStep = null;
      event('edited', 'Next step edited.', target.id);
      break;
    }
    case 'edit-domain-note': {
      const target = goal(command.goalId);
      const purpose = command.purpose.trim();
      if (purpose.length > 4000) throw new DomainError('A domain note must be 4000 characters or fewer.');
      if (command.expectedPurpose !== undefined && (target.purpose ?? '') !== command.expectedPurpose) {
        throw new DomainError('The domain note changed while you were editing. Keep your edit and reload before trying again.');
      }
      if ((target.purpose ?? '') === purpose && (next.goalDrafts[target.id].purpose ?? null) === null) return state;
      if (purpose) target.purpose = purpose;
      else delete target.purpose;
      target.updatedAt = now;
      delete next.goalDrafts[target.id].purpose;
      event('edited', purpose ? 'Domain note saved.' : 'Domain note cleared.', target.id);
      break;
    }
    case 'set-goal-draft': {
      const target = goal(command.goalId);
      if (command.field === 'workTitle') {
        if (command.value === null) throw new DomainError('A work title draft must be text.');
        if (next.goalDrafts[target.id].workTitle === command.value) return state;
        next.goalDrafts[target.id].workTitle = command.value;
      } else if (command.field === 'purpose') {
        if (command.value !== null && command.value.length > 4000) throw new DomainError('A domain note draft must be 4000 characters or fewer.');
        if ((next.goalDrafts[target.id].purpose ?? null) === command.value) return state;
        if (command.value === null) delete next.goalDrafts[target.id].purpose;
        else next.goalDrafts[target.id].purpose = command.value;
      } else {
        if (next.goalDrafts[target.id].nextStep === command.value) return state;
        next.goalDrafts[target.id].nextStep = command.value;
      }
      break;
    }
    case 'set-draft': {
      const target = session(command.sessionId);
      if (command.expectedText !== undefined && next.drafts[target.id] !== command.expectedText) {
        throw new DomainError('This draft changed while you were editing. Your attempted text has not been applied.');
      }
      next.drafts[target.id] = command.text;
      target.updatedAt = now;
      break;
    }
    case 'send-demo': {
      const target = session(command.sessionId);
      const draft = next.drafts[target.id];
      if (command.expectedDraft !== undefined && draft !== command.expectedDraft) {
        throw new DomainError('The draft changed before Send. Review the current text before trying again.');
      }
      requireText(draft, 'Draft');
      const originGoal = target.goalId === null ? null : goal(target.goalId);
      next.messages.push(
        { id: id(), sessionId: target.id, role: 'user', body: draft, status: 'complete', provenance: 'simulation', createdAt: now },
        { id: id(), sessionId: target.id, role: 'assistant', body: demoResponse(draft, originGoal?.title ?? 'this unassigned conversation'), status: 'complete', provenance: 'simulation', createdAt: now },
      );
      next.drafts[target.id] = '';
      target.updatedAt = now;
      event('responded', 'Simulated reply created in this session.', target.goalId, target.id);
      break;
    }
    case 'interrupt-runs': {
      const running = next.messages.filter((value) => value.status === 'running');
      if (!running.length) return state;
      for (const message of running) {
        message.status = 'interrupted';
        const target = session(message.sessionId);
        event('interrupted', 'Interrupted simulation retained; nothing resumed automatically.', target.goalId, target.id);
      }
      break;
    }
    case 'add-work': {
      goal(command.goalId);
      requireText(command.title, 'Work title');
      if (command.roadmapColumn !== undefined && command.roadmapColumn !== 'suggested') throw new DomainError('New cards must use an available column.');
      next.workItems.push({ id: id(), goalId: command.goalId, title: command.title.trim(), status: 'planned',
        ...(command.roadmapColumn ? { roadmapColumn: command.roadmapColumn } : {}), createdAt: now });
      next.goalDrafts[command.goalId].workTitle = '';
      event('created', command.roadmapColumn === 'suggested' ? 'Suggested card created.' : 'Planned work added.', command.goalId);
      break;
    }
    case 'add-note': {
      goal(command.goalId);
      requireText(command.body, 'Note');
      next.notes.push({ id: id(), goalId: command.goalId, body: command.body, createdAt: now });
      event('noted', 'Synthetic scratch note added.', command.goalId);
      break;
    }
    default: {
      const exhaustive: never = command;
      throw new DomainError(`Unsupported command: ${String(exhaustive)}`);
    }
  }
  if (!isViewCommand(command)) {
    next.revision = state.revision + 1;
    next.updatedAt = now;
  }
  return next;
}
