# Lattice Cloud

A **Lattice cloud** is a shared Postgres database protected by real Postgres
**Row-Level Security (RLS)**. Several people connect to the same database and each
sees only their own rows plus the rows others have explicitly shared — and that
boundary is enforced by Postgres itself, not by any application code.

There is exactly **one** concept here: the cloud. A cloud _is_ the set of people
who can connect to it; there is no separate "team" object to create and no "enable
sharing" step. We call the people on a cloud its **members**, the person who set it
up its **owner**, and the database itself the **cloud**.

> **SQLite is single-user and local.** RLS and the cloud model are Postgres-only.
> A local SQLite Lattice is just your private store; every cloud installer in the
> library is a no-op on SQLite. To go from a local Lattice to a shared one, you
> **migrate** it into a cloud Postgres (see below).

---

## What makes it different: no server

There is **no Lattice server process**. There is no HTTP API in front of Postgres,
no bearer tokens, no replica, and no sync client. A cloud is _only_ a Postgres
database with RLS installed.

```
┌─ alice (owner) ────────┐        ┌─ bob (member) ─────────┐        ┌─ carol (member) ──────┐
│  psql / lattice gui    │        │  psql / lattice gui    │        │  psql / lattice gui   │
│  role: alice           │        │  role: lm_bob_a91c     │        │  role: lm_carol_3f70  │
│  password: ••••••      │        │  password: ••••••      │        │  password: ••••••     │
└───────────┬────────────┘        └───────────┬────────────┘        └──────────┬────────────┘
            │  direct postgres:// connection, each as its OWN scoped role       │
            └──────────────────────────────┬──────────────────────────────────┘
                                            ▼
                       ┌─ Cloud Postgres (RLS installed) ────────────┐
                       │  your user-defined tables                   │
                       │    └ ENABLE + FORCE ROW LEVEL SECURITY      │
                       │  __lattice_owners      (row → owner role)   │
                       │  __lattice_row_grants  (custom grants)      │
                       │  __lattice_changes     (append-only feed)   │
                       │  lattice_members       (group role)         │
                       │  SECURITY DEFINER fns: lattice_row_visible, │
                       │    lattice_set_row_visibility, _grant, …    │
                       └─────────────────────────────────────────────┘
```

**Each member connects directly to Postgres as their own scoped, non-superuser
role** — never a shared owner/superuser connection string. Postgres RLS is the
security boundary: a member who opens a raw `psql` against their own connection
**physically cannot read or write another member's rows**. There is no privileged
layer to bypass because there is no layer at all — the database is the boundary.

The DBA's entire job is to **set up the Postgres database and create
usernames/passwords**. Lattice installs the security model on top using plain SQL:
`CREATE ROLE`, `CREATE POLICY`, `FORCE ROW LEVEL SECURITY`, and a handful of
`SECURITY DEFINER` functions.

### Identity is the Postgres role

A member's identity is simply **which Postgres role they authenticated as**.
Policies key on `session_user` / `current_user`, which Postgres resolves from the
login — it is reliable even behind a **transaction-mode connection pooler**, where
`SET LOCAL`-based identity schemes break because a pooled transaction can land on
any backend. Because the login role _is_ the identity, there is nothing to spoof:
to act as another member you would need that member's password.

---

## The security model

Lattice installs the cloud security model in two parts, both via plain SQL
migrations against the cloud Postgres.

### 1. Bootstrap (once per cloud)

`installCloudRls(db)` creates the shared machinery:

- **`lattice_members`** — a `NOLOGIN` group role. Table and schema privileges are
  granted to the group, so adding a member or a shared table is a single `GRANT`.
  The group grants _access_; RLS still filters _visibility_ per individual login
  role. Membership in the group never lets you see another member's rows.
- **`__lattice_owners`** `(table_name, pk, owner_role, visibility, …)` — the
  out-of-band record of who owns each row and how widely it's shared
  (`private` | `everyone` | `custom`). It is never injected into your tables and
  members cannot read or write it directly.
- **`__lattice_row_grants`** `(table_name, pk, grantee_role, granted_by, …)` — the
  explicit grant list backing `custom` visibility.
- **`__lattice_changes`** — an append-only change feed (`seq`, `table_name`, `pk`,
  `op`, `owner_role`, `created_at`). A per-row `AFTER INSERT` trigger fires
  `pg_notify('lattice_changes', …)` carrying only _metadata_ (table, pk, op) — never
  row content — so a connected GUI can refetch the affected row _through RLS_.
- **`SECURITY DEFINER` functions** that read the bookkeeping a member can't:
  - `lattice_row_visible(table, pk)` — the visibility predicate the policies call,
    keyed on `session_user`. A row with no ownership record is visible to nobody.
  - `lattice_set_row_visibility(table, pk, visibility)` — owner-only; raises if the
    caller isn't the row's owner.
  - `lattice_grant_row(table, pk, grantee)` / `lattice_revoke_row(table, pk, grantee)`
    — owner-only; manage the `custom` grant list.

### 2. Per-table RLS

`enableRlsForTable(db, table, pkCols)` secures one shared table:

```sql
ALTER TABLE "items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "items" FORCE  ROW LEVEL SECURITY;   -- applies even to the table owner
GRANT SELECT, INSERT, UPDATE, DELETE ON "items" TO lattice_members;

CREATE POLICY "lattice_sel" ON "items" FOR SELECT USING (lattice_row_visible('items', CAST("id" AS TEXT)));
CREATE POLICY "lattice_upd" ON "items" FOR UPDATE USING (...) WITH CHECK (...);
CREATE POLICY "lattice_del" ON "items" FOR DELETE USING (...);
CREATE POLICY "lattice_ins" ON "items" FOR INSERT WITH CHECK (true);
```

plus a per-table `SECURITY DEFINER` trigger that, on every write, stamps the
inserting member as the row's owner in `__lattice_owners` and records the change in
`__lattice_changes`. Members cannot write the bookkeeping tables directly — only the
definer-owned trigger can.

`FORCE ROW LEVEL SECURITY` is the critical flag: without it, the table's owner role
would bypass its own policies. With it, the policies apply to everyone, so the cloud
owner is bound by the same row rules as any member.

> **Composite keys.** The `pk` string written to `__lattice_owners.pk` uses
> Lattice's canonical serialization: a single-column key is the bare value; a
> composite key is its columns joined by a TAB (`chr(9)`). This is the same key the
> change feed and the row-visibility functions use.

> **Empirically verified.** Two non-superuser roles connecting directly cannot
> see, update, or delete each other's private rows; cannot read the bookkeeping
> tables; cannot `DISABLE ROW LEVEL SECURITY`; and cannot `SET ROLE` to another
> member.

---

## The role & privilege model

| Who        | Postgres role attributes                                                                                     | Can do                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Owner**  | a normal login role with **`CREATEROLE`**                                                                    | migrate a local Lattice in, install RLS, provision members, share/unshare their own rows                    |
| **Member** | a login role, **`NOSUPERUSER NOCREATEDB NOCREATEROLE`**, in the `lattice_members` group, with RLS **forced** | read/write only their own + shared rows; cannot escalate, cannot run DDL, cannot read another member's data |

A member's credential is a dead end for privilege escalation: the role is
`NOSUPERUSER`, can't create roles or databases, isn't granted DDL on the schema, and
RLS is forced on every shared table.

The DBA may either let an owner provision member roles (the owner connection needs
`CREATEROLE`), or pre-create the login roles by hand and skip provisioning entirely —
Lattice only needs the roles to exist and to be members of `lattice_members`.

---

## Sharing: private by default

Every row is **private to its owner** the moment it's written — the per-table
trigger stamps `visibility = 'private'`. The owner opts a row into wider visibility:

- **`private`** — only the owner sees it (the default).
- **`everyone`** — every member of the cloud sees it.
- **`custom`** — only the owner plus an explicit grant list (`lattice_grant_row`).

Sharing is done through the owner-only `SECURITY DEFINER` function — Postgres raises
for anyone who isn't the row's owner:

```sql
-- Make one row visible to every member of the cloud:
SELECT lattice_set_row_visibility('items', 'item-42', 'everyone');

-- Take it private again:
SELECT lattice_set_row_visibility('items', 'item-42', 'private');

-- Or grant just one member (sets visibility = 'custom'):
SELECT lattice_grant_row('items', 'item-42', 'lm_bob_a91c');
SELECT lattice_revoke_row('items', 'item-42', 'lm_bob_a91c');
```

From the library, the same thing through `setRowVisibility` (validates `private` |
`everyone` before calling the function):

```ts
import { Lattice, setRowVisibility } from 'latticesql';

const db = new Lattice('postgres://alice:secret@cloud.example.com:5432/app');
await db.init();

// 'item-42' is the row's canonical primary-key string (composite keys are
// TAB-joined). Only the row's owner may call this; Postgres raises otherwise.
await setRowVisibility(db, 'items', 'item-42', 'everyone');
```

Because sharing lives in `__lattice_owners` (out of band), opting a row in or out
never touches your table's columns.

---

## The three user flows

There are exactly three things you do with a cloud: **migrate** into one, **join**
an existing one, or **invite** someone to yours.

### 1. Migrate — turn a local Lattice into a cloud

You have a local SQLite (or single-user Postgres) Lattice and want to share it. You
point it at a fresh, empty Postgres database; Lattice copies your data in, installs
RLS, and stamps **you** as the owner of every migrated row.

From the GUI: **Workspace Settings → Migrate to cloud**, which posts to
`POST /api/dbconfig/migrate-to-cloud` with the target Postgres credentials. The
handler:

1. **Probes** the target with `probeCloud(url)`. It refuses if the database is
   unreachable (`502`) or is _already_ a Lattice cloud (`409` — migrating into it
   would mix two owners' data; you should **join** it instead).
2. Opens a target Lattice matching your schema and **copies every row** (your
   tables plus the native `files` / `secrets`). Encrypted columns round-trip.
3. **Installs RLS** (`installCloudRls`) and, for each keyed table,
   **backfills ownership** to your role _before_ forcing RLS (otherwise FORCE would
   hide the not-yet-owned rows from your own backfill `SELECT`), then
   `enableRlsForTable`.
4. Archives the local SQLite file, saves the connection string encrypted, and
   rewrites the config's `db:` line to reference it by label.

After migration you're connected to the cloud as its owner, your rows are private by
default, and you can invite members.

The same flow from the library:

```ts
import {
  Lattice,
  openTargetLatticeForMigration,
  migrateLatticeData,
  installCloudRls,
  backfillOwnership,
  enableRlsForTable,
  archiveLocalSqlite,
} from 'latticesql';

const encryptionKey = process.env.LATTICE_ENCRYPTION_KEY;
const cloudUrl = 'postgres://alice:secret@cloud.example.com:5432/app';

const source = new Lattice({ config: './lattice.config.yml' }, { encryptionKey });
await source.init();

const target = await openTargetLatticeForMigration('./lattice.config.yml', cloudUrl, encryptionKey);
await migrateLatticeData(source, target); // → { tablesCopied, rowsCopied }

// Owner-side RLS install. Backfill ownership BEFORE forcing RLS on each table.
await installCloudRls(target);
for (const table of target.getRegisteredTableNames()) {
  if (table.startsWith('__lattice_')) continue;
  const pk = target.getPrimaryKey(table);
  if (pk.length === 0) continue; // unkeyable table — no per-row RLS
  await backfillOwnership(target, table, pk);
  await enableRlsForTable(target, table, pk);
}
target.close();

archiveLocalSqlite('./data/app.db'); // renames to .db.local-bak
```

### 2. Join — connect to an existing cloud with the credentials you were given

The owner provisioned a scoped role for you and handed you the connection details:
**host, port, database, username, password**. **Those credentials _are_ the
invite** — there is no token to redeem and no server to sign into. You connect
directly.

From the GUI: **+ New workspace… → Join a cloud**, then paste the connection blob.
It posts to `POST /api/dbconfig/connect-existing`, which:

1. **Probes** the target as your role. The probe both authenticates the login and
   confirms the database is actually a Lattice cloud (RLS installed). It refuses if
   unreachable (`502`) or if the database isn't a cloud yet (`409` — the owner must
   migrate a local Lattice into it first).
2. Saves the credential encrypted, rewrites the config, and opens the cloud. Your
   role can't (and needn't) run DDL — the owner already created the role and RLS
   confines it — so the cloud is opened in introspect-only mode.

From there you query the cloud directly and see exactly the rows RLS allows: your
own, anything shared to `everyone`, and anything granted to you specifically.

```ts
import { Lattice, probeCloud } from 'latticesql';

const url = 'postgres://lm_bob_a91c:the-password@cloud.example.com:5432/app';

const probe = await probeCloud(url);
// → { reachable: true, dialect: 'postgres', isCloud: true }
if (!probe.reachable) throw new Error(probe.error);
if (!probe.isCloud) throw new Error('Not a Lattice cloud yet — ask the owner to migrate into it.');

const db = new Lattice(url);
await db.init();
const visibleItems = await db.query('items'); // RLS-filtered to what you may see
```

### 3. Invite — provision a member role and hand them the connection blob

You own a cloud and want to add someone. As the owner (your connection holds
`CREATEROLE`), you provision a scoped member role and give them its credentials.

From the GUI: **Workspace Settings → Invite**, which posts to
`POST /api/cloud/invite`. The handler verifies the active database is a cloud and
that your role can manage roles (`403` otherwise), then provisions a fresh scoped
role and returns the **complete connection blob** to hand off:

```jsonc
{
  "ok": true,
  "invite": {
    "host": "cloud.example.com",
    "port": 5432,
    "dbname": "app",
    "user": "lm_bob_a91c", // freshly provisioned scoped role
    "password": "…48 hex chars…", // generated once; this is the only time it's shown
  },
}
```

That blob _is_ the invite. The new member pastes it into **Join a cloud** (flow 2).

The same thing from the library:

```ts
import { Lattice, memberRoleName, generateMemberPassword, provisionMemberRole } from 'latticesql';

// owner connection — must hold CREATEROLE
const db = new Lattice('postgres://alice:secret@cloud.example.com:5432/app');
await db.init();

const role = memberRoleName('bob'); // e.g. 'lm_bob_a91c' — collision-safe, ≤63 bytes
const password = generateMemberPassword(); // 48 hex chars
await provisionMemberRole(db, role, password);
// Member is created NOSUPERUSER NOCREATEDB NOCREATEROLE and added to lattice_members.

// Hand off:  host / port / dbname  +  user=role  +  password
```

Removing a member is the inverse — `revokeMemberRole(db, role)` drops the role.
(Rows the departed member owned stay in their tables but become unreachable until
you deliberately reassign or purge them — revoking access is not the same as
purging their data.)

```ts
import { Lattice, revokeMemberRole } from 'latticesql';
await revokeMemberRole(db, 'lm_bob_a91c');
```

---

## How a member opens the cloud

A member opens the cloud by **connecting directly as their scoped role** — there is
no separate sign-in. The connection string the owner handed over (host / port /
database / username / password) is the whole credential. Lattice opens the cloud in
introspect-only mode for a member: the role is `NOSUPERUSER` without DDL on the
schema, so it never tries to create or alter tables — it reads the existing schema
and works against the rows RLS lets it see. Every query, insert, update, and delete
runs as that role, so RLS scopes the member to their own rows plus whatever has been
shared with them. Nothing about being a member requires elevated privileges or a
side channel; the database does all the gatekeeping.

---

## GUI cloud endpoints

`lattice gui` drives all three flows from the browser. The relevant endpoints (all
localhost-only, same model as the rest of the GUI):

| Method | Route                            | Does                                                                 |
| ------ | -------------------------------- | -------------------------------------------------------------------- |
| POST   | `/api/dbconfig/migrate-to-cloud` | Migrate the active local Lattice into a fresh cloud (you = owner)    |
| POST   | `/api/dbconfig/connect-existing` | Join a cloud directly with scoped credentials (the invite)           |
| POST   | `/api/cloud/invite`              | Owner provisions a scoped member role; returns the connection blob   |
| POST   | `/api/cloud/share`               | Owner sets a row's visibility (`private` \| `everyone`)              |
| GET    | `/api/cloud/s3-config`           | Read this member's S3 config (secret redacted)                       |
| POST   | `/api/cloud/s3-config`           | Owner sets S3 for the cloud (see **S3-backed file bytes** below)     |
| GET    | `/api/cloud/system-prompt`       | Owner reads the chat system prompt (members get no text)             |
| POST   | `/api/cloud/system-prompt`       | Owner sets the chat system prompt (see **Chat system prompt** below) |

`POST /api/cloud/share` body is `{ table, pk, visibility }` and calls
`setRowVisibility` under the hood; Postgres raises if you aren't the row's owner.

The probe used throughout is `probeCloud(url)`, returning
`{ reachable, dialect, isCloud }` — `isCloud` is `true` when the target Postgres
already has the RLS machinery installed.

---

## Offline editing

Offline editing is preserved as a **client-side local edit queue**: edits you make
while disconnected are held locally and replayed when you reconnect. This is a
client behavior only — it is **not** tied to any replica or sync server (there is
no server). When you reconnect, the queued writes go to the cloud as your role and
land under the same RLS rules as any other write.

---

## Chat system prompt (owner-set, per workspace)

A cloud **owner** can set a **chat system prompt** that's bundled into every
member's assistant chat for that workspace — house style, domain facts, a fiscal
calendar, whatever the team should always have in context. The owner edits it in
**workspace settings** ("Edit chat system prompt"); members never see the control.
It's stored in the shared DB (`__lattice_cloud_settings`, key `chat_system_prompt`)
and injected into the system message of each member's turn, alongside the live
schema.

**Owner-only to view and edit, app-mediated.** Two `SECURITY DEFINER` helpers back
it (`src/cloud/settings.ts`): `lattice_set_cloud_setting` raises unless the caller
can create roles (the owner gate), and `lattice_get_cloud_setting` is the read path.
The member group has **no grant on the table**, so the prompt never appears in a
member's table browser or the data API, and `GET /api/cloud/system-prompt` returns
the text **only to an owner** (a member gets `canEdit: false` and no text).

> **Ceiling — same shape as the S3 feature.** This is **app-mediated** secrecy, not
> cryptographic. Each member's chat call is assembled in their OWN local process
> over their OWN scoped connection, so the prompt must be readable by that
> connection to be injected — which means `lattice_get_cloud_setting` is callable by
> a member, and a member who goes looking (calling the function in `psql`, or
> inspecting their app's outbound request to the model) **can** read the prompt.
> What this guarantees is that the prompt is hidden from the product surface (the
> UI and every API response), not that it is secret from a member's own SQL session.
> True secrecy would require a server-side chat relay members can't reach, which the
> no-server v3 model deliberately doesn't have.

On a local SQLite workspace there are no members and nothing to keep secret, so the
editor is hidden (`GET` reports `supported: false`).

---

## S3-backed file bytes (opt-in)

A `files` row is shared by RLS like any other row, but a file's **bytes** are
written to the uploader's local disk (`<root>/data/blobs/<sha256>`). On a cloud
that means another member can SELECT the row yet can't fetch the bytes — they live
on someone else's machine. Enabling S3 closes that gap: uploaded bytes also go to
an S3 bucket, and any member who can see the row pulls them down in the viewer.

**It adds no new access machinery — it rides the same `files`-row RLS.** The serve
route does `db.get('files', id)` as the member's own scoped role; a row RLS won't
let them SELECT returns NULL → 404 _before S3 is ever touched_. The object key is
content-addressed (`<prefix>/<sha256>`) and appears **only** inside that
RLS-gated row. The bucket credential grants `GetObject`+`PutObject` and nothing
else — **no `ListBucket`, no `Delete`** — so the key is the only handle to an
object and there's no way to enumerate the bucket. A member learns a key exactly
when, and only when, RLS lets them read the row that holds it.

### Enabling it

S3 config is **per member, machine-local, and encrypted** — it sits in the same
AES-GCM store as your scoped DB credential (`db-credentials.enc`), never in the
shared database. Set it from the GUI (owner-only `POST /api/cloud/s3-config`) or
via environment variables for headless/CI use:

| Variable                                      | Meaning                                               |
| --------------------------------------------- | ----------------------------------------------------- |
| `LATTICE_S3_BUCKET`                           | Bucket name (enables S3 when set)                     |
| `LATTICE_S3_REGION`                           | Region (falls back to `AWS_REGION`)                   |
| `LATTICE_S3_PREFIX`                           | Key prefix; defaults to `blobs`                       |
| `LATTICE_S3_ENDPOINT`                         | Custom endpoint for S3-compatible stores (R2 / MinIO) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Credentials (or the standard AWS chain)               |

`@aws-sdk/client-s3` is an **optional dependency**, lazy-imported only when S3 is
enabled. If it isn't installed, uploads fall back to local-only and the serve route
reports that the bytes aren't reachable here — it never 500s. Setting
`LATTICE_S3_ENDPOINT` switches the client to path-style addressing, which is what
R2, MinIO, and LocalStack expect.

When enabled, an upload keeps the **local blob too** (hybrid): the uploader gets
instant local preview while every other member streams from S3. The row records
`ref_kind='cloud_ref'`, `ref_provider='s3'`, `ref_uri='s3://<bucket>/<key>'`, and
`source_json={bucket,key,region,size_bytes}` — no schema migration; these fields
already exist.

The fallback is **never silent**: if S3 is enabled but the upload's PUT fails
(rotated credential, outage, region mismatch, SDK absent), the upload still
succeeds locally — but the response carries `s3: { status: 'failed', error }` so
the uploader is told the bytes did **not** reach the shared bucket. Other members
fetch from S3, so a file shared after a failed PUT would 404 for everyone but the
uploader; surfacing the failure lets the GUI prompt a re-upload instead of implying
a clean share. A clean upload returns `s3: { status: 'stored', key }`.

The serve route (`GET /api/files/:id/blob`) sends bytes inline with
`X-Content-Type-Options: nosniff` and a no-allowances `Content-Security-Policy:
sandbox`. Both the bytes and the row's `mime` are member-writable (PutObject to the
shared bucket + the generic row CRUD), so without these headers a member could stage
`text/html` and have it execute in another member's GUI origin. Image/PDF previews
still render (they load `/blob` as a subresource); a hostile HTML blob opened
directly is inert.

### Least-privilege IAM policy

Grant the workspace credential exactly this — `GetObject` + `PutObject` scoped to
the prefix, and nothing that can list or delete:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LatticeCloudBlobsReadWrite",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/blobs/*"
    }
  ]
}
```

Do **not** add `s3:ListBucket` or `s3:DeleteObject`. ListBucket would let a holder
enumerate every key (defeating the "the key only appears in an RLS row" boundary);
Delete isn't needed by the app and widens the blast radius of a leaked credential.
Enable default bucket encryption (SSE-S3 or SSE-KMS) and block public access.

### Security model & caveats (read before enabling)

This is **app-mediated** access control, which is the honest ceiling for a model
with no Lattice server in front of the bytes. Understand what it does and does not
guarantee:

1. **Byte-access is app-mediated, not S3-enforced.** The boundary is "the
   RLS-gated `files` row is the only place the object key appears." S3 itself can't
   tell one member from another — both present the same shared credential.
2. **Revocation doesn't retract bytes.** Un-sharing a row (`visibility → private`)
   stops future DB reads, but a member who already fetched the object (or just
   learned its key) keeps access to the content-addressed object. Rotate/relocate
   the object if you need true retraction.
3. **The shared workspace credential is a single point of compromise.** Treat it
   exactly like the owner's Postgres URL — machine-local, `0600`, encrypted. Anyone
   with the credential _and_ a key can read that object.
4. **No per-member S3 audit.** CloudTrail sees one shared principal, so S3 access
   logs can't attribute a fetch to a person. DB-layer provenance still attributes
   the row itself.
5. **Security depends on never granting `ListBucket` and always using the
   unguessable sha256 keys.** Both are required; relaxing either collapses the
   boundary.

For teams that need true per-member byte enforcement and per-member audit, the
documented upgrade path is an online, RLS-checking presign edge (it reintroduces a
small server that signs per-member, time-boxed URLs only after re-checking RLS) —
out of scope here. Crypto-shred of S3 objects on row delete is likewise an
owner-run admin follow-up.

---

## Limits & notes

- **Cloud is Postgres-only.** SQLite has no roles or RLS; a local SQLite Lattice is
  your private single-user store. The bridge between them is **migrate**.
- **Identity is the Postgres login.** There is no separate account system. A member
  _is_ their role; to act as someone else you'd need their password. Provision
  one role per person so you can revoke individually.
- **Owner needs `CREATEROLE`** to provision members from Lattice. Alternatively the
  DBA pre-creates the login roles by hand and adds them to `lattice_members`.
- **Departed members' rows persist.** `revokeMemberRole` drops the role but leaves
  the rows it owned (now unreachable). Reassign or purge them deliberately.
- **Postgres SSL** is governed by your connection string — pass `?sslmode=require`
  (or your provider's equivalent). Lattice doesn't override it.
- **Connection strings are secrets.** A member's scoped string is safe to hand to
  that member (RLS confines it), but the **owner's** string is a superuser-adjacent
  credential to the whole cloud — keep it encrypted and never share it.

---

## Per-column audiences & per-viewer values (experimental)

RLS is whole-row. Two layered primitives take it to the **cell** and to
**per-viewer values**, so different members can legitimately see different
versions of the same entity. Both are off by default — a column with no
`audience` behaves exactly as before.

**1. Per-column masking — a generated view.** Declare an `audience` on a column
and Lattice generates a cell-masking view `<table>_v` beside the base table:

```yaml
person:
  fields:
    id: { type: uuid, primaryKey: true }
    name: { type: text }
    comp: { type: text, audience: 'subject:subject_role+role:hr' }
    subject_role: { type: text }
```

The audience is a `+`-joined (OR) set of clauses — `role:<name>`,
`subject:<col>`, `source:<col>`, or `everyone`. Each compiles to a
`session_user`-keyed `SECURITY DEFINER` predicate (`lattice_has_role` /
`lattice_is_subject` / `lattice_source_visible`), so the mask binds to the real
member even though the view runs with its owner's rights. Members `SELECT` the
view (base `SELECT` is revoked); a masked cell reads as `NULL`. App roles are
owner-managed via `lattice_assign_role(member, role)` — members can't
self-promote. Generated by `enableAudienceView`, never hand-edited.

**2. Per-viewer values — a local fold.** When a value is _derived_ from a source
(e.g. an enrichment computed from a file), it is only valid for a member who can
see that source. `foldEntity(ground, observations, viewer)` (in `latticesql`)
overlays the observations a viewer is allowed to see onto the ground-truth
projection — latest visible observation per attribute wins. It is a pure,
deterministic, additive fold, so a member who can't reach a source simply never
sees its derived value, and **un-sharing the source reverts the value with no
residue** (revocation is structural, not a cleanup job). Run it on the member's
local replica over already-gated observations, cached with `FoldCache` and
re-rendered only when an observation changes — egress is paid once at pull.

**3. Forgetting a source — crypto-shred.** For a legally sensitive source, seal
its derived values under a per-source key (`sealUnderSource`) and call
`shredSource` to destroy the key — the values become unrecoverable everywhere
the ciphertext exists, backups included.

**Source sharing is direct (for now).** Source visibility reduces to the
source row's own RLS. Transitive source-sharing (folders / teams / inheritance,
a ReBAC-style model) is intentionally deferred until that shape is actually
needed — the primitives above compose with it when it lands.
