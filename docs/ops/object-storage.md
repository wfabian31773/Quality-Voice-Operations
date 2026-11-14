# Object storage adapter (PR-00b)

Private objects (dispatch uploads, completion photos, route-export archives,
voice-preview cache, and future call-recording bytes) go through
`platform/storage`. The adapter is selected by environment variables. This
PR ships **code and docs only** — it does not provision a bucket and does
not change Render env groups.

Render's filesystem is ephemeral. Do not treat `OBJECT_STORAGE_PROVIDER=local`
as a production backend.

## Provider selection

`OBJECT_STORAGE_PROVIDER` = `s3` | `local` | `replit` (`disk` is an alias for `local`).

| Value | Backend | When to use |
|---|---|---|
| `s3` | S3-compatible API (Supabase Storage, AWS S3, MinIO) | Render / production |
| `local` | Directory on disk | Vitest and offline development |
| `replit` | Replit object-storage sidecar (`127.0.0.1:1106`) | Legacy Replit host |
| unset | Auto: Replit if `PRIVATE_OBJECT_DIR` is set, else S3 if the S3 credential trio is set, else local if `OBJECT_STORAGE_LOCAL_DIR` is set, else **not configured** | |

`PRIVATE_OBJECT_DIR` wins over the S3 names while the provider is unset, so
adding S3 credentials to a Replit host does not move it off its bucket. To use
S3 on a host that still has `PRIVATE_OBJECT_DIR`, set
`OBJECT_STORAGE_PROVIDER=s3`.

**Never set `PRIVATE_OBJECT_DIR` on Render.** Render has no Replit sidecar. If
that name is copied onto `qvo-api` / `qvo-voice` / `qvo-worker` while
`OBJECT_STORAGE_PROVIDER` is unset, auto-detect picks Replit and every storage
write fails. `validate-env` warns (does not fail boot) when it sees the name
with `RENDER=true`. Use `OBJECT_STORAGE_PROVIDER=s3` and the S3 names below.

Any other `OBJECT_STORAGE_PROVIDER` value counts as **not configured**: routes
return 503, the server logs the variable name once, and `validate-env` warns.
Neither prints the value.

When nothing is configured, upload / attachment / photo / route-export routes
still return **503 `storage not configured`**. Voice-preview warm-tier caching
is skipped. The route-export cleanup scheduler is skipped.

## Environment variables (names only)

None of these are required to boot. Production keeps serving without them;
storage routes stay on 503 until an operator fills them in.

### S3-compatible (`OBJECT_STORAGE_PROVIDER=s3`)

| Name | Required for S3 | Purpose |
|---|---|---|
| `S3_BUCKET` | yes | Bucket for private objects |
| `S3_ACCESS_KEY_ID` | yes | Access key id |
| `S3_SECRET_ACCESS_KEY` | yes | Secret access key |
| `S3_ENDPOINT` | no | S3 API origin. Supabase Storage: `https://<project-ref>.supabase.co/storage/v1/s3`. Omit for AWS S3 |
| `S3_REGION` | no | Default `us-east-1` |
| `S3_FORCE_PATH_STYLE` | no | Default `true` (needed for Supabase / MinIO). Set `false` for virtual-hosted-style AWS S3 |
| `S3_PREFIX` | no | Optional key prefix inside the bucket |

`validate-env` **warns** (does not fail) when `OBJECT_STORAGE_PROVIDER=s3` but
`S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` are empty. It never
prints values.

### Local disk (`OBJECT_STORAGE_PROVIDER=local`)

| Name | Required | Purpose |
|---|---|---|
| `OBJECT_STORAGE_LOCAL_DIR` | no | Root directory. Default: `os.tmpdir()/qvo-object-storage` |

Use this in tests. Do not point production at local disk.

### Replit sidecar (`OBJECT_STORAGE_PROVIDER=replit` or unset + `PRIVATE_OBJECT_DIR`)

| Name | Required for Replit | Purpose |
|---|---|---|
| `PRIVATE_OBJECT_DIR` | yes | Private object directory (`/<bucket>/...`). **Never set on Render.** |
| `PUBLIC_OBJECT_SEARCH_PATHS` | public reads only | Comma-separated public search paths. Replit-only |

## Key layout

Every product write uses `storageKeys` in `platform/storage/keys.ts`:

| Kind | Key |
|---|---|
| Browser / mobile upload | `uploads/<uuid>` |
| Call recording | `recordings/<tenantId>/<callSid>` |
| Route-export ZIP | `dispatch-route-exports/<tenantId>/<exportId>.zip` |
| Voice-preview TTS cache | `voice-previews/<sha256>.mp3` |
| Knowledge PDF (when persisted to object storage) | `knowledge/<tenantId>/<documentId>.pdf` |

Persistable paths returned by `put` are `/<bucket>/<object>`. Upload flows
also use `/objects/<entityId>`. Both resolve through the same adapter. The one
exception is `S3_BUCKET=objects`, where `put` returns `/objects/<key>` without
`S3_PREFIX`, because that shape always reads back as an entity path.

Dispatch attachments accept only an `object_path` that normalizes to
`/objects/uploads/<id>` and that exists in storage; anything else is a 400.
Attachment downloads serve only `/objects/` paths.

## What this PR does not do

- Does not create a Supabase / S3 bucket
- Does not add names to `render.yaml` or the `qvo-secrets` env group
- Does not fail process boot when storage is unset
- Does not move knowledge-base PDF bytes out of Postgres `raw_file`

After a bucket exists, set the S3 names on `qvo-api`, `qvo-voice` (preview
cache), and `qvo-worker` (route-export cleanup) and restart. No code change
is required.
