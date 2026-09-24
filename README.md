<p align="center">
  <img src="./public/inkstone-logo.svg" width="112" height="112" alt="Inkstone project logo" />
</p>

<h1 align="center">Inkstone</h1>

<p align="center">
  A self-hosted Markdown notebook for writing, organizing, syncing, and backing up personal knowledge.
</p>

<p align="center">
  <a href="./README_ZH.md">中文</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a> ·
  <a href="./LICENSE">LGPL-3.0-only</a> ·
  <a href="https://inkstone-demo.pages.dev/">Demo</a>
</p>

## About

Inkstone is a browser-based notebook that runs on Cloudflare Workers. Notes always remain plain Markdown text; on top of that foundation, the application provides focused writing, live preview, lexical and optional semantic search, bidirectional links, offline editing, multi-device synchronization, private AI access, public sharing, and off-site backups.

It is a complete self-hosted application. The deployer retains control of the database, attachments, and runtime environment.

Every new account automatically receives two standard starter notes, one in Chinese and one in English. The browser-only demo reuses the same note content; refreshing the page restores these two starter notes instead of loading a separate set of demo data.

## Features

| Area | Included |
| --- | --- |
| Writing | CodeMirror 6 editor, independently editable note titles, **two-note editor groups**, per-group editor/split/preview layouts, synchronized scrolling, outline, **focus mode**, **typewriter mode**, **autosave**, and **version history** |
| Markdown | GFM tables and task lists, footnotes, Obsidian-style comments, WikiLinks, embeds, block IDs, callouts, details blocks, tabs, **math**, **Mermaid diagrams**, **PrismJS syntax highlighting**, and **Front Matter** |
| Organization | Nested folders with drag-and-drop ordering, inline tags, favorites, pinning, archive, trash, **wiki links**, backlinks, block references, note embeds, and a relationship graph |
| Search | D1 FTS5 **full-text search** with Chinese indexing, filters, recent notes, command-palette navigation, and optional private **semantic/hybrid search** powered by Workers AI |
| **MCP** | Private remote MCP, OAuth 2.1 with PKCE, revocable `ink_...` API keys, standard `search`/`fetch`, bounded reads, revision-safe writes, separate trash permission, and per-account grant management |
| Reliability | Installable PWA, offline app launch, browser-side cache, **offline write queue and optimistic concurrency control**, immediate local mutations with rollback, stale-sync protection, conflict copies, realtime notifications, and elected-tab polling fallback |
| Sharing | Public note links with optional access passwords and expiration dates |
| Portability | JSON and ZIP exports, directly readable **Markdown**, attachment export, and **manual or scheduled WebDAV/S3 backups** |
| Interface | **Desktop and mobile layouts**, **dark/light themes**, accent colors, Simplified Chinese, English, and owner-only update notifications |

## Data storage

| Component | Purpose |
| --- | --- |
| Cloudflare D1 | Accounts, notes, folders, tags, settings, versions, shares, lexical indexes, per-account AI embeddings, and background indexing queues |
| Cloudflare R2 or Workers KV | Attachment and uploaded-avatar binaries through the `FILES` or `FILES_KV` binding |
| Workers KV `OAUTH_KV` | OAuth client registrations, authorization codes, access and refresh tokens, and grants; note bodies are not stored here |
| Workers AI `AI` binding | Optional embedding generation for semantic search; unavailable deployments continue to use lexical search |
| Browser IndexedDB | Local cache and pending offline writes |
| `SyncHub` Durable Object | Realtime change notifications between active clients |
| `CredentialVault` Durable Object | Isolated storage for the key used to encrypt backup credentials |
| WebDAV or S3 storage | User-configured off-site backups |

## Environment variables

The following variables can be set in `wrangler.toml` under `[vars]`, or overridden in the Cloudflare Dashboard under **Settings → Variables and Secrets**. Dashboard values always take precedence over `wrangler.toml`.

| Variable | Type | Required | Default | Purpose |
| --- | --- | --- | --- | --- |
| `APP_NAME` | Variable | No | `Inkstone` | Display name shown in the app UI and meta tags |
| **`ADMINISTRATOR`** | Variable | No | `admin` | Auto-seeded owner account username on first startup (users table empty). Ignored once an owner exists or the database is already initialized. |
| **`ADMINPASSWORD`** | **Secret** | No | `admin123456` | Auto-seeded owner account password on first startup. **Always override the default in production** — set it as a Secret, not a plain Variable. Uses scrypt (`N=16384, r=8, p=5`) hashing, never stored in plaintext. |
| `PUBLIC_URL` | Variable | No | *(none)* | Optional public origin used for absolute links in backups and public sharing |

### First-run owner seeding (ADMINISTRATOR + ADMINPASSWORD)

If **both** variables are set **and** the `users` table is empty, the Worker auto-creates one `owner` account with the configured username and password. This happens exactly **once**: after seeding, a marker is written to `app_meta` (`system:admin_seeded = 1`) and subsequent restarts skip the step — even if you later truncate the users table. The seed also skips if the password is weaker than the normal registration rules (`≥ 8 characters`) or if the username is invalid (`3-32 chars, lowercase letters / digits / underscore / hyphen`).

For **production deployments** on Cloudflare:
1. Go to the Worker → **Settings → Variables and Secrets**.
2. Add **`ADMINISTRATOR`** as a regular **Variable** with your chosen username.
3. Add **`ADMINPASSWORD`** as a **Secret** (🔒) with a strong password.
4. Save. The next deployment (or first boot) will create the account automatically.
5. Log in immediately and change the password in **Settings → Account → Sign-in Security**.

> **Security note**: `admin123456` is only a fallback default baked into `wrangler.toml`. Never leave it in place on an internet-facing deployment — **always set ADMINPASSWORD as a Secret in the Cloudflare Dashboard** (secrets are never exposed via `wrangler.toml`, build logs, or client-side code).

## Client-side encrypted backup export

In addition to plain JSON and ZIP exports, Inkstone supports **password-encrypted** ZIP backups. The encryption happens entirely in the browser — the Worker never sees the key.

| Property | Detail |
| --- | --- |
| Algorithm | AES-256-GCM + PBKDF2-SHA256 (600k iterations, zero npm dependencies) |
| File format | `.enc` suffix, magic header `INKENC` + version byte + 16 B salt + 12 B IV + ciphertext |
| Key derivation | PBKDF2 from your password + per-file random salt |
| Where to enable | **Settings → Data → Export → "Encrypt with password"** |
| Recovery | Back on the same Data tab, upload the `.enc` file and enter the password — the Worker receives a plain ZIP and runs the standard import flow |
| Password policy | Must pass the same ≥ 8 characters validation used for login. Weak passwords are rejected on export. |
| Security guarantees | 1) Keys never leave the browser. 2) A wrong password produces a decryption error, not a partial import. 3) Ciphertext tampering is detected (AES-GCM authentication tag). |

No server-side configuration is required — the feature is built into the client bundle.

## User management (owner-only)

Owners can manage all member accounts from **Settings → Account → Access Control → User Management**.

| Action | How | Guardrails |
| --- | --- | --- |
| **List users** | Opens automatically when the panel loads | Only owners see the panel |
| **Promote → owner** | Click the ⬆ button on a member row | You cannot promote or demote yourself |
| **Demote → member** | Click the ⬇ button on an owner row | **Last owner cannot be demoted** (the system always keeps at least one owner) |
| **Delete member** | Click the 🗑️ button → confirm | Cannot delete owners, cannot delete yourself. All notes, folders, tags, attachments, versions, sessions, TOTP, OAuth grants and backups owned by that member are **permanently removed**. |
| **Open/Close registration** | **Settings → Account → Access Control → Allow Registration** | Owner-only, requires current password. When open, new visitors get a registration link and join as **members** (not owners). |

All changes are protected server-side even if the UI guard is bypassed. The owner identity is determined solely by the `role = 'owner'` column in D1; there is no separate `is_owner` flag.

## Deployment

1. Fork the Inkstone repository to your GitHub account.
2. Open [Cloudflare Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create).
3. Select **Continue with GitHub**, then choose your forked repository.
4. For R2 mode, set the build command to `npm run build` and the deploy command to `npm run deploy`.
   - To use KV mode, change the deploy command to `npm run deploy:kv`.
5. After deployment completes, open the generated Workers URL.
6. *(Recommended)* Go to **Settings → Variables and Secrets** and override `ADMINISTRATOR` / `ADMINPASSWORD` as described above before anyone can register.

Existing databases are upgraded automatically through versioned, idempotent migrations. Keep a current backup before updating any self-hosted deployment. When a newer stable Inkstone release is available, the owner receives a focused reminder without interrupting regular members.

## Exports and backups

- JSON export preserves legacy structured notebook data for re-import.
- ZIP export and remote backups use the same verified Markdown snapshot format, including readable notes, archived and trashed notes, attachments, and a completion marker.
- Remote backup targets support WebDAV and S3-compatible storage, with duplicate attachment content stored only once inside each snapshot.
- Large backups can be restored by selecting the backup folder, without loading one complete archive into memory.
- Multiple targets can be configured and run manually or on a schedule.
- Login passwords, active sessions, share passwords, and backup-service credentials are not included in exports.

## Development and verification

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local Worker and client |
| `npm run dev:kv` | Start locally with the KV attachment configuration |
| `npm run dev:demo` | Start the reset-on-refresh browser-only demo |
| `./scripts/dev-clean.ps1` | **Windows only** — kill port 7712, wipe `.wrangler`, start `npm run dev` with an ephemeral D1. Every run is a fresh empty database — perfect for resetting users or reproducing bugs. |
| `npm run typecheck` | Run TypeScript project checks |
| `npm run test:unit` | Run the Vitest unit test suite |
| `npm run i18n:check` | Verify parity between the English and Chinese locale resources |
| `npm run comments:check` | Enforce the source-comment policy |
| `npm run build` | Type-check and create a production build |
| `npm run deploy:kv` | Build and deploy with `wrangler.kv.toml` |
| `npm run deploy:demo` | Build and deploy the static browser-only demo |
| `npm run test:e2e` | Exercise the API against a running disposable local instance |

The end-to-end script creates, changes, and deletes data at `http://localhost:7712`. Run it only against a fresh local state dedicated to testing.

## Repository layout

```text
src/
├── client/   React interface, editor, preview, and local state
├── shared/   Shared types, limits, locale resources, and Markdown utilities
└── worker/   Hono API, authentication, D1 access, sync, sharing, and backups
public/       Static assets
scripts/      Repository checks and end-to-end verification scripts
tests/        Cross-module regression tests
```

## Security and contributions

Read [`SECURITY.md`](./SECURITY.md) before reporting a vulnerability. Development setup and contribution requirements are documented in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

Inkstone is distributed under the [GNU Lesser General Public License v3.0 only](./LICENSE), using the SPDX identifier `LGPL-3.0-only`.
