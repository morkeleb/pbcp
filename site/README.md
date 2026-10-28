# site

The protocol's documentation site: a static site built with Astro to `site/dist` and published with GitHub Pages. It is not a package and not part of the pnpm workspace; it has its own lockfile, and the repository's build, typecheck and tests do not touch it.

| Path | From |
| --- | --- |
| `/` | the protocol on one screen; §1's problem and §3's example card are read from the RFC |
| `/rfc/` | the newest `rfc/pbcp-draft-*.md`, rendered with a table of contents, an anchor per heading, and `§` references linked |
| `/rfc.md` | the same file, byte for byte |
| `/changelog/` | `rfc/CHANGELOG.md`, with `§` references pointing at the current draft |
| `/producers/` | the three values, a first card from `curlSnippet` and the environment from `producerConfig` (both `@pbcp/client`, read from source), and a link to each connector's generated Setup section |
| `/connectors/` | one row per `connectors/*/README.md`: its first paragraph, and the first column of its Configuration (or Credentials) table, else the variables its first shell block exports |
| `/heads/` | what a head is, the conformance suite, the reference head |
| `/llms.txt` | a short index for agents |

Everything is read from the repository when the site is built, so a change to the RFC, the changelog or a connector README shows up on the next deploy without touching `site/`.

## Building

Node 22.23.4 or later (the workflow uses 24).

```sh
pnpm install      # at the repository root: the site reads @pbcp/core and @pbcp/client from source
cd site
pnpm install --ignore-workspace
pnpm build        # → site/dist
pnpm preview      # serves dist under its base path, e.g. http://localhost:4321/pbcp/
```

`--ignore-workspace` keeps the site out of the repository's pnpm workspace, so it installs from `site/pnpm-lock.yaml` alone.

## Settings

All optional, read from the environment at build time (`src/config.ts`). In the workflow they come from repository variables of the same name.

| Variable | Default | |
| --- | --- | --- |
| `SITE_URL` | `https://morkeleb.github.io/pbcp`, or `https://$CUSTOM_DOMAIN` when that is set | where the site is published; every internal link is made under its path |
| `CUSTOM_DOMAIN` | – | a custom domain; the build writes `public/CNAME` with it (and removes the file when it is unset) |
| `HEAD_OPENAPI_URL` | `https://pbcp.vercel.app/api/openapi.json` | the reference head's OpenAPI document, linked from `/llms.txt` and `/heads/` |

## Turning Pages on

Once, for the repository:

1. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
2. Push to `main`, or run the **Pages** workflow by hand (Actions → Pages → Run workflow).

`.github/workflows/pages.yml` builds the site and deploys it with `actions/deploy-pages`. It is the repository's only workflow and does nothing but publish the site. The site is then at `https://morkeleb.github.io/pbcp/`.

## A custom domain, later

1. At the DNS provider, point the domain at GitHub Pages: a `CNAME` record to `morkeleb.github.io` for a subdomain (`pbcp.example.org`). For an apex domain, use `A` records to GitHub's Pages addresses, listed in GitHub's documentation under "Managing a custom domain for your GitHub Pages site".
2. Settings → Secrets and variables → Actions → Variables: add `CUSTOM_DOMAIN` with the domain. `SITE_URL` follows it unless set.
3. Run the Pages workflow. The build writes the `CNAME` file and links from the domain's root.
4. Settings → Pages → Custom domain: enter the same domain, wait for the DNS check, then tick **Enforce HTTPS**.

To go back, delete the `CUSTOM_DOMAIN` variable, clear the custom domain in Settings → Pages, and run the workflow again.
