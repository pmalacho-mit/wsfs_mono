#!/usr/bin/env bash
#
# The type gates, and which one covers what.
#
# `tsc` reads `.ts` and not `.svelte`, so on its own it can only speak for the
# one package that has no components -- core. Everything above core IS mostly
# components, and running plain `tsc` over it reports every `.svelte` import as
# a missing module, which is noise rather than a finding.
#
# So: `tsc` for core, and `svelte-check` from the sample app -- which is where
# the Svelte toolchain and the path aliases live -- for the rest.
set -uo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

status=0

echo "== wsfs_core_suede (tsc) =="
npx tsc -p tsconfig.json || status=1

echo
echo "== every package (svelte-check) =="
if [ ! -d samples/frontend/node_modules ]; then
  echo "samples/frontend has no node_modules -- run 'cd samples/frontend && npm install'"
  exit 1
fi

# EVERY error svelte-check reports, not only the packages'.
#
# This used to filter to `wsfs_*_suede/`, on the reasoning that the sample app
# and the suites were somebody else's problem. They are not: they are where the
# harness lives and where most test code is, and the filter meant a
# `.test.svelte` that would not even PARSE reported as clean here. It cost a
# green typecheck, a green unit run, and a browser suite that timed out with no
# output at all -- because a component that fails to compile never reports, and
# a report that never arrives looks exactly like a hang.
#
# Nothing is filtered now. If a dependency's own file ever turns up here, name
# that file rather than restoring a pattern that hides a whole directory.
ours=$(
  (cd samples/frontend && npx svelte-check --tsconfig ./tsconfig.json --output machine 2>/dev/null) \
    | grep -E '^[0-9]+ ERROR' \
    || true
)

if [ -n "$ours" ]; then
  echo "$ours"
  echo
  echo "$(printf '%s\n' "$ours" | wc -l) type error(s)"
  status=1
else
  echo "typecheck clean"
fi

exit $status
