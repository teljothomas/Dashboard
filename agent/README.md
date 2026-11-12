# TradeX Tally agent

Windows Service that connects the TradeX ERP to the TallyPrime on the Tally PC. Design: `docs/TALLY_INTEGRATION.md`
section 6. Contract: `docs/INTERFACES.md` section 5.

## Build and test (from this folder, .NET 10 SDK)

```
dotnet build TradeX.TallyAgent.sln
dotnet test --solution TradeX.TallyAgent.sln
dotnet publish src/TradeX.Agent.Service -c Release -o bin/publish
```

`global.json` pins the SDK and selects the Microsoft Testing Platform runner that `dotnet test --solution` needs.
If `TradeXAgent.exe` says ".NET location: Not found" on a PC with a user-level SDK install, set `DOTNET_ROOT`.

## Commands

```
TradeXAgent.exe register <code> [--cloud https://erp-host]   one time, elevated
TradeXAgent.exe status                                       lease, heartbeat, journal counts, last error
TradeXAgent.exe version
TradeXAgent.exe run                                          default; the service host runs this
```

Data lives in `%ProgramData%\TradeXAgent\` (override with `TRADEX_AGENT_HOME` for tests): `appsettings.json` (no
secrets), `agent.key` (DPAPI LocalMachine, restricted ACL), `identity.json`, `journal.db`, `logs\`.

## Deploy

`deploy/install.ps1`, `uninstall.ps1`, `upgrade.ps1`. Reviewed but not yet run on the Tally PC. They need the owner's
go-ahead and a Tally test company (Phase 05 gate G2). Production use needs the scripts signed (Phase 14).

## Tests

`tests/fixtures/signature-vector.json` is shared with `apps/api` (Node verifies the same canonical string and signature).
The journal crash test starts `tests/TradeX.Agent.JournalKillHelper`, kills it abruptly and reopens the journal.
