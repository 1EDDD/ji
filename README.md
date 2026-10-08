# Nuvio AI

Private AI-enhanced stream intelligence addon for Nuvio.

## v0.2

Nuvio AI now acts as a fast stream intelligence layer rather than a basic filter:

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

The addon does not proxy or transcode media. It returns the original stream objects and improves their order and selection.

## Configuration

Set `GEMINI_API_KEY` only on the hosting provider. Never commit it to GitHub.

Recommended defaults:

- `GEMINI_MODEL=gemini-3.8-flash`
- `GEMINI_THINKING_LEVEL=low`
- `MAX_STREAMS=6`
- `MAX_UPSTREAMS=4`
- `UPSTREAM_TIMEOUT_MS=2500`
- `CACHE_TTL_MS=20000`

The addon can receive an upstream URL through its Nuvio configuration page. The server environment variable `UPSTREAM_STREAM_ADDON_URL` is kept as a fallback.

## Run

npm install
npm start

Manifest:
http://localhost:7000/manifest.json

Health:
http://localhost:7000/healthz
