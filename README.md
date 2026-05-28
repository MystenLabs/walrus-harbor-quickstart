# walrus-harbor-quickstart

Everything you need to start building on the **Harbor API**.

> **Alpha · Testnet only.** Endpoint shapes may change before mainnet GA. Do not put
> production data behind this.

---

## What is Harbor?

Harbor is decentralized file storage with a simple, Web2-friendly REST API. Files live in
**buckets**, encrypted client-side with [Seal](https://github.com/MystenLabs/seal) and
stored on [Walrus](https://www.walrus.xyz/) — Harbor only ever holds ciphertext, never
your plaintext or decryption keys. Auth is a simple `Authorization: Bearer hbr_…` API
key minted in the web app; gas for on-chain steps is sponsored for you via Enoki.

If you can call a REST endpoint, you can build on Harbor.

> **Note.** Building directly on the REST API today means you orchestrate the client-side
> encryption yourself — the reserve → sign → finalize and Seal encrypt/decrypt steps you'll
> see in this quickstart. A TypeScript SDK to streamline building on Harbor (this
> orchestration included) is on the roadmap.

## Who this repo is for

- **Hackathon participants** following the live build-along — clone or fork this repo and
  code along.
- **Any developer** who wants the curated API surface (OpenAPI + Postman) and a copy-paste
  quickstart to integrate Harbor.

## What's in here

| Path                             | What it is                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`QUICKSTART.md`](QUICKSTART.md) | "Hello world" tour — sign up, create an encrypted bucket, upload + download a file. Start here. |
| [`openapi.yaml`](openapi.yaml)   | Curated OpenAPI spec — the public, Bearer-only API surface (11 endpoints).                      |
| [`postman/`](postman/)           | Ready-to-import Postman collection + environment for poking the API by hand.                    |
| [`app/`](app/)                   | TypeScript reference integration: curl walkthrough, helper CLIs, automated round-trip, Hono backend. |
| [`AGENTS.md`](AGENTS.md)         | Repo-level guidance for AI coding assistants (loaded by `CLAUDE.md`).                           |

## Quickstart

Prerequisites: a way to sign in to the web app to mint an API key — Google (via zkLogin)
is the quickest path; a Sui wallet also works — plus `curl`/Postman or Node.js. See
[`QUICKSTART.md`](QUICKSTART.md) for exact versions.

1. Sign in at **[testnet.harbor.walrus.xyz](https://testnet.harbor.walrus.xyz/)** —
   Google (via zkLogin) is the quickest path; a Sui wallet also works. Your account and a
   Personal Space are provisioned automatically.
2. **Settings → API Keys → New API key**, pick the `read_write` role, and copy the
   `hbr_…` key — it is shown **once**.
3. Follow [`QUICKSTART.md`](QUICKSTART.md) to create a Seal-encrypted bucket and round-trip
   a file.

### Poke the API with Postman

Import both files from [`postman/`](postman/) into Postman Desktop:

- `postman/harbor.postman_collection.json`
- `postman/harbor.postman_environment.json`

Paste your `hbr_…` key into the `bearerToken` environment variable. `baseUrl` defaults to
`https://api.testnet.harbor.walrus.xyz`.

## Hosted docs

The same docs are served live from the API:

- Quickstart (HTML): <https://api.testnet.harbor.walrus.xyz/docs/quickstart>
- OpenAPI viewer (Scalar): <https://api.testnet.harbor.walrus.xyz/docs/openapi>
- OpenAPI spec (raw): <https://api.testnet.harbor.walrus.xyz/openapi.yaml>
- Docs index: <https://api.testnet.harbor.walrus.xyz/docs>

## Questions / issues

Open an issue: **[github.com/MystenLabs/walrus-harbor-quickstart/issues](https://github.com/MystenLabs/walrus-harbor-quickstart/issues)**

## License

See [LICENSE](LICENSE).
