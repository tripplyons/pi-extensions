#!/usr/bin/env bash
# Build a native, locally signed app bundle. No packaging dependencies needed.
set -euo pipefail

usage() {
    printf '%s\n' \
        'Usage: build-macos-app.sh [--install | --install-dir DIRECTORY]' \
        '' \
        'Build pi-desk/target/macos/pi-desk.app for this Mac.' \
        '--install                 Install in /Applications.' \
        '--install-dir DIRECTORY   Install in another directory (for example ~/Applications).' \
        '--help                    Show this help.'
}

die() { printf 'pi-desk: %s\n' "$*" >&2; exit 1; }
install_dir=''
while [[ $# -gt 0 ]]; do
    case "$1" in
        --install) install_dir='/Applications'; shift ;;
        --install-dir)
            [[ $# -ge 2 && -n "$2" && "$2" != -* ]] || die '--install-dir requires a directory.'
            install_dir="$2"; shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) usage >&2; die "Unknown argument: $1" ;;
    esac
done
[[ "$(uname -s)" == Darwin ]] || die 'App bundles can only be built on macOS.'
for tool in cargo rustc codesign plutil ditto; do
    command -v "$tool" >/dev/null 2>&1 || die "Required tool not found: $tool"
done

crate_dir="$(cd "$(dirname "$0")/.." && pwd)"
target_dir="$crate_dir/target"
bundle="$target_dir/macos/pi-desk.app"
bundle_id='com.tripplyons.pi-desk'
build_stage=''
publish_stage=''
publish_destination=''

# Keep the previous bundle until the replacement is in place. Restore it if a
# rename fails or a signal arrives between the two renames.
cleanup() {
    if [[ -n "$publish_stage" && -d "$publish_stage/previous.app" && ! -e "$publish_destination" && ! -L "$publish_destination" ]]; then
        if ! mv "$publish_stage/previous.app" "$publish_destination"; then
            printf 'pi-desk: Could not restore the previous app. It is preserved at %s\n' "$publish_stage/previous.app" >&2
            publish_stage=''
        fi
    fi
    if [[ -n "$publish_stage" ]]; then rm -rf "$publish_stage"; fi
    if [[ -n "$build_stage" ]]; then rm -rf "$build_stage"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

check_destination() {
    local destination="$1" identifier
    [[ ! -L "$destination" ]] || die "Refusing to replace a symlink: $destination"
    if [[ -e "$destination" ]]; then
        [[ -d "$destination" && ! -L "$destination/Contents" && -f "$destination/Contents/Info.plist" && ! -L "$destination/Contents/Info.plist" ]] \
            || die "Refusing to replace an unrelated file or directory: $destination"
        identifier="$(plutil -extract CFBundleIdentifier raw -o - "$destination/Contents/Info.plist")" \
            || die "Cannot identify the existing app: $destination"
        [[ "$identifier" == "$bundle_id" ]] || die "Refusing to replace an unrelated app: $destination"
    fi
}

publish_bundle() {
    local source="$1" destination="$2" parent
    parent="$(dirname "$destination")"
    check_destination "$destination"
    publish_destination="$destination"
    publish_stage="$(mktemp -d "$parent/.pi-desk-publish.XXXXXX")"
    ditto "$source" "$publish_stage/replacement.app"
    codesign --verify --strict "$publish_stage/replacement.app"
    if [[ -e "$destination" ]]; then mv "$destination" "$publish_stage/previous.app"; fi
    mv "$publish_stage/replacement.app" "$destination"
    rm -rf "$publish_stage"
    publish_stage=''
    publish_destination=''
}

check_destination "$bundle"
if [[ -n "$install_dir" ]]; then
    mkdir -p "$install_dir" || die "Cannot create $install_dir. No sudo is used; copy the built app with Finder instead."
    install_dir="$(cd "$install_dir" && pwd)"
    [[ -w "$install_dir" ]] || die "Cannot write to $install_dir. No sudo is used; copy the built app with Finder instead."
    check_destination "$install_dir/pi-desk.app"
    if [[ -e "$install_dir/pi-desk.app" ]]; then
        # Do not stop a user's process or replace an app while it is running.
        command -v pgrep >/dev/null 2>&1 || die 'Required tool not found: pgrep'
        if pgrep -x pi-desk >/dev/null; then
            die 'Quit pi-desk before replacing the installed app.'
        else
            status=$?
            [[ "$status" == 1 ]] || die 'Cannot check whether pi-desk is running.'
        fi
    fi
fi

host="$(rustc -vV | awk '/^host: / {print $2}')"
case "$host" in
    aarch64-apple-darwin|x86_64-apple-darwin) ;;
    *) die "Unsupported macOS host: $host" ;;
esac
# This repository uses a literal package version, not workspace inheritance.
version="$(awk -F '"' '/^\[package\]$/ {package=1; next} package && /^\[/ {exit} package && /^version = / {print $2; exit}' "$crate_dir/Cargo.toml")"
version="${version%%[-+]*}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'Cannot read the package version from Cargo.toml.'

cargo build --manifest-path "$crate_dir/Cargo.toml" --locked --release --target "$host" --target-dir "$target_dir"
binary="$target_dir/$host/release/pi-desk"
[[ -x "$binary" ]] || die "Cargo did not produce an executable at $binary"
mkdir -p "$target_dir/macos"
build_stage="$(mktemp -d "$target_dir/macos/.pi-desk-build.XXXXXX")"
app="$build_stage/pi-desk.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/pi-desk"
chmod 755 "$app/Contents/MacOS/pi-desk"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>$bundle_id</string>
    <key>CFBundleName</key>
    <string>pi-desk</string>
    <key>CFBundleDisplayName</key>
    <string>pi-desk</string>
    <key>CFBundleExecutable</key>
    <string>pi-desk</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$version</string>
    <key>CFBundleVersion</key>
    <string>$version</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
</dict>
</plist>
PLIST
plutil -lint "$app/Contents/Info.plist"
codesign --force --sign - "$app"
codesign --verify --strict "$app"
publish_bundle "$app" "$bundle"
printf 'Built: %s\n' "$bundle"
if [[ -n "$install_dir" ]]; then
    publish_bundle "$bundle" "$install_dir/pi-desk.app"
    printf 'Installed: %s\n' "$install_dir/pi-desk.app"
    printf 'Quit any other pi-desk instance before opening this app.\n'
fi
