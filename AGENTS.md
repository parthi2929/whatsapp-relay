# Agent Notes

## Credential and Windows Service Invariants

Preserve these invariants in every relay change and release:

1. Keep `personal`, `business-cbe`, and `business-irl` enabled and independently authenticated.
2. Keep authentication data local. Never commit `creds.json`, `creds.last-good.json`, account keys, stores, QR artifacts, logs, or copied session directories.
3. Use `robust-auth-state.mjs` for all Baileys multi-file authentication state.
4. Serialize credential writes. Write each file through a same-directory temporary file, flush it to disk, and rename it into place.
5. Validate `creds.json` before account startup. Restore a missing, empty, or invalid file from a valid `creds.last-good.json` copy.
6. Stop startup with a `credential_guard` error when a corrupt credential file has no valid backup.
7. Wait for the queued credential write before every QR helper exits. Stop its WhatsApp socket cleanly.
8. Claim global controller ownership before any account runtime starts. One persistent `controller-daemon.mjs` process owns all enabled accounts.
9. Reconnect a `connection_replaced` account after a short delay. A Windows restart can leave the previous WebSocket visible to WhatsApp for a few seconds.
10. Keep Windows logon startup hidden. The scheduled task runs a short health check every five minutes. The health check exits after it confirms or starts the manager.
11. Keep persistent PowerShell, command, VBS, and watchdog wrapper processes at zero. The controller daemon is the only persistent relay process.
12. Run `npm run check` and `npm test` after relay changes.
13. Run the disposable credential tests for missing, zero-byte, invalid-JSON, valid-backup, and unusable-backup cases.
14. Run the Windows verification script after service changes. Confirm the hidden scheduled task, one manager, all three accounts, valid credentials, and successful restart recovery.

The operating runbook is `docs/windows-silent-relay.md`. The test workflow must use disposable directories. It must preserve live account authentication.

## Release Workflow

Use this repo's release process every time a new version ships.

1. Work from `main`, not `master`.
2. Make sure the target changes are already merged into `main`.
3. Update `CHANGELOG.md` so `## [Unreleased]` contains the release notes you want to ship.
4. Run the deterministic release prep script with explicit inputs:
5. `npm run release:prepare -- --version X.Y.Z --date YYYY-MM-DD`
6. The script is the source of truth for release-managed file updates. It updates all of these together:
7. `CHANGELOG.md`
8. `package.json`
9. `package-lock.json`
10. `plugins/whatsapp-relay/.codex-plugin/plugin.json`
11. `README.md` release-pinned install tag references
12. Use `--dry-run` first if you want a no-write preview.
13. Review the diff after the script runs.
14. Run `npm run check`.
15. Run `npm test`.
16. If the release touches voice replies or local TTS routing, run a smoke test with `npm run whatsapp:tts:smoke`.
17. Commit the release preparation changes on `main`.
18. Push `main`.
19. Create and push an annotated git tag in the format `vX.Y.Z`.
20. Publish the GitHub release using the matching changelog entry as the release notes.

## Local Plugin Reinstall

When refreshing the locally installed Codex plugin after a release:

1. Reinstall from the release tag, not from a floating branch.
2. The Codex plugin cache lives under `$env:CODEX_HOME/plugins/cache/personal/whatsapp-relay/<version>`.
3. Publish and install releases from `https://github.com/parthi2929/codex-whatsapp-relay`.
4. Preserve `data/accounts.json`, `data/accounts/<account>/auth`, each account store, `data/controller-config.json`, and local aliases for all three required accounts.
5. Keep `controller-state.json` out of the migrated data because it can preserve stale process IDs.
6. Keep `controller-owner.json` out of the migrated data because it can preserve stale ownership.
7. Run `scripts/windows/install-silent-autostart.ps1` after the cache version changes.
8. Run `scripts/windows/verify-silent-autostart.ps1 -RestartTest` after installation.
9. Start a QR flow only for an account whose current and last-good credentials are both unusable.

## Notes

- The repo's primary branch is `main`.
- The maintained fork is `https://github.com/parthi2929/codex-whatsapp-relay`.
- The upstream repository is `https://github.com/abuiles/codex-whatsapp-relay`.
- Keep plugin metadata and README install instructions aligned with the maintained fork and its release tag.
- The README install prompt is part of the release surface and must be updated on every new release.
- The goal is that a fresh Codex install follows the latest tagged release by default.
