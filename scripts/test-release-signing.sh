#!/usr/bin/env bash
# Local test harness for the Garasign release-signing workflow.
#
# Runs the real `run:` scripts extracted from .github/workflows/publish.yml and
# .github/actions/*/action.yml. Garasign and GitHub are replaced by fakes:
#   - fake `docker` enforces the Garasign doc rules (env-file credentials, no -e secrets,
#     garasign-gpg image, gpgloader before gpg, working dir mounted) and signs with a local
#     throwaway GPG key instead of the HSM
#   - fake `gh` records release calls instead of touching GitHub
# Nothing is published, uploaded or sent anywhere.
#
# Requires: bash, git, node/npm, jq, ruby, gpg, sha256sum. Optional: uvx (runs zizmor).
# Usage: scripts/test-release-signing.sh [work-dir] [gnupg-home]
# On macOS keep gnupg-home short (gpg-agent socket paths are limited to ~104 chars).
set -uo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=${1:-$(mktemp -d)}
export GNUPGHOME=${2:-$(mktemp -d)}
mkdir -p "$WORK" "$GNUPGHOME" && chmod 700 "$GNUPGHOME"
WF="$REPO/.github/workflows/publish.yml"
SETUP="$REPO/.github/actions/release-setup/action.yml"
SIGN="$REPO/.github/actions/sign-artifacts/action.yml"

pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass + 1)); }
ko() { echo "FAIL  $1"; fail=$((fail + 1)); }
check() {
  local desc=$1; shift
  if "$@" > "$WORK/last.log" 2>&1; then ok "$desc"; else ko "$desc"; tail -15 "$WORK/last.log" | sed 's/^/      /'; fi
}
expect_fail() {  # expect_fail <desc> <text the error output must contain> <cmd...>
  local desc=$1 pattern=$2; shift 2
  if "$@" > "$WORK/last.log" 2>&1; then ko "$desc (command succeeded, expected failure)"
  elif grep -q -- "$pattern" "$WORK/last.log"; then ok "$desc"
  else ko "$desc (failed without '$pattern')"; tail -10 "$WORK/last.log" | sed 's/^/      /'; fi
}
in_dir() { local dir=$1; shift; (cd "$dir" && "$@"); }
# Print the `run:` script of the step with the given name from a workflow or composite action.
step_run() {
  ruby -ryaml -e '
    d = YAML.load_file(ARGV[0])
    steps = d["runs"] ? d["runs"]["steps"] : d["jobs"].values.flat_map { |j| j["steps"] || [] }
    s = steps.find { |x| x["name"] == ARGV[1] } or abort("no step named #{ARGV[1]}")
    print s["run"]' "$1" "$2"
}

echo "== Setup (work dir: $WORK)"
SRC="$WORK/src"; rm -rf "$SRC"; mkdir -p "$SRC" "$WORK/bin"
rm -f "$WORK"/out-* "$WORK/summary.md"  # GITHUB_OUTPUT-style files are append-only
(cd "$REPO" && git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf -) | tar -xf - -C "$SRC"
step_run "$WF" "Pack tarball" > "$WORK/pack.sh" &&
step_run "$WF" "Checksum the signed tarball" > "$WORK/checksum.sh" &&
step_run "$WF" "Upload tarball, signature and checksums to the release" > "$WORK/attach.sh" &&
step_run "$SETUP" "Write Garasign env file" > "$WORK/envfile.sh" &&
step_run "$SIGN" "Create and verify detached signatures" > "$WORK/sign.sh" ||
  { echo "could not extract step scripts"; exit 1; }

cat > "$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
# Fake docker: enforce the Garasign doc rules, then run the command locally with gpg.
set -eu
echo "docker $*" >> "$FAKE_LOG"
[ "$1" = run ] || { echo "fake docker: unexpected subcommand $1" >&2; exit 1; }
shift
envfile="" image="" mounted=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rm) shift ;;
    --env-file=*) envfile="${1#--env-file=}"; shift ;;
    -v) [ "$2" = "$(pwd):$(pwd)" ] && mounted=1; shift 2 ;;
    -w) shift 2 ;;
    -e|-e*|--env|--env=*) echo "fake docker: environment passed on the command line" >&2; exit 1 ;;
    *) image="$1"; shift; break ;;
  esac
done
[ -s "$envfile" ] || { echo "fake docker: no --env-file with Garasign credentials" >&2; exit 1; }
grep -q '^GRS_CONFIG_USER1_USERNAME=.' "$envfile" && grep -q '^GRS_CONFIG_USER1_PASSWORD=.' "$envfile" \
  || { echo "fake docker: env file lacks GRS_CONFIG_USER1_* credentials" >&2; exit 1; }
[ -n "$mounted" ] || { echo "fake docker: working directory not mounted at the same path" >&2; exit 1; }
case "$image" in */release-infrastructure/garasign-gpg) ;; *) echo "fake docker: unexpected image $image" >&2; exit 1 ;; esac
[ "$1" = /bin/bash ] && [ "$2" = -c ] || { echo "fake docker: expected /bin/bash -c <script>" >&2; exit 1; }
script=$3; shift 3
before_gpg=${script%%gpg --*}
case "$before_gpg" in *gpgloader*) ;; *) echo "fake docker: gpgloader must run before gpg" >&2; exit 1 ;; esac
exec bash -c "gpgloader() { :; }; $script" "$@"
EOF
cat > "$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
# Fake gh: record calls; `release view` exits with $FAKE_GH_VIEW_EXIT (1 = release missing).
echo "gh $*" >> "$FAKE_LOG"
[ -n "${GH_TOKEN:-}" ] && [ -n "${GH_REPO:-}" ] || { echo "fake gh: GH_TOKEN/GH_REPO not set" >&2; exit 1; }
[ "$1 $2" = "release view" ] && exit "${FAKE_GH_VIEW_EXIT:-1}"
exit 0
EOF
chmod +x "$WORK/bin/docker" "$WORK/bin/gh"
export FAKE_LOG="$WORK/fake.log"; : > "$FAKE_LOG"

if ! gpg --list-secret-keys --with-colons 2>/dev/null | grep -q '^sec'; then
  gpg --batch --pinentry-mode loopback --passphrase '' \
    --quick-generate-key "Release Signing Test <test@example.invalid>" ed25519 sign never > /dev/null 2>&1
fi
FPR=$(gpg --list-secret-keys --with-colons 2>/dev/null | awk -F: '/^fpr/ { print $10; exit }')
if [ -n "$FPR" ]; then ok "throwaway GPG key ready ($FPR)"; else ko "could not create a test GPG key"; exit 1; fi
SHORT_ID=${FPR:${#FPR}-16}

echo "== Build job"
check "npm ci" in_dir "$SRC" npm ci --no-audit --no-fund
check "lint" in_dir "$SRC" npm run lint
check "unit tests" in_dir "$SRC" npm test
check "build" in_dir "$SRC" npm run build
VERSION=$(jq -r .version "$SRC/package.json")
expect_fail "pack refuses a tag that doesn't match package.json" "does not match" \
  in_dir "$SRC" env GITHUB_REF_TYPE=tag GITHUB_REF_NAME=v999.0.0 GITHUB_OUTPUT="$WORK/out-bad" bash -e "$WORK/pack.sh"
check "pack on matching tag v$VERSION" \
  in_dir "$SRC" env GITHUB_REF_TYPE=tag GITHUB_REF_NAME="v$VERSION" GITHUB_OUTPUT="$WORK/out-pack" bash -e "$WORK/pack.sh"
TARBALL=$(sed -n 's/^tarball=//p' "$WORK/out-pack" 2>/dev/null)
check "pack outputs tarball and version" bash -c "[ -n '$TARBALL' ] && [ -f '$SRC/dist-pack/$TARBALL' ] && grep -qx 'version=$VERSION' '$WORK/out-pack'"
check "tarball contains only dist/ and package docs" bash -c "
  tar -tzf '$SRC/dist-pack/$TARBALL' | sed 's|^package/||; s|/.*||' | sort -u | tr '\n' ' ' |
  grep -qx 'CHANGELOG.md LICENSE README.md dist package.json '"
# npm reads the tarball, then may refuse only because this version is already on the registry.
publish_dry_run() {
  local out; out=$(cd "$SRC" && npm publish "./dist-pack/$TARBALL" --dry-run --access public 2>&1) && return 0
  echo "$out"
  echo "$out" | grep -q "Tarball Details" && echo "$out" | grep -q "cannot publish over the previously published"
}
check "npm publish ./<tarball> --dry-run reads the tarball" publish_dry_run

echo "== release-setup: Garasign env file"
RT="$WORK/runner-temp"; rm -rf "$RT"; mkdir -p "$RT"; : > "$WORK/gh-env"
# Random stand-in credentials generated per run; the value includes $ and \ to test escaping.
FAKE_USER="test-user-$RANDOM$RANDOM"
FAKE_VALUE=$(printf 'fake-%s$%s\\%s' "$RANDOM" "$RANDOM" "$RANDOM")
printf '%s\n' "GRS_CONFIG_USER1_USERNAME=$FAKE_USER" "GRS_CONFIG_USER1_PASSWORD=$FAKE_VALUE" > "$WORK/expected-envfile"
check "writes env file from secret values" env GARASIGN_USERNAME="$FAKE_USER" GARASIGN_PASSWORD="$FAKE_VALUE" \
  RUNNER_TEMP="$RT" GITHUB_ENV="$WORK/gh-env" bash -e "$WORK/envfile.sh"
check "env file has exact GRS_CONFIG_USER1_* lines" diff "$WORK/expected-envfile" "$RT/garasign-envfile"
check "env file is private (mode 600)" bash -c "ls -l '$RT/garasign-envfile' | grep -q '^-rw-------'"
check "nothing written to GITHUB_ENV" bash -c "[ ! -s '$WORK/gh-env' ]"
expect_fail "fails when garasign-password is missing" "missing garasign-password" \
  env -u GARASIGN_PASSWORD GARASIGN_USERNAME="$FAKE_USER" RUNNER_TEMP="$WORK" bash -e "$WORK/envfile.sh"

echo "== sign-artifacts: Garasign signing (fake docker + local key)"
input_default() { ruby -ryaml -e 'print YAML.load_file(ARGV[0])["inputs"][ARGV[1]]["default"]' "$SIGN" "$1"; }
SIGNENV=(PATH="$WORK/bin:$PATH" RUNNER_TEMP="$RT"
  ECR_REGISTRY="$(input_default ecr_registry)" ECR_REPOSITORY="$(input_default ecr_repository)"
  GITHUB_OUTPUT="$WORK/out-sign" GITHUB_STEP_SUMMARY="$WORK/summary.md")
check "signs and verifies with expected key id" \
  in_dir "$SRC" env "${SIGNENV[@]}" GPG_KEY_ID="$FPR" ARTIFACT_PATH=dist-pack/ bash -e "$WORK/sign.sh"
check "armored detached signature written" bash -c "head -1 '$SRC/dist-pack/$TARBALL.sig' | grep -q 'BEGIN PGP SIGNATURE'"
check "independent gpg --verify passes" gpg --verify "$SRC/dist-pack/$TARBALL.sig" "$SRC/dist-pack/$TARBALL"
check "short key id (last 16 hex chars) also accepted" \
  in_dir "$SRC" env "${SIGNENV[@]}" GPG_KEY_ID="$SHORT_ID" ARTIFACT_PATH=dist-pack/ bash -e "$WORK/sign.sh"
check "works without gpg-key-id (verify only)" \
  in_dir "$SRC" env "${SIGNENV[@]}" GPG_KEY_ID= ARTIFACT_PATH=dist-pack/ bash -e "$WORK/sign.sh"
check "existing .sig files are not re-signed" bash -c "[ ! -e '$SRC/dist-pack/$TARBALL.sig.sig' ]"
check "step summary lists the signed tarball" grep -q "$TARBALL -> $TARBALL.sig" "$WORK/summary.md"
expect_fail "fails when signed by an unexpected key" "expected key" \
  in_dir "$SRC" env "${SIGNENV[@]}" GPG_KEY_ID=DEADBEEFDEADBEEF ARTIFACT_PATH=dist-pack/ bash -e "$WORK/sign.sh"
mkdir -p "$SRC/empty"
expect_fail "fails on an empty artifact directory" "No files found" \
  in_dir "$SRC" env "${SIGNENV[@]}" ARTIFACT_PATH=empty/ bash -e "$WORK/sign.sh"
mkdir -p "$WORK/empty-runner-temp"
expect_fail "fails if release-setup did not run" "run release-setup" \
  in_dir "$SRC" env "${SIGNENV[@]}" RUNNER_TEMP="$WORK/empty-runner-temp" ARTIFACT_PATH=dist-pack/ bash -e "$WORK/sign.sh"
cp "$SRC/dist-pack/$TARBALL" "$WORK/tampered.tgz" && printf 'x' >> "$WORK/tampered.tgz"
expect_fail "tampered tarball fails verification" "BAD signature" \
  gpg --verify "$SRC/dist-pack/$TARBALL.sig" "$WORK/tampered.tgz"
check "docker only ever ran the garasign-gpg image" \
  bash -c "! grep '^docker run' '$FAKE_LOG' | grep -v 'release-infrastructure/garasign-gpg'"
check "no credential values on any docker command line" \
  bash -c "! grep -F -e \"\$1\" -e \"\$2\" '$FAKE_LOG'" _ "$FAKE_USER" "$FAKE_VALUE"

echo "== attach-signatures"
check "checksum step" in_dir "$SRC" bash -e "$WORK/checksum.sh"
check "SHA256SUMS covers tarball and signature" \
  bash -c "cd '$SRC/dist-pack' && [ \$(wc -l < SHA256SUMS) -eq 2 ] && sha256sum -c SHA256SUMS"
: > "$FAKE_LOG"
check "release missing: creates it, then uploads" in_dir "$SRC" env PATH="$WORK/bin:$PATH" GH_TOKEN=x GH_REPO=o/r \
  RELEASE_TAG="v$VERSION" FAKE_GH_VIEW_EXIT=1 bash -e "$WORK/attach.sh"
check "create uses --verify-tag" grep -q "^gh release create v$VERSION --verify-tag" "$FAKE_LOG"
check "upload sends tarball, .sig and SHA256SUMS" grep -q \
  "^gh release upload v$VERSION --clobber dist-pack/$TARBALL dist-pack/$TARBALL.sig dist-pack/SHA256SUMS" "$FAKE_LOG"
: > "$FAKE_LOG"
check "release exists: uploads without creating" in_dir "$SRC" env PATH="$WORK/bin:$PATH" GH_TOKEN=x GH_REPO=o/r \
  RELEASE_TAG="v$VERSION" FAKE_GH_VIEW_EXIT=0 bash -e "$WORK/attach.sh"
check "no create call when release exists" bash -c "! grep -q 'release create' '$FAKE_LOG'"

echo "== Workflow structure"
check "job order build -> sign -> publish -> attach" ruby -ryaml -e '
  j = YAML.load_file(ARGV[0])["jobs"]
  exit(j["sign"]["needs"] == "build" && j["publish"]["needs"].include?("sign") &&
       j["attach-signatures"]["needs"].include?("publish") ? 0 : 1)' "$WF"
check "manual runs default to dry run and skip publish" ruby -ryaml -e '
  d = YAML.load_file(ARGV[0]); on = d["on"] || d[true]
  exit(on["workflow_dispatch"]["inputs"]["dry_run"]["default"] == true &&
       d["jobs"]["publish"]["if"].include?("inputs.dry_run") ? 0 : 1)' "$WF"
check "sign job uses the release-signing environment" ruby -ryaml -e '
  exit(YAML.load_file(ARGV[0])["jobs"]["sign"]["environment"] == "release-signing" ? 0 : 1)' "$WF"
if command -v uvx > /dev/null; then
  check "zizmor: no findings in signing workflow and actions" bash -c \
    "cd '$REPO' && uvx zizmor --format plain .github/workflows/publish.yml .github/actions | grep -q 'No findings'"
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
