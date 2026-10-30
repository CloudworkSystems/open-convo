import type { NativeParticipantConfirmation } from '../adapters/native-participant-codec';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { ParticipantIdentity } from '../domain/conversation-run-types';
import {
  participantChoiceKey,
  sameParticipantIdentity,
  validParticipantChoice,
  type ParticipantChoice,
} from '../domain/participant-choices';
import { isLocalParticipant, localModelName, ollamaChoiceShortName, ollamaChoiceTitle, ollamaResidency, type LocalCatalogView } from '../domain/local-participant';
import { CLAUDE_DESTINATION, claudeChoiceTitle, isOffMacClaude } from '../domain/claude-participant';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';
import './participant-picker.css';

export function ParticipantPicker({
  choices,
  selected,
  disabled = false,
  error, confirmation, availabilityMessage, availabilityChecking = false, localNotice, selectedProblem, localCatalog, onOpen, onClose,
  onSelect,
}: {
  choices: readonly ParticipantChoice[];
  selected?: ParticipantIdentity;
  disabled?: boolean;
  error?: string;
  confirmation?: NativeParticipantConfirmation;
  availabilityMessage?: string;
  availabilityChecking?: boolean;
  /** Why the local route is down (contract section 20.2), in plain words. */
  localNotice?: string;
  /** Why the saved local choice can't be used: missing, changed or route down. */
  selectedProblem?: string;
  /** The newest catalog: the only evidence for calling an Ollama pin local or cloud. */
  localCatalog?: LocalCatalogView;
  onOpen?: () => void;
  onClose?: () => void;
  onSelect: (identity: ParticipantIdentity) => void;
}) {
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  const focused = useRef<HTMLElement | null>(null);
  const done = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open) { focused.current = null; return; }
    // A changed native pin can replace the focused choice. Keep keyboard
    // focus in this dialog without disturbing a still-present control.
    if (focused.current && !focused.current.isConnected
      && (!document.activeElement || document.activeElement === document.body)) done.current?.focus();
  });
  const close = () => { setOpen(false); onClose?.(); };
  const approved = choices.filter((choice) => validParticipantChoice(choice) && choice.approved);
  const selectedChoice = selected && approved.find((choice) => sameParticipantIdentity(choice.identity, selected));
  const availabilityStatus = availabilityChecking ? 'Checking participant availability. Your draft is kept.'
    : availabilityMessage ?? (approved.length ? approved.map((choice) => `${choice.identity.label}: ${choice.available ? 'Available' : `Unavailable — ${choice.unavailableReason}`}.`).join(' ')
      : 'No approved participants are listed.');
  // Only the current catalog's exact local entry is "stays on this Mac" (section 20.2).
  const residency = (identity: ParticipantIdentity) => ollamaResidency(identity, localCatalog);
  const shortName = (identity: ParticipantIdentity) => isLocalParticipant(identity)
    ? ollamaChoiceShortName(identity, localCatalog) : identity.model;
  const title = (identity: ParticipantIdentity) => isLocalParticipant(identity)
    ? ollamaChoiceTitle(identity, localCatalog) : isOffMacClaude(identity) ? claudeChoiceTitle(identity) : identity.label;
  // Where it runs: an off-Mac Claude entry always names Anthropic, never this Mac.
  const location = (identity: ParticipantIdentity) => isLocalParticipant(identity)
    ? { local: 'This Mac', cloud: 'Ollama’s servers', unknown: 'Unknown right now' }[residency(identity)]
    : isOffMacClaude(identity) ? CLAUDE_DESTINATION : identity.executionHost;
  const currentConfirmation = availabilityChecking || availabilityMessage ? undefined : confirmation;

  return <>
    <button
      type="button"
      className="model-harness-slot participant-picker-trigger"
      aria-label={`Model and participant: ${selected ? isLocalParticipant(selected) || isOffMacClaude(selected) ? title(selected) : `${selected.label}, ${selected.model}` : 'Choose participant'}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={selected ? isLocalParticipant(selected) || isOffMacClaude(selected) ? title(selected) : `${selected.label} · ${selected.model}` : 'Choose participant'}
      disabled={disabled}
      onClick={() => { setOpen(true); onOpen?.(); }}
    >
      <Icon name="spark" size={13} />
      <span>{selected ? shortName(selected) : 'Choose participant'}</span>
      <Icon name="chevron" size={12} />
    </button>
    {open && <Modal title="Model and participant" onClose={close} scrollable portalRoot={document.body}>
      <div className="participant-picker" onFocusCapture={(event) => { focused.current = event.target as HTMLElement; }}>
        <p id={descriptionId} className="participant-picker-explanation">
          Your selection applies to the next message. Choosing a participant does not start a call.
        </p>
        <p className={currentConfirmation ? 'participant-picker-explanation' : 'sr-only'} aria-live="polite" aria-atomic="true">
          {currentConfirmation ? currentConfirmation.state === 'unconfirmed' ? 'Not yet confirmed. Confirm paid usage is off in the Mac app.'
            : currentConfirmation.state === 'active' ? `You confirmed paid usage was off at ${new Date(currentConfirmation.confirmedAt).toLocaleString()}. ${currentConfirmation.runsLeft} ${currentConfirmation.runsLeft === 1 ? 'run' : 'runs'} left. True Convo cannot see your billing setting.`
            : `Confirmation ended: ${confirmationEndLabel(currentConfirmation.endedBy)}. Confirm again in the Mac app before sending.` : ''}
        </p>
        <p className={availabilityChecking || availabilityMessage ? 'participant-picker-availability' : 'sr-only'} role="status" aria-live="polite" aria-atomic="true">{availabilityStatus}</p>
        {onOpen && <button type="button" className="secondary-button" aria-disabled={availabilityChecking || undefined}
          onClick={() => { if (!availabilityChecking) onOpen(); }}>Check availability again</button>}
        {error && <p className="participant-picker-error" role="alert">{error}</p>}
        {localNotice && !availabilityChecking && <p className="participant-picker-availability" data-local-route-notice>{localNotice}</p>}
        {selected && !selectedChoice && <section className="participant-picker-missing" aria-label="Saved participant selection">
          <div className="participant-picker-heading">
            <h3>{title(selected)}</h3>
            <span className="participant-picker-selected">Selected</span>
          </div>
          <dl className="participant-picker-details">
            <dt>Model</dt><dd>{isLocalParticipant(selected) ? localModelName(selected) : selected.model}</dd>
            <dt>Provider</dt><dd>Unknown</dd>
            <dt>Data destination</dt><dd>Unknown</dd>
            <dt>Process location</dt><dd>{location(selected)}</dd>
          </dl>
          <p className="participant-picker-availability">{availabilityChecking ? 'Checking participant availability.' : availabilityMessage ?? (isLocalParticipant(selected) && selectedProblem
            ? `Unavailable — ${selectedProblem}` : 'Unavailable — this saved selection is not in the approved participant list.')}</p>
        </section>}
        {approved.length === 0
          ? !availabilityMessage && <p className="participant-picker-empty">No approved participants are listed.</p>
          : <ul className="participant-picker-choices" aria-label="Approved participants">
            {approved.map((choice, index) => {
              const active = !!selected && sameParticipantIdentity(selected, choice.identity);
              const detailsId = `${descriptionId}-details-${index}`;
              const availabilityId = `${descriptionId}-availability-${index}`;
              return <li key={participantChoiceKey(choice.identity)} className={`participant-picker-choice${active ? ' is-selected' : ''}`}>
                <div className="participant-picker-heading">
                  <h3>{title(choice.identity)}</h3>
                  {active && <span className="participant-picker-selected"><Icon name="check" size={12} />Selected</span>}
                </div>
                <dl id={detailsId} className="participant-picker-details">
                  <dt>Model</dt><dd>{isLocalParticipant(choice.identity) ? localModelName(choice.identity) : choice.identity.model}</dd>
                  {isLocalParticipant(choice.identity) && <><dt>Version</dt><dd>{choice.identity.model.slice(choice.identity.label.length + 1, choice.identity.label.length + 13)}</dd></>}
                  <dt>Provider</dt><dd>{choice.provider}</dd>
                  <dt>Data destination</dt><dd>{choice.destination}</dd>
                  <dt>Process location</dt><dd>{location(choice.identity)}</dd>
                </dl>
                <p id={availabilityId} className="participant-picker-availability">
                  {availabilityChecking ? 'Checking availability' : choice.available ? 'Available' : `Unavailable — ${choice.unavailableReason}`}
                </p>
                <button
                  type="button"
                  className="secondary-button participant-picker-select"
                  aria-label={`Choose participant: ${isLocalParticipant(choice.identity) || isOffMacClaude(choice.identity) ? title(choice.identity) : `${choice.identity.label}, ${choice.identity.model}`}`}
                  aria-pressed={active}
                  aria-describedby={`${descriptionId} ${detailsId} ${availabilityId}`}
                  disabled={disabled}
                  onClick={() => onSelect(choice.identity)}
                >Choose participant</button>
              </li>;
            })}
          </ul>}
        <p className="participant-picker-explanation">
          Process location is where the participant runs. Data destination is where your message is sent.
          An unavailable participant can be selected, but cannot receive a message.
        </p>
        <button ref={done} type="button" className="secondary-button participant-picker-done" onClick={close}>Done</button>
      </div>
    </Modal>}
  </>;
}

function confirmationEndLabel(reason: string) {
  const labels: Record<string, string> = { lock: 'the Mac was locked or its session changed', sleep: 'the Mac or screen slept',
    logout: 'the Mac logged out or shut down', 'cli-changed': 'the Claude installation changed',
    'login-changed': 'the Claude login changed', 'run-limit': 'the five-run trial limit was reached', 'paid-overflow': 'paid usage was reported' };
  return labels[reason] ?? 'confirmation is no longer active';
}
