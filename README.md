# Nuvio AI

Private AI-enhanced stream intelligence addon for Nuvio.

## v0.4

Nuvio AI now acts as a fast stream intelligence layer rather than a basic filter:

- Fast-first upstream response with a short merge grace window
- Parallel upstream aggregation
- Smart duplicate/release collapsing
- Quality normalization across resolution, source, codec, audio and HDR
- Seeder and file-size aware scoring when metadata exists
- Gemini 3.8 Flash ranking for ambiguous cases
- Gemini receives sanitized release metadata, not stream URLs
- Short AI cache plus longer result cache
- Stale-while-revalidate for faster repeat opens
- Last-good response fallback when an upstream temporarily fails
- Multiple upstream addon support
- Automatic result labels and stable binge groups
- Health endpoint at `/healthz`
- Apple TV-inspired dashboard at `/ui` (and in browsers at `/`)
- Response timing and cache headers for diagnostics

The addon does not proxy or transcode media. It returns the original stream objects and improves their order and selection.

## Configuration

Set `GEMINI_API_KEY` only on the hosting provider. Never commit it to GitHub.

Recommended defaults:

- `GEMINI_MODEL=gemini-3.8-flash`
- `GEMINI_THINKING_LEVEL=low`
- `MAX_STREAMS=6`
- `MAX_UPSTREAMS=4`
- `UPSTREAM_TIMEOUT_MS=5000`
- `FAST_RETURN_MS=250`
- `CACHE_TTL_MS=20000`

### Configure for Nuvio

1. Open `/configure` on your deployed Render service.
2. Paste the configured manifest URL of your source addon (for example, your own configured Torrentio, Comet, or AIOStreams URL).
3. Generate the configured Nuvio AI URL.
4. Copy that generated URL into Nuvio → Add Addon. Do not install the unconfigured root `/manifest.json` URL.

Nuvio's native addon manifest parser does not expose the standard `config` form fields, so the settings are carried in the standard Base64URL path prefix instead. The server serves both `/manifest.json` and `/{encoded-config}/manifest.json`.

`UPSTREAM_STREAM_ADDON_URL` remains an optional Render environment-variable fallback. If it is set, it can be used without per-install URL configuration.

The upstream fetch timeout defaults to 5 seconds and covers the response body, not just response headers. Upstream failures and zero-result responses are logged with the host and title ID in Render logs.

## Run

npm install
npm start

Manifest:
http://localhost:7000/manifest.json

Health:
http://localhost:7000/healthz
