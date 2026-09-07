#!/usr/bin/env bash

set -euo pipefail

extension_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
autoresearch_dir="$extension_dir/tripp-autoresearch"
autoresearch_finalize_test="$autoresearch_dir/tests/finalize_test.sh"
agent_swarm_test="$extension_dir/agent-swarm/index.test.ts"
bg_bash_test="$extension_dir/bg-bash/index.test.ts"
agent_swarm_tui_test="$extension_dir/agent-swarm/tui.integration.test.ts"
output_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-extension-tests.XXXXXX")
trap 'rm -rf "$output_dir"' EXIT

labels=()
logs=()
pids=()

run_group() {
	local label=$1
	local log=$2
	shift 2

	labels+=("$label")
	logs+=("$log")
	(
		printf '\n==> %s\n' "$label"
		"$@"
	) >"$log" 2>&1 &
	pids+=("$!")
}

test_files=()
while IFS= read -r test_file; do
	if [[ "$test_file" == "$autoresearch_dir/tests/"* || "$test_file" == "$agent_swarm_test" || "$test_file" == "$agent_swarm_tui_test" || "$test_file" == "$bg_bash_test" ]]; then
		continue
	fi
	test_files+=("$test_file")
done < <(find "$extension_dir" -type f \( -name '*.test.ts' -o -name '*.test.mjs' \) | sort)

group=0

# NOTE: each extension test file runs in its own `bun test` process.
# mock.module() registrations are process-global in Bun: the first mock
# instantiated for a specifier sticks, so files that mock the same pi
# package with different keys (e.g. pi-tui with and without sliceByColumn)
# break each other when they share a process.
run_extension_files() {
	local failed=0
	for test_file in "${test_files[@]}"; do
		if ! bun test --smol --only-failures "$test_file"; then
			failed=1
		fi
	done
	return $failed
}
run_group \
	"extension tests" \
	"$output_dir/$group.log" \
	run_extension_files
((group += 1))

for pattern in 'real Pi /swarm:tree TUI smoke' 'real Pi root session resume reconnects its swarm'; do
	run_group \
		"agent-swarm TUI integration tests $group" \
		"$output_dir/$group.log" \
		bun test --smol --only-failures --test-name-pattern "$pattern" "$agent_swarm_tui_test"
	((group += 1))
done

slow_bg_bash_tests='(?:sleep ignores foreign exits|backgrounded jobs are shared|closes its tmux session|keeps refresh read-only|survives extension shutdown|executes commands with zsh|requires all scope|persists stdin closure)'
run_group \
	"bg-bash unit tests" \
	"$output_dir/$group.log" \
	bun test --smol --only-failures --test-name-pattern "^(?!.*$slow_bg_bash_tests).*$" "$bg_bash_test"
((group += 1))

bg_bash_patterns=(
	'sleep ignores foreign exits'
	'backgrounded jobs are shared|closes its tmux session|keeps refresh read-only'
	'survives extension shutdown|executes commands with zsh|requires all scope|persists stdin closure'
)
for pattern in "${bg_bash_patterns[@]}"; do
	run_group \
		"bg-bash integration tests $group" \
		"$output_dir/$group.log" \
		bun test --smol --only-failures --test-name-pattern "$pattern" "$bg_bash_test"
	((group += 1))
done

slow_agent_swarm_tests='(?:propagates root trust|reconnects a resumed root session|creates a child worktree|restarts failed and stopped workers|normalizes commit dirty modes|refuses to clear a dirty worktree|cleans every eligible terminal worktree|resumes by relaunching a dead running worker)'
run_group \
	"agent-swarm unit tests" \
	"$output_dir/$group.log" \
	bun test --smol --only-failures --test-name-pattern "^(?!.*$slow_agent_swarm_tests).*$" "$agent_swarm_test"
((group += 1))

agent_swarm_patterns=(
	'propagates root trust|reconnects a resumed root session'
	'creates a child worktree|restarts failed and stopped workers'
	'normalizes commit dirty modes|refuses to clear a dirty worktree'
	'cleans every eligible terminal worktree|resumes by relaunching a dead running worker'
)
for pattern in "${agent_swarm_patterns[@]}"; do
	run_group \
		"agent-swarm integration tests $group" \
		"$output_dir/$group.log" \
		bun test --smol --only-failures --test-name-pattern "$pattern" "$agent_swarm_test"
	((group += 1))
done

run_group \
	"tripp-autoresearch/tests" \
	"$output_dir/$group.log" \
	bun test --smol --only-failures --preload "$autoresearch_dir/tests/preload.mjs" "$autoresearch_dir/tests"
((group += 1))
run_group \
	"tripp-autoresearch/tests/finalize_test.sh" \
	"$output_dir/$group.log" \
	bash "$autoresearch_finalize_test"

failures=()
for index in "${!pids[@]}"; do
	if ! wait "${pids[index]}"; then
		failures+=("${labels[index]}")
	fi
	cat "${logs[index]}"
done

if (( ${#failures[@]} > 0 )); then
	printf '\nFailed test groups:\n' >&2
	printf '  %s\n' "${failures[@]}" >&2
	exit 1
fi

printf '\nAll Pi extension tests passed.\n'
