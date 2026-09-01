# Changelog

`release/` is consumed as a git subrepo rather than by version, so breaking
changes are listed here rather than signalled by a version bump.

## Unreleased

### Breaking

- **`Environment["fs"]` is now a `HostFileSystem`.** Every method may return a
  promise; the worker stays blocked until it settles. Filesystems built with
  `Kernel.ReadWriteFileSystem` and friends need no changes.
- **`SyncFileSystem` requires `stat`.** A hand-written filesystem object must
  add it. Those built with the `fs.*` helpers get one derived from `get`, which
  reads the whole file — see the README on why you want a real one.
- **File contents are `string | Uint8Array`.** `get` may answer with either.
  What Python writes reaches `put` as a string when it is valid UTF-8 and as
  bytes when it is not, so text files stay text. Pass `binary: true` to always
  receive bytes.
- **`assetURL({ path })` returns a promise**, because it now reads through the
  filesystem. The `{ value, ... }` overloads are still synchronous.

### Added

- `indexURL` on `Environment`, for serving Pyodide from somewhere other than the
  jsDelivr CDN.
- Optional `stat` on the read side of the filesystem helpers.

### Fixed

- Binary files survive the bridge intact; text is decoded as UTF-8 end to end,
  including what Python prints to stdout.
- `os.path.getsize` reports bytes rather than characters, and reports what an
  open file holds rather than what was last stored.
- Reading a file no longer writes it back on close.
- A host filesystem that throws or rejects reaches Python as an `OSError`
  instead of hanging the worker.
- Disposing an idle kernel no longer throws.
- `Run.Job.interrupt()` interrupts the run it belongs to.
