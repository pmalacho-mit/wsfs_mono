> [!NOTE]
> This is a [suede](https://github.com/pmalacho-mit/suede) dependency.

# wsfs-core-suede

**The distributed filesystem, and nothing else.** Server authority, client
sync, and the collaboration plane that makes text files shared documents.
Nothing here renders, nothing talks to a model, and nothing knows what Python
is.

The test for whether something belongs in this package: *could the spec's
filesystem be satisfied without it?* If yes, it is not core.

## What is here that might surprise you

- **Rooms.** A text file in a wsfs workspace *is* a shared document, and the
  seeding rule, the `base` bookkeeping and "only the host carries text into a
  room" are filesystem behaviour rather than UI. What core must not do is
  require a *vendor* — see below.
- **Clone and place.** Both go through `service.adjudicate` and the same choke
  point, so a clone reaches the target's stream as a run of ordinary create
  events and every rule about names, nesting and CAS applies unchanged. A
  downstream package doing this would need `Submission`, `approve` and
  `Positions` — a second write path, which is the one thing the design refuses.
- **Snapshots and executions.** Members of the closed `Submitted` union that
  travel through the outbox. Pulling them out is a wire-protocol change.

## The collaboration seam

`backend/collaboration/` defines `ICollaboration` — three methods — and ships
**two** implementations, neither privileged:

- `InProcessCollaboration`, rooms held in this process over `pycrdt`. The
  default, and what the suite runs against: no key, no network.
- `Liveblocks`, the hosted service over plain HTTP.

The client side mirrors it: `frontend/room.ts` declares `Provider`, `Enter`,
`Host` and `Persist` with no vendor named, and `frontend/collaboration/` holds
the neutral wiring plus one adapter module per service.

**`index.ts` re-exports no vendor's client.** A consumer importing one from
here would have taken a dependency nobody declared, and the import audit fails
the build over it.

## Two audiences, two exports

**To a satellite package** — `Backend`, `Authorize`, `build_models`, `Models`,
plus the reads it genuinely needs (`reconstruct.reconstructed`, `records`,
`Text`, `minted_at`, and the shared wire vocabulary). A satellite builds its own
tables against `Models`, its own router against `Backend` + `Authorize`, and
mounts both. It never sees `Mounted`, and it never reaches past these into
`service` or `tree`.

**To an application** — `create_router(...)` returns `Mounted`: the router, and
the work behind every route for a host that is also a consumer. `clone` and
`place` are there and are not routes, because a clone's permission question
spans two workspaces and `place`'s destructive half is a thing a host may mean
and a browser may not.

## Reading it

[GUIDE.md](./GUIDE.md) walks the files in the order they make sense in.

## Testing

See [TESTING.md](./TESTING.md). The headline check is `pytest` green with no
`LIVEBLOCKS_SECRET_KEY` and no network.

**Setting the suite up in this repo's own `main` branch?**
[HANDOFF.md](./HANDOFF.md) is written for that: what to port, what needs a
consumer app, and the traps that cost time the first time round.
