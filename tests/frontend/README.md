# Client tests

`npx vitest run` on its own exercises logic only: the outbox's write chains, the
two state layers, the path index, the sync loop's timing, and the half of edit
attribution that does not need a DOM. Nothing here needs a network, so it runs
anywhere in under a second.

The files are grouped by the package they belong to, because on each package's
own `main` branch that is where they go:

| Folder | Package |
|---|---|
| `core/` | `wsfs_core_suede` |
| `svelte/` | `wsfs_svelte_suede` |
| `python/` | `wsfs_python_suede` |
| `pytutor/` | `wsfs_pytutor_suede` |

`fake.ts` and `backend.ts` are core's harness and are shared from the root, the
way `conftest.py` is on the Python side.

## Pointed at a server, six more files wake up

    WSFS_BACKEND=http://localhost:8099 npx vitest run tests/frontend/core/live.test.ts

Those are the only tests that can tell whether the **generated types describe
what actually arrives** — everything else is a client reasoning about itself.
They skip rather than fail when there is no server, which is why a green run
with none proves less than it looks like it does. Run them after regenerating
any package's schema.

To bring a server up the way they expect:

    docker compose -f tests/compose.yml up -d test-db
    DB_HOST=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
      wsfs-mono-tests-test-db-1):5432 \
      PYTHONPATH="..:samples/backend" \
      python3 -c "import uvicorn; from app import create_sample_app; uvicorn.run(create_sample_app(), port=8099)"

## `performance.test.ts` measures rather than asserts

Thresholds on a shared machine make a flaky test; a recorded number makes a
comparison. It is only worth taking against a running stack.
