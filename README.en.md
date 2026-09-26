<p align="center">
  <img src="./public/inkstone-logo.svg" width="112" height="112" alt="Inkstone project logo" />
</p>

<h1 align="center">Inkstone</h1>

<p align="center">
  A self-hosted Markdown notebook for writing, organizing, syncing, and backing up personal knowledge.
</p>

<p align="center">
  <a href="./README.md">中文</a> ·
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
| **`ADMINISTRATOR`** | **Secret** | No | *(none)* | Username of the owner account. Used together with `ADMINPASSWORD` to decide which account is governed by the deployment configuration. |
| **`ADMINPASSWORD`** | **Secret** | No | *(none)* | Password of the owner account. **This is the authoritative password**: changing it replaces the stored hash on the next cold start and signs that account out everywhere. Uses scrypt (`N=16384, r=8, p=5`) hashing, never stored in plaintext. |
| `PUBLIC_URL` | Variable | No | *(none)* | Optional public origin used for absolute links in backups and public sharing |

> **Both must be set as Secrets**, never as plain `[vars]` in `wrangler.toml`. See below for why.

### The owner account is governed by the Cloudflare configuration (ADMINISTRATOR + ADMINPASSWORD)

These variables are **not a one-off seed** — they are an ongoing source of truth. Every Worker cold start (once per isolate, not per request) reconciles the account against them:

| Situation | Behaviour |
| --- | --- |
| Account exists, password matches, role is owner | Nothing happens |
| Account exists, password **differs** | The stored hash is replaced **and every session for that account is revoked** — otherwise the old sign-in would still work |
| Account exists but the role is not owner | The role is restored to owner, so the configuration and the actual permission cannot drift apart |
| Account does not exist and the `users` table is empty | Created as owner (first-run bootstrap) |
| Account does not exist but the instance already has users | **Warns and skips** — a typo in `ADMINISTRATOR` cannot silently create a second owner |

**The username is never renamed.** Changing `ADMINISTRATOR` will not rename an existing account; if it points at a name that does not exist on a non-empty instance, it only logs a warning.

For **production deployments** on Cloudflare:
1. Go to the Worker → **Settings → Variables and Secrets → Secrets**.
2. Add **`ADMINISTRATOR`** (🔒) with your chosen username.
3. Add **`ADMINPASSWORD`** (🔒) with a strong password (≥ 8 characters).
4. Visit the site once — the reconciliation runs and takes effect.
5. To rotate the password later, just change `ADMINPASSWORD`. No need to clear the database or delete the account.

> **Security note**: changing `ADMINPASSWORD` changes the owner password, so make sure you remember the new value or you will lock yourself out. Note also that anyone able to edit your Cloudflare secrets can already take over the owner account — that is the inherent cost of holding the credential in the deployment configuration, so protect your Cloudflare account.

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
| **Create member** | "New user" at the top of the panel | Only a username is required. A random password is generated and shown **exactly once** — only its hash is stored, so it cannot be recovered after the dialog closes. New accounts are members. |
| **Reset password** | Click the 🔑 button on a row → confirm | Generates a new random password and **revokes every session of that member** (otherwise the old sign-in would still work). Not available for yourself — use the Sign-in Security section above for your own password. |
| **Suspend / Restore** | Click the 🚫 / ↺ button at the end of a row → confirm | A suspended account **keeps every note and attachment** but is signed out immediately and cannot sign in until restored. You cannot suspend yourself, and you cannot suspend the last usable owner. |
| **Promote → owner** | Click the ⬆ button on a member row | You cannot promote or demote yourself |
| **Demote → member** | Click the ⬇ button on an owner row | **Last owner cannot be demoted** (the system always keeps at least one owner) |
| **Delete member** | Click the 🗑️ button → confirm | Cannot delete owners, cannot delete yourself. All notes, folders, tags, attachments, versions, sessions, TOTP, OAuth grants and backups owned by that member are **permanently removed**. |
| **Open/Close registration** | **Settings → Account → Access Control → Allow Registration** | Owner-only, requires current password. When open, new visitors get a registration link and join as **members** (not owners). When closed, accounts can only be created from user management. |

All changes are protected server-side even if the UI guard is bypassed. The owner identity is determined solely by the `role = 'owner'` column in D1; there is no separate `is_owner` flag.

### The account governed by the deployment configuration

The account named by `ADMINISTRATOR` is **read-only** throughout the user management UI: delete, demote, reset password and suspend are all disabled, and the row is labelled "Managed by configuration". Its state is decided by the Cloudflare reconciliation, so a change made in the UI would simply be reverted on the next cold start. To change it, edit the Cloudflare secrets.

## Roadmap (not implemented yet)

The following capabilities are explicitly planned but not built:

| Plan | Description | Main challenge |
| --- | --- | --- |
| **PDF import** | Convert PDFs into Markdown notes alongside the existing `.md/.txt/.docx/.epub/.html` importers | `pdf.js` only exposes plain text, so heading levels, tables and list structure are lost and the result has to accept some degradation |
| **Multi-turn AI chat** | The AI Q&A is currently single-turn RAG; the plan is to support follow-up questions | Needs storage for conversation history (KV or Durable Objects), plus history trimming and quota handling |
| **Automatic upload of embedded images** | Store images extracted from `.docx` / `.epub` in R2 and rewrite their links | Requires wiring the attachment upload and `import_mappings` deduplication into the import flow, which is a fairly wide cross-layer change |
| **Rename usernames** | Let owners change a member's login name | Needs unique-constraint handling, a strategy for the old username, and reconciliation with the configuration-managed account guardrails |
| **Bulk actions** | Multi-select in the user list for bulk suspend/delete | Depends on the suspend capability first (already shipped), then adds selection UI and atomic batching |

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
