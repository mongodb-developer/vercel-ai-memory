#!/bin/bash
# run.sh for mongodb-labs/ai-ml-pipeline-testing (DIR: vercel-ai-memory-js).
# Executed by .evergreen/execute-tests.sh from inside the cloned repo.
set -o errexit

SCRIPT_DIR=$(realpath "$(dirname "${BASH_SOURCE[0]}")")
ROOT_DIR=$(dirname "$SCRIPT_DIR")

# Provides MONGODB_URI (local Atlas or remote, per the setup step).
# shellcheck disable=SC1091
. "$ROOT_DIR/env.sh"

PATH=/opt/devtools/node22/bin:$PATH
export PATH

npm ci
npm run lint
npm run build
npm test
npm run test:integration -- --reporter=default --reporter=junit --outputFile=./results.xml