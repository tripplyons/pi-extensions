#!/usr/bin/env bash
set -euo pipefail

extension_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
autoresearch_dir="$extension_dir/tripp-autoresearch"
failed=0

# Bun module mocks are process-global. Keep files in isolated processes while
# running those processes concurrently. A stuck file is killed without holding
# the rest of the suite indefinitely.
test_files=()
serial_test_files=()
while IFS= read -r test_file; do
	[[ "$test_file" == "$autoresearch_dir/tests/"* ]] && continue
	# Bun's HTTP teardown can abort in the native allocator when this runtime
	# integration test overlaps another Bun test process.
	if [[ "$test_file" == "$extension_dir/pi-codex-conversion/role-runtime.test.ts" ]]; then
		serial_test_files+=("$test_file")
	else
		test_files+=("$test_file")
	fi
done < <(find "$extension_dir" -type f \( -name '*.test.ts' -o -name '*.test.mjs' \) | sort)
bun "$extension_dir/run-test-files.ts" "${test_files[@]}" || failed=1
PI_TEST_JOBS=1 bun "$extension_dir/run-test-files.ts" "${serial_test_files[@]}" || failed=1

bun test --smol --only-failures --preload "$autoresearch_dir/tests/preload.mjs" "$autoresearch_dir/tests" || failed=1
bash "$autoresearch_dir/tests/finalize_test.sh" || failed=1

if (( failed )); then
	printf '\nPi extension tests failed.\n' >&2
	exit 1
fi
printf '\nAll Pi extension tests passed.\n'
