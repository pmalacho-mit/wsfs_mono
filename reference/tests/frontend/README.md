Client tests.

`npx vitest run` on its own exercises logic only: the outbox's write chains,
the two state layers, the path index, the sync loop's timing. Nothing here needs a
network, so it runs anywhere in under a second.

Point it at a server and six more files wake up:

    WSFS_BACKEND=http://localhost:8099 npx vitest run

Those are the only tests that can tell whether the generated types describe
what actually arrives -- everything else is this client reasoning about itself.
They skip rather than fail when there is no server.

`performance.test.ts` measures rather than asserts. Thresholds on a shared
machine make a flaky test; a recorded number makes a comparison:

    wsfs cost
      connect, empty workspace           0.2 ms      0.21 ms/run
      create x50                      1255.5 ms     25.11 ms/run
      connect, 50 entries               14.2 ms     14.21 ms/run
      index over 100 entries x200        0.4 ms      0.00 ms/run

To bring a server up the way these expect it:

    docker compose -f tests/compose.yml up -d test-db
    DB_HOST=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' wsfs-tests-test-db-1):5432 \
      PYTHONPATH="..:samples/backend" \
      python3 -c "import uvicorn; from app import create_sample_app; uvicorn.run(create_sample_app(), port=8099)"
