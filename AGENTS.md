# Repository Guidelines

## Project Structure & Module Organization

This repository contains a Vinext/Next.js GPS log visualizer. Application routes and React components live in `app/`: `/` renders `GpsLogExplorer.tsx`, while `/stats` renders `LogStatistics.tsx`. Shared styling is in `app/globals.css`. `scripts/ingest-gps.mjs` parses the source log and writes generated manifests, statistics, and per-session JSON under `public/data/`. Worker and hosting integration live in `worker/`, `build/`, and `.openai/`. Regression tests are in `tests/*.test.mjs`.

Treat `public/data/` as generated output; change it by rerunning ingestion, not by hand. The default raw input is `../GPSData000001.txt`, outside the Git repository.

## Build, Test, and Development Commands

- `npm ci`: install the locked dependency set (Node 22.13+).
- `npm run ingest -- ../GPSData000001.txt`: regenerate all parsed GPS data.
- `npm run dev`: start the local Vinext development server.
- `npm run typecheck`: run TypeScript without emitting files.
- `npm run lint`: check React, TypeScript, and project style rules with ESLint.
- `npm test`: run type checking, a production build, and all Node tests.
- `npm run build`: create the production worker bundle in `dist/`.

## Coding Style & Naming Conventions

Use TypeScript/TSX and ESM. Follow the existing style: two-space indentation, semicolons, double quotes, and trailing commas in multiline structures. Name React components and component files in `PascalCase` (`AppNav.tsx`); use `camelCase` for functions and variables; keep route directory names lowercase. Prefer small typed helpers over inline data transformations. Run `npm run lint` before submitting changes.

## Testing Guidelines

Tests use Node’s built-in `node:test` and strict assertions. Name new files `*.test.mjs` and place them in `tests/`. Add regression coverage for new routes, parser/schema changes, and generated statistics. Regenerate `public/data/` before testing ingestion changes, and update hard-coded fixture totals only when the source fixture intentionally changed. No formal coverage threshold is configured.

## Commit & Pull Request Guidelines

The repository has no commit history yet, so use concise Conventional Commit subjects such as `feat: add trip statistics` or `fix: preserve routes at low zoom`. Pull requests should explain the user-visible change, identify parser or generated-data impacts, and list validation performed. Include screenshots for UI changes and call out any intentional `public/data/` diff.

## Privacy & Configuration

GPS logs and videos contain sensitive location data. Do not add new raw logs, videos, credentials, or `.env` files. Review generated data before sharing. Keep external map URLs and timestamp assumptions documented when changing ingestion or map configuration.
