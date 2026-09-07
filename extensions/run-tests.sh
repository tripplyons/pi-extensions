#!/usr/bin/env bash
set -euo pipefail

extension_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
autoresearch_dir="$extension_dir/tripp-autoresearch"
failed=0

# Bun module mocks are process-global. Keep extension test files isolated.
while IFS= read -r test_file; do
	[[ "$test_file" == "$autoresearch_dir/tests/"* ]] && continue
	bun test --smol --only-failures "$test_file" || failed=1
done < <(find "$extension_dir" -type f \( -name '*.test.ts' -o -name '*.test.mjs' \) | sort)

bun test --smol --only-failures --preload "$autoresearch_dir/tests/preload.mjs" "$autoresearch_dir/tests" || failed=1
bash "$autoresearch_dir/tests/finalize_test.sh" || failed=1

if (( failed )); then
	printf '\nPi extension tests failed.\n' >&2
	exit 1
fi
printf '\nAll Pi extension tests passed.\n'
