// Plain sentences the owner sees. The library, the command and the pack
// share them so a passing check is never described as proof against changes.

export const PLAIN_NOTE = 'This is your own record. It shows what you recorded, not when, to anyone else.';

export const COMPLETE_LINE = 'The file is complete and in order.';

export const END_UNCHECKED = "The end of the ledger can't be checked.";

export const DIDNT_FINISH = "Your last record didn't finish, so nothing was added.";

export const WAS_SAVED = 'Your last record was saved.';

export const ANOTHER_SAVE = 'Another save is running on this ledger. Try again when it finishes.';

export const CLEARED_LOCK = 'An earlier save stopped without finishing; cleared its lock.';

export const ANOTHER_RECOVERY = 'Another command is recovering; try again in a moment.';

export const FILE_CHANGED = 'This file changed while it was being read. Wait until it has finished copying or saving, then record it again.';

export const RECORD_FIRST = 'Record at least one original first:';

export function cutoffLine(actualSeq, expectedSeq) {
  return `The ledger ends at entry ${actualSeq}, but your last record was entry ${expectedSeq}.`;
}

// Single quotes keep spaces and other shell characters in a copied command.
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function recordCommand(ledgerPath) {
  return `node packages/creator-proof/bin/creator-proof.mjs record <media file> --title "<text>" --ledger ${shellQuote(ledgerPath)}`;
}

export function unlockCommand(ledgerPath) {
  return `node packages/creator-proof/bin/creator-proof.mjs unlock --ledger ${shellQuote(ledgerPath)}`;
}
