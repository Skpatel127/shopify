import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import fileUpload from 'multer';
import helmet from 'helmet';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { buildReliefPrompt, getPreviewSpec } from './preview.mjs';
import { verifyAppProxyRequest } from './security.mjs';

const app = express();
const port = Number.parseInt(process.env.PORT || '8787', 10);
const host = process.env.HOST || '0.0.0.0';
const sharedSecret = process.env.SHOPIFY_API_SECRET || '';
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const model = process.env.GEMINI_MODEL || 'gemini-nano-banana-2.1';
const maxUploadBytes = 10 * 1024 * 1024;
const jobTtlMs = Math.max(1, Number.parseInt(process.env.JOB_TTL_MINUTES || '15', 10)) * 60_000;
const maxJobs = Math.max(1, Number.parseInt(process.env.MAX_IN_MEMORY_JOBS || '20', 10));
const jobs = new Map();
const allowedMimes = new Set(['image/jpeg', 'image/png', 'image/webp']);

const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS || '0', 10);
if (Number.isInteger(trustProxyHops) && trustProxyHops >= 0) {
  app.set('trust proxy', trustProxyHops);
}

app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));

const previewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Math.max(1, Number.parseInt(process.env.PREVIEW_MAX_PER_HOUR || '3', 10)),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Preview limit reached. Please try again later.' },
});

const upload = fileUpload({
  storage: fileUpload.memoryStorage(),
  limits: { fileSize: maxUploadBytes, files: 2, fields: 12, fieldSize: 1024 },
});
const acceptArtworkAndReference = upload.fields([
  { name: 'artwork', maxCount: 1 },
  { name: 'reference', maxCount: 1 },
]);

function appProxyAuth(req, res, next) {
  if (!sharedSecret) {
    return res.status(503).json({ error: 'Shopify App Proxy is not configured on this server.' });
  }
  const context = verifyAppProxyRequest(req.originalUrl, sharedSecret);
  if (!context) return res.status(401).json({ error: 'Shopify App Proxy signature is invalid or expired.' });
  req.shopifyProxy = context;
  next();
}

function pruneExpiredJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expiresAt <= now) jobs.delete(id);
  }
}

async function normalizeUploadedImage(file, label) {
  if (!file?.buffer?.length) throw Object.assign(new Error(`${label} image is required.`), { status: 400 });
  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected || !allowedMimes.has(detected.mime)) {
    throw Object.assign(new Error(`${label} must be a JPG, PNG or WebP image.`), { status: 400 });
  }

  try {
    // Re-encoding strips EXIF/location metadata and caps decoded size before provider upload.
    return await sharp(file.buffer, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#f8f4ed' })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    throw Object.assign(new Error(`${label} image could not be decoded.`), { status: 400 });
  }
}

function outputImageFrom(responseBody) {
  const direct = responseBody?.output_image ?? responseBody?.interaction?.output_image;
  if (direct?.data) return direct;
  const blocks = Array.isArray(responseBody?.output) ? responseBody.output : [];
  const imageBlock = [...blocks].reverse().find((block) => block?.type === 'image');
  return imageBlock?.image ?? imageBlock ?? null;
}

async function generateOnePreview(subjectBuffer, referenceBuffer, spec) {
  // Exactly one provider request and a fixed 1K response. Never retry automatically.
  const input = [
    { type: 'text', text: buildReliefPrompt(spec) },
    { type: 'image', mime_type: 'image/jpeg', data: subjectBuffer.toString('base64') },
  ];
  if (referenceBuffer) {
    input.push({ type: 'image', mime_type: 'image/jpeg', data: referenceBuffer.toString('base64') });
  }

  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': geminiApiKey,
    },
    body: JSON.stringify({
      model,
      input,
      response_format: {
        type: 'image',
        mime_type: 'image/jpeg',
        aspect_ratio: spec.aspectRatio,
        image_size: '1K',
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Do not return provider response details or credentials to the storefront.
    throw new Error(`Gemini request failed with HTTP ${response.status}`);
  }

  const image = outputImageFrom(body);
  if (!image?.data || typeof image.data !== 'string') throw new Error('Provider returned no image.');
  const mime = allowedMimes.has(image.mime_type) ? image.mime_type : 'image/jpeg';
  const imageBytes = Buffer.from(image.data, 'base64');
  if (!imageBytes.length || imageBytes.length > 15 * 1024 * 1024) throw new Error('Provider image size is invalid.');
  return `data:${mime};base64,${imageBytes.toString('base64')}`;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/apps/relief-preview', appProxyAuth, previewLimiter, acceptArtworkAndReference, async (req, res, next) => {
  try {
    if (!geminiApiKey) return res.status(503).json({ error: 'Image generation is not configured on this server.' });
    if (String(req.body?.consent).toLowerCase() !== 'true') {
      return res.status(400).json({ error: 'Please confirm the image-use notice before requesting a preview.' });
    }

    const files = req.files || {};
    const artworkFile = files.artwork?.[0];
    const referenceFile = files.reference?.[0] || null;
    if (!artworkFile) return res.status(400).json({ error: 'Choose an artwork image first.' });

    let spec;
    try {
      spec = getPreviewSpec(req.body, { hasReference: Boolean(referenceFile) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    pruneExpiredJobs();
    if (jobs.size >= maxJobs) return res.status(503).json({ error: 'Preview capacity is busy. Please try again shortly.' });

    const jobId = randomUUID();
    const job = {
      shop: req.shopifyProxy.shop,
      customerId: req.shopifyProxy.customerId,
      status: 'processing',
      previewDataUrl: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + jobTtlMs,
      error: null,
    };
    jobs.set(jobId, job);
    res.status(202).json({ job_id: jobId, status: 'queued' });

    // Work continues after the 202 response to avoid holding the app-proxy request open.
    void (async () => {
      try {
        const subject = await normalizeUploadedImage(artworkFile, 'Artwork');
        const reference = referenceFile
          ? await normalizeUploadedImage(referenceFile, 'Colour reference')
          : null;
        job.previewDataUrl = await generateOnePreview(subject, reference, spec);
        job.status = 'ready';
      } catch (error) {
        console.error(`[preview ${jobId}] generation failed:`, error?.message || 'unknown error');
        job.status = 'failed';
        job.error = 'The preview could not be created. Please try again later.';
      }
    })();
  } catch (error) {
    next(error);
  }
});

app.get('/apps/relief-preview/:jobId', appProxyAuth, (req, res) => {
  pruneExpiredJobs();
  const job = jobs.get(req.params.jobId);
  if (!job || job.shop !== req.shopifyProxy.shop) return res.status(404).json({ error: 'Preview job not found.' });
  if (job.customerId && job.customerId !== req.shopifyProxy.customerId) {
    return res.status(404).json({ error: 'Preview job not found.' });
  }
  if (job.status === 'processing') return res.json({ status: 'processing' });
  if (job.status === 'failed') return res.json({ status: 'failed', message: job.error });
  return res.json({
    status: 'ready',
    preview_data_url: job.previewDataUrl,
    expires_at: new Date(job.expiresAt).toISOString(),
  });
});

app.use((error, _req, res, _next) => {
  if (error instanceof fileUpload.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Each image must be no larger than 10 MB.'
      : 'The upload contains too many or too-large fields.';
    return res.status(400).json({ error: message });
  }
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) console.error('[request] failed:', error?.message || 'unknown error');
  return res.status(status).json({ error: status >= 500 ? 'The preview request failed.' : error.message });
});

app.listen(port, host, () => {
  console.log(`Relief preview backend listening on http://${host}:${port}`);
  console.log('AI generation is inactive until GEMINI_API_KEY and Shopify App Proxy settings are configured.');
});
