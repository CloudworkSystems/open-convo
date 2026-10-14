#!/usr/bin/env bash
# Step 2, PR 5: the kill-and-reopen proof, with invented data only.
#
#   scripts/protection-proof.sh          12 rounds per store (the default)
#   scripts/protection-proof.sh 50       50 rounds per store
#
# A test-only writer (ProtectionProofHost) writes invented data through the
# real protected stores (the Desk store, dictation words, kept recordings)
# and is killed with SIGKILL at a random moment each round, like a force
# quit or a crash. Each time, everything it acknowledged must reopen, nothing
# may be damaged, and the invented words must never appear in the clear on
# disk. Everything happens in a temporary folder with invented, file-held
# keys: nothing touches the Keychain, ~/.tca-dictate or the Desk folders.
set -euo pipefail
cd "$(dirname "$0")/.."
rounds="${1:-12}"
case "$rounds" in (''|*[!0-9]*) echo "rounds must be a number" >&2; exit 64;; esac
echo "Kill-and-reopen proof: $rounds rounds per store."
PROOF_ROUNDS="$rounds" swift test --filter KillAndReopenProofTests 2>&1 \
  | grep -E "Test Case .*(passed|failed)|error:|Executed [0-9]+ tests" \
  | grep -v "Executed 0 tests"
