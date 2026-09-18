# Windows silent relay runbook

This runbook keeps three WhatsApp accounts available after Windows logon:

- `personal`
- `business-cbe`
- `business-irl`

The design uses one persistent `controller-daemon.mjs` process. A hidden scheduled task runs a short health check at logon and every five minutes. Each health check exits after it confirms or starts the manager.

## Safety rules

- Keep every account session under the installed plugin `data/accounts/<account>/auth` directory.
- Keep credentials, stores, QR files, logs, and session backups out of Git.
- Stop the manager before an interactive QR relink.
- Keep one controller owner. The daemon claims ownership before it opens account sockets.
- Use `robust-auth-state.mjs` for every account. It validates current credentials, maintains `creds.last-good.json`, serializes writes, flushes temporary files, and renames them into place.
- Keep the scheduled task hidden. Keep persistent wrapper and watchdog processes at zero.

## Install or refresh the Windows service

Run PowerShell as the same Windows user that runs Codex:

```powershell
$env:CODEX_HOME = 'D:\Local AIPlayground\Codex\.codex'
& '.\scripts\windows\install-silent-autostart.ps1'
```

The installer copies the health-check files into `..\services\whatsapp-relay` relative to `CODEX_HOME`. It registers the hidden `Codex WhatsApp Relay` scheduled task with logon and five-minute triggers.

## Verify all accounts and restart recovery

The standard verification reads metadata and validates JSON structure. It never prints credential content.

```powershell
& '.\scripts\windows\verify-silent-autostart.ps1'
```

Use the restart test after service, controller, or credential-handling changes:

```powershell
& '.\scripts\windows\verify-silent-autostart.ps1' -RestartTest
```

The restart test stops the current controller through the relay process module. It starts the hidden task and requires one new manager PID within 30 seconds.

## Test credential corruption recovery

Run these tests from the repository root:

```powershell
npm run check
npm test
```

The credential tests use disposable temporary directories. They cover first authentication, atomic save, zero-byte recovery, invalid-JSON recovery, missing-file recovery, and refusal when both current and backup credentials are unusable.

## Release and installed-cache update

The Codex plugin cache is a generated installation. A plugin upgrade can replace direct cache edits. Commit the hardening in this repository and publish it through the normal release workflow.

1. Merge the tested change into `main`.
2. Prepare and publish a tagged release with the instructions in `AGENTS.md`.
3. Reinstall the plugin from that release tag.
4. Preserve `accounts.json`, each account auth directory and store, `controller-config.json`, and local aliases for all three accounts.
5. Exclude `controller-state.json` and `controller-owner.json` from migration.
6. Run the service installer again. It locates the newest complete plugin cache version.
7. Run the standard verification and the restart test.

The plugin manifest points to Parthi's GitHub fork. Keep that repository URL and the release tag aligned with the installed package source.
