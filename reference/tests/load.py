"""What this backend does with 200 clients connected at once.

    CLIENTS=200 WORKSPACES=20 WRITERS=20 python tests/load.py

Not part of the suite -- it needs a running stack and it measures rather than
asserts. Kept because the numbers in AUDIT.md are only worth anything if
somebody can take them again.


Every client holds a stream open, which is what a browser with the app open
does. A subset of them type. The number that matters is what a save costs
while all of that is going on.
"""
import asyncio, json, os, secrets, statistics, time
from uuid import UUID
import httpx

BASE = "http://localhost:8099"
CLIENTS = int(os.environ.get("CLIENTS", "200"))
WORKSPACES = int(os.environ.get("WORKSPACES", "20"))
WRITERS = int(os.environ.get("WRITERS", "20"))
WRITES = int(os.environ.get("WRITES", "10"))

def uuid7() -> str:
    ms = int(time.time() * 1000)
    return str(UUID(int=(ms << 80) | (7 << 76) | (secrets.randbits(12) << 64)
                       | (0b10 << 62) | secrets.randbits(62)))

def user(n: int) -> dict[str, str]:
    return {"X-User-Email": f"load{n}@example.com"}

async def main() -> None:
    limits = httpx.Limits(max_connections=CLIENTS + 40, max_keepalive_connections=CLIENTS + 40)
    async with httpx.AsyncClient(timeout=120, limits=limits) as c:
        spaces = []
        for n in range(WORKSPACES):
            ws = (await c.post(f"{BASE}/projects", headers=user(n))).json()["id"]
            entry, txn = uuid7(), uuid7()
            await c.post(f"{BASE}/wsfs/workspaces/{ws}/initialize", json={"outbox": []}, headers=user(n))
            await c.post(f"{BASE}/wsfs/workspaces/{ws}/transactions", headers=user(n),
                json={"op": "create", "transaction": txn, "id": entry, "type": "file",
                      "name": "load.py", "parent": None,
                      "content": {"type": "text", "content": "start\n"}})
            spaces.append((ws, entry, txn))

        alive = asyncio.Event()
        streams, opened = [], 0
        async def follow(ws: str, who: int) -> None:
            nonlocal opened
            init = (await c.post(f"{BASE}/wsfs/workspaces/{ws}/initialize",
                                 json={"outbox": []}, headers=user(who))).json()
            async with c.stream("GET", f"{BASE}/wsfs/workspaces/{ws}/stream",
                                params={"token": init["token"]}) as r:
                opened += 1
                async for _ in r.aiter_lines():
                    if alive.is_set():
                        return

        started = time.time()
        for n in range(CLIENTS):
            ws, _, _ = spaces[n % WORKSPACES]
            streams.append(asyncio.create_task(follow(ws, n)))
        while opened < CLIENTS and time.time() - started < 90:
            await asyncio.sleep(0.1)
        print(f"streams open: {opened}/{CLIENTS} in {time.time() - started:.1f}s")

        latencies: list[float] = []
        async def typing(at: int) -> None:
            ws, entry, txn = spaces[at % WORKSPACES]
            against = txn
            for step in range(WRITES):
                one = uuid7()
                began = time.time()
                r = await c.post(f"{BASE}/wsfs/workspaces/{ws}/transactions", headers=user(at),
                    json={"op": "write", "transaction": one, "id": entry,
                          "content_version": against,
                          "content": {"type": "text", "content": f"start\nline {at}.{step}\n"}})
                latencies.append((time.time() - began) * 1000)
                if r.status_code == 200 and not r.json().get("rejected"):
                    against = one
                await asyncio.sleep(0.5)

        await asyncio.gather(*(typing(n) for n in range(WRITERS)))
        alive.set()
        for task in streams:
            task.cancel()

        latencies.sort()
        def at(p: float) -> float:
            return latencies[min(len(latencies) - 1, int(len(latencies) * p))]
        print(f"writes: {len(latencies)} across {WRITERS} writers in {WORKSPACES} workspaces")
        print(f"  p50 {at(0.5):.0f}ms   p95 {at(0.95):.0f}ms   p99 {at(0.99):.0f}ms   max {latencies[-1]:.0f}ms")
        print(f"  mean {statistics.mean(latencies):.0f}ms")

if __name__ == "__main__":
    # Collected by pytest along with everything else under `tests`, and it is
    # not a test: it needs a running stack and it measures rather than
    # asserts. Guarded so collection imports it and nothing happens.
    asyncio.run(main())
