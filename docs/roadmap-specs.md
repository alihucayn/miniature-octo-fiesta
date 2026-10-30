# Roadmap specs (post-launch)

**Start these only after the first paying customer.** Until then, launch work in `docs/launch-checklist.md`
and the SEO guides bring more revenue than new features. Order: MCP server first (small, separate package, its
own distribution channel), then the template editor.

Both build on the API exactly as documented in `public/docs.html`; neither changes the render or billing contract.

---

## 1. MCP server: `docforge-mcp`

### Why

AI coding assistants (Claude Desktop, Cursor, other MCP clients) increasingly pick tools for developers. An MCP
server makes "generate an invoice PDF" a single tool call that uses the customer's own API key and quota, and the
MCP directories are an extra free listing channel.

### Shape

- A **separate npm package and repo**, `docforge-mcp` (rename with the product if step 2 of the checklist renames).
  Nothing is added to this repo's `src/` or `package.json`.
- Dependency: `@modelcontextprotocol/sdk`, stdio transport. Node ≥ 18 with global `fetch`; no other dependencies.
- Configuration through environment variables:
  - `DOCFORGE_API_KEY` (required): sent as `Authorization: Bearer <key>`.
  - `DOCFORGE_URL` (optional, default `https://<domain>`): for self-hosted or staging instances.
- Every request sets a `User-Agent: docforge-mcp/<version>` header and signs up with `source: 'mcp'` when the
  README's signup link is followed (`/?ref=mcp#signup`).

### Tools

| Tool | Input | Calls | Returns |
|---|---|---|---|
| `list_gallery` | none | `GET /v1/gallery` | id, name and description of each gallery template (`gallery:invoice`, `gallery:receipt`, `gallery:certificate`, `gallery:quote`, `gallery:packing-slip`) |
| `list_templates` | none | `GET /v1/templates` | the account's templates: id, name, updated_at |
| `create_template` | `name`, and either `html`/`css`/`sample_data` or `from_gallery: "<gallery id>"` | `POST /v1/templates` (copies the gallery template's html/css/sample data when `from_gallery` is set) | the new template id; a 402 `template_limit` is returned as text including `upgrade_url` |
| `render_pdf` | `template_id` or `html`; `data`; optional `options`; required `out_path` | `POST /v1/render` with default binary output | writes the PDF to `out_path` and returns `{path, size, renders_remaining}` (from `X-Renders-Remaining`) plus any `X-DocForge-Blocked-Assets` warning. **Never returns base64**: PDFs would flood the model's context. |
| `get_template_example` | `template_id` | `GET /v1/templates/:id`, or `GET /v1/gallery/:id` for `gallery:*` ids | the sample data JSON, so the model can shape `data` correctly |

Error handling: HTTP errors are returned as **tool results with text**, not thrown, so the model can explain them.
A 402 `quota_exceeded` comes back as e.g. "Monthly quota used (2,500 of 2,500). Upgrade: <upgrade_url>". 429 and
503 include the `Retry-After` value. `out_path` must be an absolute path; refuse to overwrite a non-PDF file.

### Client configuration (for the package README)

Claude Desktop (`claude_desktop_config.json`) and Cursor (`.cursor/mcp.json`) use the same shape:

```json
{
  "mcpServers": {
    "docforge": {
      "command": "npx",
      "args": ["-y", "docforge-mcp"],
      "env": {
        "DOCFORGE_API_KEY": "df_live_...",
        "DOCFORGE_URL": "https://<domain>"
      }
    }
  }
}
```

### Distribution

- [ ] Publish to npm.
- [ ] Submit to the official MCP registry, Smithery, Glama and mcp.so, each linking `https://<domain>/?ref=<registry>`.
- [ ] Add an "Use from Claude/Cursor (MCP)" section to `public/docs.html` and a guide page.

### Done when

The package lists gallery templates, creates a template from `gallery:invoice`, renders it to a file and reports
the remaining renders, against both a free and a paid key, with tests that mock `fetch`.

---

## 2. Template editor: `public/editor.html`

### Why

Competitor reviews single out visual/live-preview editing as the feature people value most. A preview that costs
nothing to serve keeps the free tier cheap.

### Shape

- One static page, `public/editor.html`, using `/assets/site.js` like every other page.
- Three textareas (HTML, CSS, JSON data) and a preview pane: an `<iframe sandbox>` whose `srcdoc` is rebuilt on
  input (debounced ~300 ms).
- Preview is compiled **in the browser** with Handlebars **4.7.8** from a CDN (pinned version, SRI hash). The server
  pins `handlebars@^4.7.10`, so check the preview matches the server output on the gallery templates before launch.
- The helpers (`money`, `date`, `sum`, `qr`, `fixed`, `add`, `sub`, `mul`, `div`, `percent`, `eq`, `gt`, `upper`,
  `lower`, `default`, `inc`) are **extracted from `src/render.js` into a shared module** that both the server and
  the editor load, so preview and PDF can't drift. That module is the one deliberate new `src/` file (or a file
  under `public/assets/` that `src/render.js` requires); `qr` needs a browser-compatible QR encoder, or the preview
  shows a placeholder box of the right size.
- The preview is an approximation (no page breaks, header/footer or margins); the page says so.

### Actions

- **Start from gallery:** loads a gallery template's html/css/sample data into the textareas.
- **Render real PDF:** calls `POST /v1/render` with the user's API key (kept in `sessionStorage`, never
  `localStorage`) and shows the PDF. **This is metered**: it counts against the monthly quota like any render, and
  the button says so. Without a key, it falls back to the public watermarked demo where the demo allows inline html,
  or prompts signup (`/?ref=editor#signup`).
- **Save as template:** `POST /v1/templates` (or `PUT` when editing an existing id). A 402 `template_limit` shows the
  `upgrade_urls`.

### What not to build

No unmetered server-side preview endpoint: it would be a free, unlimited PDF renderer, and abusers would find it.

**Alternative considered:** a `test: true` flag on `POST /v1/render` that renders a watermarked PDF without using
quota, limited to 50 per hour per account. This gives exact output fidelity for the preview at the cost of server
CPU and a new limit to maintain. Revisit only if users report preview/PDF mismatches the client preview can't fix.

### Done when

All five gallery templates load, preview, render and save from the editor; the helper module is shared and the
existing render tests still pass unchanged.
