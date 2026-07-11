![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)
![Last Commit](https://img.shields.io/github/last-commit/gemivnet/flysheet)

# Flysheet

**A personal FOQA system for G3X-equipped experimental aircraft.**

Airlines run FOQA (Flight Operational Quality Assurance) programs: every flight's data gets analyzed against safety rules, and trends get caught before they become incidents. Flysheet is that, scaled down to one pilot and one RV-12. Drop your Garmin G3X SD-card logs in a folder; get flight phases, exceedance events, and long-term trends out.

No cloud, no subscription, no one else seeing your data. Your flying, your database, your Grafana dashboards.

---

## How it works

```
G3X SD card → watched ingest folder (Syncthing-friendly)
  → sha256 dedupe, raw file archived
  → CSV parser (tolerates torn rows, header drift, '---' nulls)
  → flight assembly (stitches log files split across power cycles)
  → phase detection (taxi / takeoff / climb / ... / rollout)
  → rules engine (YAML exceedance rules, per-phase gates)
  → TimescaleDB
  → web UI + Grafana
```

**Everything is config, not code.** Airframe constants live in `config/aircraft.yaml` (V-speeds, phase-detection thresholds). Exceedance rules live in `config/rules/*.yaml` and can reference those constants — `vne_exceed` compares IAS against `$aircraft.vspeeds.vne_kt`, so retuning a rule never means touching TypeScript. Rules are typed operators validated with zod, not expression strings, so there's no eval surface and a typo fails loudly at load time.

**The parser survives real-world logs.** G3X CSV headers drift across software versions (`GndSpd` vs `Gnd Spd` vs `GS`); `config/parameter-map.yaml` maps all known spellings to canonical parameters and preserves unmapped columns for later promotion. Torn last rows, duplicate timestamps, and `---` null tokens are all handled.

**Phase detection is deterministic and tested.** Two-pass algorithm: debounced per-sample predicates, then a transition table. Tests assert the invariants — phases are contiguous and cover the whole flight, a go-around never also counts as a landing, a touch-and-go produces rollout → takeoff.

## Example rules

From `config/rules/pilot.yaml`:

- **`unstable_500agl`** — crossing the 500 ft AGL gate on approach with speed outside Vref −5/+8, sink beyond 1000 fpm, or half-scale glidepath deviation
- **`landing_g`** — normal acceleration over 2.0 G in a window around touchdown
- **`vne_exceed`** — IAS above Vne (pulled from aircraft.yaml)

Engine-specific rules for the Rotax 912iS live in `config/rules/rotax912is.yaml`.

## Synthetic test data

Real flight logs never leave the pilot's machine, so `@foqa/g3x-synth` generates realistic G3X CSVs for testing:

```
npx g3x-synth --scenario all --seed 42 --garbage-rate 0.02
```

Scenarios: `pattern-work`, `normal-xc`, `go-around`, `power-interruption`, `unstable-approach`, `engine-exceedance`. Seeded PRNG, so fixtures are reproducible; `--garbage-rate` injects the kind of corruption real SD cards produce.

## Development

```bash
docker compose -f docker-compose.dev.yml up -d   # TimescaleDB :5432 + Grafana :3000
npm install
npm test                                          # vitest, spins up throwaway DBs
npm run dev:server                                # Express + pipeline on :8080
npm run dev:web                                   # Vite on :5173, proxies /api
```

Requires Node ≥ 22 and Docker.

## Status

Work in progress. What's real and tested today:

- ✅ G3X CSV parser
- ✅ Ingest watcher (sha256 dedupe, archive, cross-device moves)
- ✅ Flight assembly / log stitching
- ✅ Phase detection
- ✅ YAML rules engine
- ✅ Synthetic data generator
- ✅ TimescaleDB schema + migrations

Not yet wired up:

- 🚧 Server HTTP API + CLI (entrypoints are stubs)
- 🚧 Web UI (placeholder)
- 🚧 Grafana provisioning

## Packages

| Package | What it is |
| --- | --- |
| `@foqa/server` | Ingest pipeline, parser, phase detection, TimescaleDB storage |
| `@foqa/shared` | Canonical parameters, rules engine, aircraft config, units, geo |
| `@foqa/g3x-synth` | Synthetic G3X log generator for tests and demos |
| `@foqa/web` | React/Vite front end (early) |

## Privacy

This repo contains no flight data. `/data/` and generated fixtures are gitignored; the ingest pipeline is designed to keep raw logs on the machine that owns them.
