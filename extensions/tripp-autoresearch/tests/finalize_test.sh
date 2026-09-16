#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT="$ROOT/skills/autoresearch-finalize/finalize.sh"
PASSED=0
FAILED=0

pass() { printf '✓ %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail_test() { printf '✗ %s\n%s\n' "$1" "$2" >&2; FAILED=$((FAILED + 1)); }
run_test() {
  local name="$1"
  if output=$( ( source "$SCRIPT"; "$name" ) 2>&1); then pass "${name#test_}"
  else fail_test "${name#test_}" "$output"
  fi
}
assert_contains() { [[ "$1" == *"$2"* ]] || { echo "Expected '$2' in: $1"; return 1; }; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || { echo "Did not expect '$2' in: $1"; return 1; }; }

mock_git() {
  printf '%s\n' "$*" >> "${GIT_LOG:?}"
  case "$1 ${2:-}" in
    "branch --show-current") printf '%s\n' "${MOCK_BRANCH-research}" ;;
    "rev-parse --verify") return "${MOCK_BRANCH_EXISTS:-1}" ;;
    "rev-parse "*) printf '%040d\n' 1 ;;
    "cat-file -t") printf 'commit\n' ;;
    "diff --name-only") printf '%b' "${MOCK_DIFF_NUL-src/a.ts\\0}" ;;
    "diff --quiet"|"diff --cached") return "${MOCK_DIRTY:-0}" ;;
    "diff-tree "*) printf '%b' "${MOCK_DIFF_TREE:-src/a.ts\\n}" ;;
    "ls-files --others") printf '%s' "${MOCK_UNTRACKED:-}" ;;
    "log -1") printf '%s\n' "${MOCK_LOG_MESSAGE:-Metric: 10 -> 9}" ;;
  esac
}

fixture_data() {
  DATA_DIR=$(mktemp -d)
  BASE=1111111111111111111111111111111111111111
  FINAL_TREE=2222222222222222222222222222222222222222
  GOAL=fixture
  TRUNK=main
  ORIG_BRANCH=research
  GROUP_COUNT=1
  printf 'Fixture title' > "$DATA_DIR/0.title"
  printf 'Metric: 10 -> 9' > "$DATA_DIR/0.body"
  printf '%s' "$FINAL_TREE" > "$DATA_DIR/0.last_commit"
  printf 'change' > "$DATA_DIR/0.slug"
  printf 'src/a.ts\n' > "$DATA_DIR/0.files"
  GIT_LOG="$DATA_DIR/git.log"; export GIT_LOG
  : > "$GIT_LOG"
}

test_no_args() {
  local output
  if output=$(bash "$SCRIPT" 2>&1); then return 1; fi
  assert_contains "$output" "Usage:"
}

test_malformed_json() {
  local dir output
  dir=$(mktemp -d); trap 'rm -rf "$dir"' RETURN
  printf '{bad' > "$dir/groups.json"
  if output=$(bash "$SCRIPT" "$dir/groups.json" 2>&1); then return 1; fi
  assert_contains "$output" "Failed to parse"
}

test_missing_groups_json() {
  local output
  if output=$(bash "$SCRIPT" "/tmp/pi-finalize-missing-$$.json" 2>&1); then return 1; fi
  assert_contains "$output" "not found"
}

test_parse_groups() {
  local dir
  dir=$(mktemp -d); trap 'rm -rf "$dir"' RETURN
  cat > "$dir/groups.json" <<'JSON'
{"base":"base-hash","final_tree":"final-hash","goal":"speed","groups":[{"title":"One","body":"Metric: 2 -> 1","last_commit":"last-hash","slug":"one"}]}
JSON
  parse_groups "$dir/groups.json"
  [[ "$BASE:$TRUNK:$FINAL_TREE:$GOAL:$GROUP_COUNT" == "base-hash:main:final-hash:speed:1" ]]
  [[ $(cat "$DATA_DIR/0.title") == One ]]
  cleanup_data
}

test_session_paths() {
  is_session_file ".auto/log.jsonl"
  is_session_file "nested/autoresearch.jsonl/history"
  ! is_session_file "src/auto.ts"
  ! is_session_file "notes/research.md"
}

test_detached_head() {
  fixture_data; trap cleanup_data RETURN
  MOCK_BRANCH=""; export MOCK_BRANCH
  git() { mock_git "$@"; }
  local output
  if output=$(assert_on_feature_branch 2>&1); then return 1; fi
  assert_contains "$output" "Detached HEAD"
}

test_on_trunk() {
  fixture_data; trap cleanup_data RETURN
  MOCK_BRANCH=main; export MOCK_BRANCH
  git() { mock_git "$@"; }
  local output
  if output=$(assert_on_feature_branch 2>&1); then return 1; fi
  assert_contains "$output" "On trunk"
}

test_commit_preflight() {
  fixture_data; trap cleanup_data RETURN
  git() { mock_git "$@"; }
  assert_commits_exist
  assert_contains "$(cat "$GIT_LOG")" "rev-parse $BASE"
  assert_contains "$(cat "$GIT_LOG")" "rev-parse $FINAL_TREE"
}

test_collect_files() {
  fixture_data; trap cleanup_data RETURN
  MOCK_DIFF_NUL='src/a.ts\0.auto/log.jsonl\0nested/autoresearch.jsonl/item\0src/b.ts\0'; export MOCK_DIFF_NUL
  git() { mock_git "$@"; }
  collect_group_files 0 "$BASE"
  local files; files=$(cat "$DATA_DIR/0.files")
  assert_contains "$files" "src/a.ts"
  assert_contains "$files" "src/b.ts"
  assert_not_contains "$files" ".auto"
  assert_not_contains "$files" "autoresearch.jsonl"
}

test_overlapping_files() {
  fixture_data; trap cleanup_data RETURN
  printf 'src/a.ts\n' > "$DATA_DIR/new"
  printf 'src/a.ts\n' > "$DATA_DIR/seen"
  local output
  if output=$(assert_no_overlapping_files "$DATA_DIR/new" "$DATA_DIR/seen" 2>&1); then return 1; fi
  assert_contains "$output" "multiple groups"
}

test_branch_collision() {
  fixture_data; trap cleanup_data RETURN
  MOCK_BRANCH_EXISTS=0; export MOCK_BRANCH_EXISTS
  git() { mock_git "$@"; }
  local output
  if output=$(assert_branch_available "autoresearch/fixture/01-change" 2>&1); then return 1; fi
  assert_contains "$output" "already exists"
}

test_clean_tree_skips_stash() {
  fixture_data; trap cleanup_data RETURN
  MOCK_DIRTY=0; MOCK_UNTRACKED=""; export MOCK_DIRTY MOCK_UNTRACKED
  git() { mock_git "$@"; }
  stash_if_dirty
  [[ "$STASHED" == false ]]
  assert_not_contains "$(cat "$GIT_LOG")" "stash -u"
}

test_dirty_tree_stashes() {
  fixture_data; trap cleanup_data RETURN
  MOCK_DIRTY=1; export MOCK_DIRTY
  git() { mock_git "$@"; }
  stash_if_dirty
  [[ "$STASHED" == true ]]
  assert_contains "$(cat "$GIT_LOG")" "stash -u"
}

test_create_group_branch() {
  fixture_data; trap cleanup_data RETURN
  git() { mock_git "$@"; }
  create_group_branch 0 >/dev/null
  [[ "${CREATED_BRANCHES[*]}" == "autoresearch/fixture/01-change" ]]
  local calls; calls=$(cat "$GIT_LOG")
  assert_contains "$calls" "checkout $BASE --quiet --detach"
  assert_contains "$calls" "checkout -b autoresearch/fixture/01-change"
  assert_contains "$calls" "checkout $FINAL_TREE -- src/a.ts"
  assert_contains "$calls" "commit -m Fixture title -m Metric: 10 -> 9"
}

test_skip_empty_group() {
  fixture_data; trap cleanup_data RETURN
  : > "$DATA_DIR/0.files"
  git() { mock_git "$@"; }
  create_group_branch 0 >/dev/null
  [[ "${GROUP_BRANCH[0]}" == skipped ]]
  [[ ${#CREATED_BRANCHES[@]} -eq 0 ]]
}

test_multiple_independent_groups() {
  fixture_data; trap cleanup_data RETURN
  GROUP_COUNT=3
  for i in 1 2; do
    printf 'Title %s' "$i" > "$DATA_DIR/$i.title"
    printf 'Metric: %s' "$i" > "$DATA_DIR/$i.body"
    printf '%040d' "$((i + 2))" > "$DATA_DIR/$i.last_commit"
    printf 'change-%s' "$i" > "$DATA_DIR/$i.slug"
    printf 'src/%s.ts\n' "$i" > "$DATA_DIR/$i.files"
  done
  git() { mock_git "$@"; }
  for i in 0 1 2; do create_group_branch "$i" >/dev/null; done
  [[ "${CREATED_BRANCHES[*]}" == "autoresearch/fixture/01-change autoresearch/fixture/02-change-1 autoresearch/fixture/03-change-2" ]]
  [[ $(grep -c "checkout $BASE --quiet --detach" "$GIT_LOG") -eq 3 ]]
}

test_summary_output() {
  fixture_data; trap cleanup_data RETURN
  GROUP_BRANCH[0]=autoresearch/fixture/01-change
  local output; output=$(print_summary)
  assert_contains "$output" "Fixture title"
  assert_contains "$output" "Metric: 10 -> 9"
  assert_contains "$output" "autoresearch/fixture/01-change"
  assert_contains "$output" "rm -r .auto"
}

test_union_verification() {
  fixture_data; trap cleanup_data RETURN
  CREATED_BRANCHES=(autoresearch/fixture/01-change)
  MOCK_DIFF_NUL=''; export MOCK_DIFF_NUL
  git() { mock_git "$@"; }
  verify_union_matches_original >/dev/null
  MOCK_DIFF_NUL='src/missing.ts\0'; export MOCK_DIFF_NUL
  # verify_union uses newline output for this query.
  git() { if [[ "$1 ${2:-}" == "diff --name-only" ]]; then printf 'src/missing.ts\n'; else mock_git "$@"; fi; }
  ! verify_union_matches_original >/dev/null
}

test_artifact_verification() {
  fixture_data; trap cleanup_data RETURN
  CREATED_BRANCHES=(autoresearch/fixture/01-change)
  MOCK_DIFF_TREE='src/a.ts\n'; export MOCK_DIFF_TREE
  git() { mock_git "$@"; }
  verify_no_session_artifacts >/dev/null
  MOCK_DIFF_TREE='.auto/log.jsonl\n'; export MOCK_DIFF_TREE
  ! verify_no_session_artifacts >/dev/null
}

test_empty_commit_verification() {
  fixture_data; trap cleanup_data RETURN
  CREATED_BRANCHES=(autoresearch/fixture/01-change)
  MOCK_DIFF_TREE=''; export MOCK_DIFF_TREE
  git() { mock_git "$@"; }
  ! verify_no_empty_commits >/dev/null
  MOCK_DIFF_TREE='src/a.ts\n'; export MOCK_DIFF_TREE
  verify_no_empty_commits >/dev/null
}

test_verify_failure_leaves_group_branches() {
  fixture_data
  local log="$DATA_DIR/../verify-git.log" output
  GIT_LOG="$log"; export GIT_LOG; : > "$GIT_LOG"
  CREATED_BRANCHES=(autoresearch/fixture/01-change)
  MOCK_DIFF_TREE='src/a.ts\n'; export MOCK_DIFF_TREE
  git() {
    if [[ "$1 ${2:-}" == "diff --name-only" && "$*" != *"-z"* ]]; then printf 'src/missing.ts\n'
    else mock_git "$@"
    fi
  }
  set +e
  output=$(verify_branches 2>&1)
  set -e
  assert_contains "$output" "Branches are intact"
  assert_not_contains "$(cat "$log")" "branch -D autoresearch/fixture/01-change"
  rm -f "$log"
  DATA_DIR=""
}

test_rollback() {
  fixture_data
  local log="$DATA_DIR/../rollback-git.log"
  GIT_LOG="$log"; export GIT_LOG; : > "$GIT_LOG"
  DATA_DIR=""
  CREATED_BRANCHES=(autoresearch/fixture/01-change autoresearch/fixture/02-more)
  STASHED=true
  git() { mock_git "$@"; }
  set +e
  ( false; rollback_on_failure >/dev/null )
  set -e
  local calls; calls=$(cat "$GIT_LOG")
  assert_contains "$calls" "branch -D autoresearch/fixture/01-change"
  assert_contains "$calls" "checkout research --quiet"
  assert_contains "$calls" "stash pop --quiet"
  rm -f "$log"
}

test_full_mocked_workflow() {
  local dir bin output
  dir=$(mktemp -d); trap 'rm -rf "$dir"' RETURN
  bin="$dir/bin"; mkdir "$bin"
  cat > "$bin/git" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GIT_LOG"
case "$1 ${2:-}" in
  "branch --show-current") echo research ;;
  "rev-parse --verify") exit 1 ;;
  "rev-parse "*) printf '%040d\n' 1 ;;
  "cat-file -t") echo commit ;;
  "diff --name-only")
    if [[ "$*" == *"-z"* ]]; then printf 'src/a.ts\0'; fi ;;
  "diff --quiet"|"diff --cached") exit 0 ;;
  "diff-tree "*) echo src/a.ts ;;
  "ls-files --others") ;;
  "log -1") echo 'Metric: 10 -> 9' ;;
esac
MOCK
  chmod +x "$bin/git"
  cat > "$dir/groups.json" <<'JSON'
{"base":"1111111111111111111111111111111111111111","trunk":"main","final_tree":"2222222222222222222222222222222222222222","goal":"fixture","groups":[{"title":"Fixture title","body":"Metric: 10 -> 9","last_commit":"2222222222222222222222222222222222222222","slug":"change"}]}
JSON
  : > "$dir/git.log"
  output=$(cd "$dir" && PATH="$bin:$PATH" GIT_LOG="$dir/git.log" bash "$SCRIPT" "$dir/groups.json")
  assert_contains "$output" "All checks passed"
  assert_contains "$output" "autoresearch/fixture/01-change"
  assert_contains "$(cat "$dir/git.log")" "checkout -b autoresearch/fixture/01-change"
}

printf '\nRunning finalize.sh mocked-boundary tests...\n\n'
for test_name in \
  test_no_args test_malformed_json test_missing_groups_json test_parse_groups test_session_paths test_detached_head \
  test_on_trunk test_commit_preflight test_collect_files test_overlapping_files test_branch_collision \
  test_clean_tree_skips_stash test_dirty_tree_stashes test_create_group_branch test_skip_empty_group \
  test_multiple_independent_groups test_summary_output test_union_verification test_artifact_verification \
  test_empty_commit_verification test_verify_failure_leaves_group_branches test_rollback test_full_mocked_workflow; do
  run_test "$test_name"
done

printf '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
printf 'Tests: %d  Passed: %d  Failed: %d\n' "$((PASSED + FAILED))" "$PASSED" "$FAILED"
printf '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
(( FAILED == 0 ))
