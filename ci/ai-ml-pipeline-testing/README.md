# `ai-ml-pipeline-testing` integration

Files for MongoDB's [`ai-ml-pipeline-testing`](https://github.com/mongodb-labs/ai-ml-pipeline-testing)
Evergreen project. Copy `vercel-ai-memory-js/` to the root of that repository and add
the following to `.evergreen/config.yml`.

Under `tasks`:

```yaml
  - name: test-vercel-ai-memory-js-local
    tags: [local]
    commands:
      - func: "fetch repo"
      - func: "setup local atlas"
      - func: "execute tests"
      - command: attach.xunit_results
        params:
          file: src/vercel-ai-memory-js/vercel-ai-memory/results.xml
```

Under `buildvariants`:

```yaml
  - name: test-vercel-ai-memory-javascript-ubuntu
    display_name: Vercel AI Memory Ubuntu2204
    tags: [javascript]
    expansions:
      DIR: vercel-ai-memory-js
    run_on:
      - ubuntu2204-small
    tasks:
      - name: test-vercel-ai-memory-js-local
```

The suite runs against local Atlas (`mongodb/mongodb-atlas-local`). Atlas Automated
Embedding assertions are skipped unless Voyage AI is available to the deployment.

## Run locally

```bash
docker run -d --rm --name vam-atlas-local -p 27027:27017 mongodb/mongodb-atlas-local:latest
MONGODB_URI='mongodb://127.0.0.1:27027/?directConnection=true' npm run test:integration
```