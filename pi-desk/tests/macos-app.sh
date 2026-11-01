#!/usr/bin/env bash
# Exercise the public installer with fake external build/signing boundaries.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fixture="$tmp/source tree/pi-desk"
tools="$tmp/tools"
mkdir -p "$fixture/scripts" "$tools"
cp "$root/scripts/build-macos-app.sh" "$fixture/scripts/"
printf '[package]\nname = "pi-desk"\nversion = "0.1.0"\n' > "$fixture/Cargo.toml"
script="$fixture/scripts/build-macos-app.sh"
export TOOL_LOG="$tmp/tool-log"
export PATH="$tools:$PATH"

cat > "$tools/uname" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "${FAKE_OS:-Darwin}"
MOCK
cat > "$tools/rustc" <<'MOCK'
#!/usr/bin/env bash
printf 'host: aarch64-apple-darwin\n'
MOCK
cat > "$tools/cargo" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'cargo %s\n' "$*" >> "$TOOL_LOG"
[[ "${FAIL_BUILD:-0}" != 1 ]] || exit 1
target_dir=''; target=''
while [[ $# -gt 0 ]]; do
    case "$1" in
        --target-dir) target_dir="$2"; shift 2 ;;
        --target) target="$2"; shift 2 ;;
        *) shift ;;
    esac
done
[[ -n "$target_dir" && "$target" == aarch64-apple-darwin ]]
mkdir -p "$target_dir/$target/release"
printf '#!/bin/sh\nprintf "%%s\\n" "%s"\n' "${FAKE_BINARY:-first}" > "$target_dir/$target/release/pi-desk"
chmod +x "$target_dir/$target/release/pi-desk"
MOCK
cat > "$tools/plutil" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
    -lint) grep -q '<plist version="1.0">' "$2" ;;
    -extract)
        [[ "$2" == CFBundleIdentifier && "$3" == raw && "$4" == -o && "$5" == - ]]
        awk '/<key>CFBundleIdentifier<\/key>/ {getline; gsub(/^[[:space:]]*<string>|<\/string>[[:space:]]*$/, ""); print; exit}' "$6"
        ;;
    *) exit 1 ;;
esac
MOCK
cat > "$tools/codesign" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'codesign %s\n' "$*" >> "$TOOL_LOG"
[[ "${FAIL_SIGN:-0}" != 1 ]] || exit 1
app="${!#}"
[[ -x "$app/Contents/MacOS/pi-desk" && -f "$app/Contents/Info.plist" ]]
MOCK
cat > "$tools/ditto" <<'MOCK'
#!/usr/bin/env bash
exec cp -R "$1" "$2"
MOCK
cat > "$tools/pgrep" <<'MOCK'
#!/usr/bin/env bash
[[ "${FAKE_RUNNING:-0}" == 1 ]]
MOCK
cat > "$tools/mv" <<'MOCK'
#!/usr/bin/env bash
if [[ "${FAIL_INSTALL_MOVE:-0}" == 1 && "$1" == */replacement.app && "$2" == "$EXPECTED_INSTALL_DEST" ]]; then
    exit 1
fi
exec /bin/mv "$@"
MOCK
chmod +x "$tools/"*

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect_failure() {
    if "$@" > "$tmp/error" 2>&1; then fail "Expected failure: $*"; fi
}
run() { bash "$script" "$@" > "$tmp/output" 2>&1 || { more_output="$(<"$tmp/output")"; fail "$more_output"; }; }

# Help works without a Mac or a toolchain. Invalid arguments fail explicitly.
FAKE_OS=Linux run --help
expect_failure bash "$script" --unknown
expect_failure bash "$script" --install-dir
expect_failure env FAKE_OS=Linux bash "$script"
grep -q 'only be built on macOS' "$tmp/error"

# Build from outside the source directory, including paths with spaces.
cd "$tmp"
run
bundle="$fixture/target/macos/pi-desk.app"
[[ "$("$bundle/Contents/MacOS/pi-desk")" == first ]] || fail 'Missing bundle executable'
grep -q '<string>com.tripplyons.pi-desk</string>' "$bundle/Contents/Info.plist"
grep -q '<string>0.1.0</string>' "$bundle/Contents/Info.plist"
grep -q 'cargo .*--locked --release --target aarch64-apple-darwin' "$TOOL_LOG"
grep -q 'codesign --force --sign - ' "$TOOL_LOG"
grep -q 'codesign --verify --strict ' "$TOOL_LOG"

# Install and replace an owned bundle. No real /Applications writes occur here.
apps="$tmp/Applications with spaces"
run --install-dir "$apps"
installed="$apps/pi-desk.app/Contents/MacOS/pi-desk"
[[ "$("$installed")" == first ]] || fail 'Installation failed'
FAKE_BINARY=second run --install-dir "$apps"
[[ "$("$installed")" == second ]] || fail 'Replacement failed'

# A failed build or signing attempt must not damage the existing installation.
expect_failure env FAIL_BUILD=1 bash "$script" --install-dir "$apps"
[[ "$("$installed")" == second ]] || fail 'Build failure damaged installed app'
expect_failure env FAIL_SIGN=1 bash "$script" --install-dir "$apps"
[[ "$("$installed")" == second ]] || fail 'Signing failure damaged installed app'

# Refuse a running app without trying to stop it.
expect_failure env FAKE_RUNNING=1 bash "$script" --install-dir "$apps"
grep -q 'Quit pi-desk' "$tmp/error"
[[ "$("$installed")" == second ]] || fail 'Running app was changed'

# Restore the previous app if the last installation rename fails.
expect_failure env FAIL_INSTALL_MOVE=1 EXPECTED_INSTALL_DEST="$apps/pi-desk.app" FAKE_BINARY=third bash "$script" --install-dir "$apps"
[[ "$("$installed")" == second ]] || fail 'Previous app was not restored'

# Never replace another app, a plain directory, a file, or a symlink.
foreign="$tmp/Foreign apps"
mkdir -p "$foreign/pi-desk.app/Contents"
printf '<key>CFBundleIdentifier</key>\n<string>com.example.other</string>\n' > "$foreign/pi-desk.app/Contents/Info.plist"
printf 'keep' > "$foreign/pi-desk.app/marker"
expect_failure bash "$script" --install-dir "$foreign"
grep -q 'unrelated app' "$tmp/error"
[[ "$(<"$foreign/pi-desk.app/marker")" == keep ]] || fail 'Unrelated bundle was changed'
plain="$tmp/Plain apps"
mkdir -p "$plain/pi-desk.app"
expect_failure bash "$script" --install-dir "$plain"
rmdir "$plain/pi-desk.app"
printf 'keep' > "$plain/pi-desk.app"
expect_failure bash "$script" --install-dir "$plain"
[[ "$(<"$plain/pi-desk.app")" == keep ]] || fail 'Unrelated file was changed'
links="$tmp/Linked apps"
mkdir -p "$links"
ln -s "$foreign/pi-desk.app" "$links/pi-desk.app"
expect_failure bash "$script" --install-dir "$links"
[[ -L "$links/pi-desk.app" ]] || fail 'Destination symlink was removed'
[[ "$(<"$foreign/pi-desk.app/marker")" == keep ]] || fail 'Symlink target was changed'

# Private staging directories must not remain after success or handled failures.
[[ -z "$(find "$fixture/target/macos" "$apps" -name '.pi-desk-*' -print)" ]] || fail 'Leaked staging directory'
printf 'macOS app packaging tests passed\n'
