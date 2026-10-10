# Private AI preview backend scaffold

This is a **starter scaffold**, not a deployed service. It is deliberately separate from Shopify theme JavaScript and keeps provider credentials on the server.

## One image per request

- A valid `POST /apps/relief-preview` makes **one** Gemini image request and asks for **one 1K output**. It does not make four automatic variants and does not retry a failed provider call.
- A customer gets another image only by explicitly submitting another request. That is another billable generation.
- The selected model default is Gemini Nano Banana 2.1 for benchmarking; confirm the model, pricing, output fidelity and privacy terms before launch. It is not a guarantee that this provider is the final choice.
- Approximate output-only price checked 10 October 2026: US$0.0336 (about ₹3.25 at an indicative ₹96.61/US$). Input tokens, taxes/FX, hosting, retries and other costs are extra; each regenerate incurs a new output charge.

## Local setup

1. Install Node.js 20 or newer.
2. From this directory, run `npm install`.
3. Copy `.env.example` to `.env` and fill secrets **on the server only**. Do not put keys in `index.html`, commit `.env`, or paste keys into chat.
   - `SHOPIFY_API_SECRET`: the Shopify app's shared/client secret, used to validate App Proxy signatures.
   - `GEMINI_API_KEY`: the provider key. The app makes no paid provider calls until this is set and a valid signed request reaches the generation endpoint.
4. Configure a Shopify App Proxy to forward `/apps/relief-preview` and `/apps/relief-preview/*` to this service over HTTPS. The route verifies Shopify's signed query parameters and rejects unsigned/expired requests.
5. Run `npm start`. `GET /health` is a basic liveness check. The storefront HTML in this starter is **not wired to this backend yet**; production theme/app-proxy configuration is still required.
6. Run `npm test` for the signature and prompt tests.

Never share an API key in chat. If you later add a real key, add it to the hosting provider's secret manager/environment settings, not to the ZIP or browser code.

## Request contract

Send `multipart/form-data` through the Shopify App Proxy:

- `artwork` — required JPG, PNG or WebP, maximum 10 MB.
- `reference` — optional colour-reference JPG, PNG or WebP, maximum 10 MB.
- `palette` — `source`, `royal`, `peacock`, `garden`, `reference`, or `custom`.
- `customColor` — required as `#RRGGBB` when `palette=custom`.
- `shape` — `round`, `square`, `landscape`, `portrait`, or `arch`.
- `lightDirection` — `upper-left`, `upper-right`, `side`, or `front`.
- `lightStrength` — integer from 20 to 100.
- `consent` — must be `true` after the customer sees the upload/use notice.

The first request returns `202 { "job_id": "...", "status": "queued" }`. Poll the same proxy with `GET /apps/relief-preview/{job_id}`. It returns `processing`, `failed`, or `ready`; a ready response contains one temporary `preview_data_url` and an expiry time.

## Important prototype limits before production

- Uploads are re-encoded in memory to strip EXIF/location metadata. Original uploads are not written to disk. The generated preview is kept in process memory for 15 minutes by default, then pruned.
- Jobs and rate limits use in-memory stores. They are lost on restart and are not shared between server instances. Add a durable queue, shared rate-limit store, short-lived object storage, deletion policy and monitoring before scaling.
- Configure `TRUST_PROXY_HOPS` to match the actual host's proxy chain. Do not blindly trust forwarded headers. The default limit is three preview requests per IP per hour; tune it only after testing customer/IP behavior.
- Add production moderation, abuse prevention, robust customer-session binding, alerting and a reviewed privacy/retention notice. The sample consent checkbox is only a technical gate, not legal advice.
- The preview is an illustration—not a CAD model, depth map, manufacturing proof or promise about a finished physical item. Add artisan approval and final feasibility checks.
- A request can still incur provider costs if a client disconnects after submitting. No automatic retries are made; configure provider quotas and billing alerts before launch.

For current model details, use Google's official [image editing documentation](https://ai.google.dev/gemini-api/docs/image-generation) and [pricing page](https://ai.google.dev/gemini-api/docs/pricing). Shopify App Proxy authentication details are in [Shopify's docs](https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies).
