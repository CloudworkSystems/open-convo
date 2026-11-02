import { useEffect, useId, useMemo, useRef, useState } from 'react';

/** One standard emoji and its Unicode name. */
export type EmojiEntry = readonly [emoji: string, name: string];
interface EmojiGroup { name: string; emoji: EmojiEntry[] }

let loaded: Promise<EmojiGroup[]> | undefined;
const names = new Map<string, string>();

/** The full standard emoji set, loaded once on first use (a separate file in the build). */
export function loadEmoji(): Promise<EmojiGroup[]> {
  loaded ??= import('../content/emoji.json').then((module) => {
    const groups = (module.default as unknown as { groups: EmojiGroup[] }).groups;
    for (const group of groups) for (const [emoji, name] of group.emoji) names.set(emoji, name);
    return groups;
  });
  return loaded;
}

/** The emoji's Unicode name once the set has loaded, otherwise the emoji itself. */
export function emojiName(emoji: string): string {
  return names.get(emoji) ?? emoji;
}

const SEARCH_LIMIT = 80;

export interface EmojiPickerProps {
  chosen: ReadonlySet<string>;
  onPick: (emoji: string, name: string) => void;
}

/** A searchable picker over every standard emoji, one group at a time. */
export function EmojiPicker({ chosen, onPick }: EmojiPickerProps) {
  const [groups, setGroups] = useState<EmojiGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [group, setGroup] = useState(0);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const searchId = useId();
  useEffect(() => {
    let live = true;
    loadEmoji().then((value) => { if (live) setGroups(value); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (groups) search.current?.focus(); }, [groups]);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const found = useMemo(() => {
    if (!groups || !words.length) return null;
    const all = groups.flatMap((entry) => entry.emoji);
    return all.filter(([, name]) => {
      const lower = name.toLowerCase();
      return words.every((word) => lower.includes(word));
    });
  }, [groups, words.join(' ')]);
  if (failed) return <p className="emoji-picker-note">The emoji list couldn’t load. Reload the Desk to try again.</p>;
  if (!groups) return <p className="emoji-picker-note" aria-live="polite">Loading emoji…</p>;
  const shown = found ?? groups[group].emoji;
  return (
    <div className="emoji-picker" data-emoji-picker>
      <input id={searchId} ref={search} className="emoji-picker-search" type="search" placeholder="Search emoji"
        aria-label="Search emoji" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" spellCheck={false} />
      {!found && <div className="emoji-picker-groups" role="group" aria-label="Emoji groups">
        {groups.map((entry, index) => <button key={entry.name} type="button" className="emoji-picker-group"
          aria-pressed={index === group} title={entry.name} aria-label={entry.name} onClick={() => setGroup(index)}>
          <span aria-hidden="true">{entry.emoji[0][0]}</span>
        </button>)}
      </div>}
      <div className="emoji-picker-grid" role="group" aria-label={found ? 'Search results' : groups[group].name}>
        {shown.slice(0, found ? SEARCH_LIMIT : undefined).map(([emoji, name]) => <button key={emoji} type="button"
          className="emoji-picker-choice" aria-pressed={chosen.has(emoji)} aria-label={name} title={name}
          onClick={() => onPick(emoji, name)}>
          <span aria-hidden="true">{emoji}</span>
        </button>)}
      </div>
      {found && <p className="emoji-picker-note" aria-live="polite">
        {found.length === 0 ? 'No emoji match that search.'
          : found.length > SEARCH_LIMIT ? `Showing ${SEARCH_LIMIT} of ${found.length}. Type more to narrow it.` : `${found.length} found.`}
      </p>}
    </div>
  );
}
