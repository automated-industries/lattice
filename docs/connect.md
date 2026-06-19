# Connect Lattice to your own dashboard

`lattice connect` lets you put Lattice behind a dashboard you already have — a
single HTML file, a page a chat assistant built for you, or a small site — so the
"upload files" button and "add notes" box in **your** page hand files to Lattice.
Lattice reads each file with your Claude key and files it against your data
(linking it to related records, writing a short description, capturing loose notes).

You don't need to be a programmer. The only thing you have to provide is a Claude
API key, and the steps below walk you through getting one.

---

## What you'll end up with

- Your own dashboard, served locally, with a working **Upload** button and **Add
  note** box.
- Every file or note you add gets read and auto-organized against your data.
- Everything runs on your computer. Your Claude key is stored encrypted locally and
  is never uploaded or written into your database.

---

## Step 1 — Install Lattice

You need [Node.js](https://nodejs.org) (version 18 or newer). Then:

```sh
npm install -g latticesql
```

Check it worked:

```sh
lattice --help
```

## Step 2 — Get a Claude API key (about a minute)

1. Open <https://console.anthropic.com/settings/keys> in your browser.
2. Sign in, or create a free account.
3. Click **Create Key**, give it a name, and copy the value (it starts with
   `sk-ant-`).

Keep that value handy for the next step. You can always create another later.

## Step 3 — Run `lattice connect`

Point it at your dashboard file (or a folder containing an `index.html`):

```sh
lattice connect --dashboard ./my-dashboard.html
```

The first time, it asks for your Claude key — paste it and press Enter. It's saved
encrypted on this computer only. After that you'll see:

```
Your dashboard is live at http://127.0.0.1:4317
Lattice's own view is at http://127.0.0.1:4317/lattice
Press Ctrl+C to stop.
```

Open that first URL — that's **your** dashboard, now backed by Lattice. The second
URL is Lattice's own built-in view of the same data, if you want it.

> Don't have a dashboard yet? Copy
> [`docs/examples/dashboard.html`](./examples/dashboard.html) — it's a complete,
> ready-to-use starting point you can restyle however you like (or hand to a chat
> assistant and ask it to make it look the way you want).

## Step 4 — Wire your own buttons (if you're building the page yourself)

Your dashboard is served from the same place as Lattice's data routes, so plain
`fetch()` calls work — no API key in the page, no extra setup. These three calls
are the whole integration:

```html
<script>
  // Upload one file → Lattice reads + auto-organizes it.
  async function latticeUpload(file) {
    const res = await fetch('/api/ingest/upload', {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-filename': encodeURIComponent(file.name || 'file'),
      },
      body: file,
    });
    return res.json(); // { id, extraction_status, suggestedLinks }
  }

  // Capture a note (or paste a link).
  async function latticeAddNote(text, title) {
    const res = await fetch('/api/ingest/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(title ? { text, title } : { text }),
    });
    return res.json();
  }

  // List what you've captured (newest first).
  async function latticeListFiles(limit = 25) {
    const res = await fetch('/api/tables/files/rows?limit=' + limit);
    return (await res.json()).rows;
  }
</script>
```

Hook them up to a file input, a textarea, and a list — see the example dashboard for
a complete, working version.

---

## Already running Lattice? Connect from the GUI

You do not have to restart with a flag. In the Lattice GUI, click **Connect
dashboard** in the top bar (or open **Settings → Dashboard**). A panel slides in
that walks you through it:

1. Folder or single file?
2. **Not sure where your dashboard lives?** Copy the provided prompt and paste it
   into Claude (or Claude Code) — it finds the exact path on your computer.
3. Paste the path and click **Connect**. Your dashboard is served at `/`
   immediately (the built-in Lattice view moves to `/lattice`), and the choice is
   remembered next time you start Lattice. Connecting an empty path disconnects.

Lattice serves the folder **in place**, so edits you make to your dashboard show
up on refresh — nothing is copied.

## Import your data model (make Lattice the source of truth)

Serving your dashboard lets Lattice *host* it. To make Lattice actually *understand*
your data — so it can show your records, link them, and auto-tag uploads against
them — import your data model. If your dashboard is backed by a structured JSON file
(records like `funds`, `investments`, …), Lattice can reconstruct it as real tables.

Once a dashboard is connected, the **Dashboard** panel shows an **Import your data
model** step:

1. Pick (or type the path to) your data file, e.g. `data.json`, and click **Analyze**.
   Nothing is written yet — Lattice just proposes a schema.
2. Review what it found: **entities** (your record arrays), **dimensions** (shared
   categorical fields like `industry` / `region`, normalized + deduped), and the
   **links** between them (e.g. each investment → its fund(s)). Derived/computed
   rollups are intentionally skipped.
3. Click **Import into Lattice**. It creates the tables, loads the rows (deduped),
   and wires up the links. Re-running is safe — it won't duplicate anything.

After import, your data is browsable in the Lattice view (`/lattice`) and readable
via `GET /api/tables/<entity>/rows`, and new file uploads can be auto-categorized
against it. Lattice is now the system of record for that data.

This is also available as a library API — `inferSchema(json)` returns the proposed
schema and `materializeImport(...)` applies it.

## What Lattice adds to your data (and what it never touches)

Lattice stores what you upload in a `files` table (and loose notes in `notes`), and
links them to your records through small `files_<table>` link tables. These are
created if they don't exist and are purely additive — your existing tables and rows
are never modified or deleted.

By default `lattice connect` uses a local SQLite workspace, so there's nothing else
to set up.

## Auto-organizing needs your Claude key

Reading and categorizing each file is done with your Claude key. If you skip the key,
files and notes are still **saved**, but they aren't auto-organized. Re-run
`lattice connect` any time to add the key, and new uploads will be organized from
then on.

## Good to know

- This runs locally and binds to `127.0.0.1` (your machine only). Putting Lattice
  behind a **separate, already-hosted** website (a different web address) is a
  planned follow-up.
- Connecting Lattice to an **existing** database you already have (so it organizes
  against tables you already built) is also on the roadmap; today `connect` starts
  you with a fresh local workspace.

See [docs/cli.md](./cli.md#lattice-connect) for the command reference.
