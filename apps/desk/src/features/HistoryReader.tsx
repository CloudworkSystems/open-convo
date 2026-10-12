import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_LEGACY_HISTORY_BYTES, parseLegacyHistory, type LegacyHistory } from '../domain/history-reader';
import { Modal } from '../ui/Modal';
import './history-reader.css';

/** Trust the actual top-level URL, never a query parameter or native message. */
export function canReadLocalHistory(): boolean {
  return window.top === window.self
    && ['http:', 'https:'].includes(window.location.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);
}

export function HistoryReader({ onClose }: { onClose: () => void }) {
  const available = canReadLocalHistory();
  const [history, setHistory] = useState<LegacyHistory | null>(null);
  const [fileName, setFileName] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const reading = useRef<FileReader | null>(null);
  const request = useRef(0);
  const mounted = useRef(true);
  const cancelRead = () => {
    request.current += 1;
    reading.current?.abort();
    reading.current = null;
  };
  const clearView = () => {
    cancelRead();
    setHistory(null);
    setFileName('');
    setSelectedId(null);
    setQuery('');
    setLoading(false);
    setError('');
    if (fileInput.current) fileInput.current.value = '';
  };
  useEffect(() => {
    mounted.current = true;
    // A page restored from the back/forward cache must not revive the file.
    window.addEventListener('pagehide', clearView);
    return () => {
      mounted.current = false;
      cancelRead();
      window.removeEventListener('pagehide', clearView);
    };
  }, []);

  const chooseFile = (file: File | undefined) => {
    if (!available || !file) return;
    cancelRead();
    const currentRequest = request.current;
    setError('');
    setLoading(false);
    if (file.size > MAX_LEGACY_HISTORY_BYTES) {
      setError('Choose a saved-session JSON file up to 32 MB. The previous file, if any, is still open.');
      return;
    }
    const reader = new FileReader();
    reading.current = reader;
    setLoading(true);
    const current = () => mounted.current && currentRequest === request.current;
    reader.onerror = () => {
      if (!current()) return;
      reading.current = null;
      setLoading(false);
      setError('This file could not be read. The previous file, if any, is still open.');
    };
    reader.onload = () => {
      if (!current()) return;
      reading.current = null;
      setLoading(false);
      if (!(reader.result instanceof ArrayBuffer)) {
        setError('This file could not be read. The previous file, if any, is still open.');
        return;
      }
      let text: string;
      try {
        // Replacing malformed UTF-8 would silently change saved message text.
        text = new TextDecoder('utf-8', { fatal: true }).decode(reader.result);
      } catch {
        setError('Choose a readable UTF-8 JSON file. The previous file, if any, is still open.');
        return;
      }
      const result = parseLegacyHistory(text);
      if (result.kind === 'invalid') {
        setError(`${result.message} The previous file, if any, is still open.`);
        return;
      }
      // Replace a successful view only after the complete new file validates.
      setHistory(result.history);
      setFileName(file.name);
      setSelectedId(result.history.sessions.some((session) => session.id === result.history.lastSelectedId)
        ? result.history.lastSelectedId : result.history.sessions[0]?.id ?? null);
      setQuery('');
    };
    reader.readAsArrayBuffer(file);
  };
  const closeReader = () => { clearView(); onClose(); };
  const visibleSessions = useMemo(() => {
    const search = query.toLocaleLowerCase();
    return (history?.sessions ?? []).filter((session) => !search
      || session.title.toLocaleLowerCase().includes(search)
      || session.summary.toLocaleLowerCase().includes(search)
      || session.messages.some((message) => message.body.toLocaleLowerCase().includes(search)));
  }, [history, query]);
  const selected = history?.sessions.find((session) => session.id === selectedId) ?? null;

  return <div className="history-reader-modal">
    <Modal title="Read old sessions" onClose={closeReader} scrollable>
      <div className="history-reader">
        <p className="history-reader-limit">Read-only. A chosen file stays in this view on your device. Nothing is saved, uploaded, or sent to AI. Closing clears the view.</p>
        {!available && <p className="history-reader-unavailable" role="status">Old saved sessions can be read in the local Mac preview. This hosted preview cannot open your history.</p>}
        <div className="history-reader-file">
          <label htmlFor="history-reader-file">Choose a saved-session file</label>
          <input ref={fileInput} id="history-reader-file" type="file" accept=".json,application/json" disabled={!available} data-autofocus
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              // Clear the chooser immediately so the same file can be retried.
              event.currentTarget.value = '';
              chooseFile(file);
            }} />
          {(history || loading) && <button type="button" className="secondary-button" onClick={clearView}>Close file</button>}
        </div>
        {loading && <p role="status">Reading the chosen file…</p>}
        {error && <p className="history-reader-error" role="alert">{error}</p>}
        {!history && !loading && available && <p className="history-reader-empty">Choose an old saved-session JSON file to read its conversations. Your current workspace stays separate.</p>}
        {history && <>
          <p className="history-reader-source" role="status">{fileName} · {history.sessions.length} {history.sessions.length === 1 ? 'session' : 'sessions'}</p>
          {history.folderMetadataWarning && <p className="history-reader-error" role="alert">{history.folderMetadataWarning}</p>}
          <label className="history-reader-search" htmlFor="history-reader-search">Search old sessions
            <input id="history-reader-search" type="search" value={query} placeholder="Search titles or conversation text…" onChange={(event) => setQuery(event.target.value)} />
          </label>
          {!history.sessions.length && <p className="history-reader-empty">This file contains no saved sessions.</p>}
          {!!history.sessions.length && <div className="history-reader-content">
            <nav className="history-reader-list" aria-label="Old saved sessions">
              <p className="history-reader-result-count" role="status">{visibleSessions.length} {visibleSessions.length === 1 ? 'result' : 'results'}</p>
              <ul>{visibleSessions.map((session) => <li key={session.id}>
                <button type="button" aria-label={`Read ${session.title}${session.archived || session.locked || session.pinned
                  ? `. ${[session.archived && 'Archived', session.locked && 'Locked', session.pinned && 'Pinned'].filter(Boolean).join(', ')}` : ''}`}
                  aria-current={selectedId === session.id ? 'true' : undefined}
                  onClick={() => setSelectedId(session.id)}>
                  <span className="history-session-title">{session.title}</span>
                  {(session.archived || session.locked || session.pinned) && <span className="history-session-markers">
                    {session.archived && <span>Archived</span>}{session.locked && <span>Locked</span>}{session.pinned && <span>Pinned</span>}
                  </span>}
                </button>
              </li>)}</ul>
              {!visibleSessions.length && <p>No sessions match this search.</p>}
            </nav>
            <section className="history-reader-transcript" aria-label="Saved conversation">
              {selected ? <>
                <h3>{selected.title}</h3>
                <dl className="history-session-details">
                  {selected.group && <><dt>Group</dt><dd>{selected.group}</dd></>}
                  {selected.time && <><dt>Recorded time</dt><dd>{selected.time}</dd></>}
                  {selected.retainedAt && <><dt>Saved time</dt><dd>{selected.retainedAt}</dd></>}
                  {!!selected.folderIds.length && <><dt>Folders</dt><dd>{selected.folderIds.map((id) => history.folders.find((folder) => folder.id === id)?.name ?? id).join(', ')}</dd></>}
                </dl>
                {selected.summary && <p className="history-session-summary">{selected.summary}</p>}
                {!selected.messages.length && <p>This session has no saved messages.</p>}
                <ol className="history-reader-messages">{selected.messages.map((message, index) => <li key={index}>
                  <article className="history-message">
                    <div className="history-message-heading">
                      <strong>{message.actor || 'Speaker not recorded'}</strong>
                      {message.time && <span>{message.time}</span>}
                      {message.system && <span>System</span>}
                      {message.contextOnly && <span>Context only</span>}
                    </div>
                    {message.participantId && <p className="history-message-routing">Participant: {message.participantId}</p>}
                    {!!message.recipients?.length && <p className="history-message-routing">To: {message.recipients.join(', ')}</p>}
                    <div className="history-message-body">{message.body}</div>
                  </article>
                </li>)}</ol>
              </> : <p>Choose a session to read.</p>}
            </section>
          </div>}
        </>}
        <div className="modal-actions"><button type="button" className="primary-button" onClick={closeReader}>Close reader</button></div>
      </div>
    </Modal>
  </div>;
}
