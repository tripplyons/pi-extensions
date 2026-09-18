#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Autoresearch's module mocks must not leak into the package integration tests.
files=()
while IFS= read -r file; do files+=("$file"); done < <(rg --files extensions tests -g '*.test.ts' -g '*.test.mjs' | grep -v '^extensions/tripp-autoresearch/tests/' | sort)
bun test "${files[@]}"
bun test --preload ./extensions/tripp-autoresearch/tests/preload.mjs ./extensions/tripp-autoresearch/tests
bash extensions/tripp-autoresearch/tests/finalize_test.sh
