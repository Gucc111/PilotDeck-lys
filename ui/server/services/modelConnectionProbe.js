import {
  buildProviderChatEndpointCandidates,
  isExpectedProviderResponseShape,
} from '../../../src/model/providerEndpoint.js';
import { NetworkFetchError, networkFetch } from '../../../src/network/fetch.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const TIMEOUT_MS = 10_000;
const uiRoot = path.basename(process.cwd()) === 'ui' ? process.cwd() : path.join(process.cwd(), 'ui');
const PROBE_IMAGE_DATA = readFileSync(
  path.join(uiRoot, 'server/assets/onboarding/image-capability-probe.png'),
).toString('base64');

function hasErrorFinish(body, protocol) {
  if (body?.error || body?.status === 'failed') return true;
  if (protocol === 'google') {
    return (body?.candidates || []).some((candidate) => String(candidate?.finishReason || '').toLowerCase() === 'error');
  }
  if (protocol === 'openai') {
    return (body?.choices || []).some((choice) => String(choice?.finish_reason || '').toLowerCase() === 'error');
  }
  return String(body?.stop_reason || '').toLowerCase() === 'error';
}

function isFallbackStatus(status) {
  return status === 400 || status === 404 || status === 405;
}

function responseDetail(responseText, response) {
  try {
    const body = JSON.parse(responseText);
    return body?.error?.message || body?.error?.type || body?.message || `${response.status} ${response.statusText}`;
  } catch {
    return responseText || `${response.status} ${response.statusText}`;
  }
}

function looksLikeImageUnsupported(detail) {
  return /(?:image|vision|multimodal).{0,60}(?:not supported|unsupported|not enabled|not available)|(?:not supported|unsupported).{0,60}(?:image|vision|multimodal)/i.test(detail);
}

function requestFor({ protocol, apiKey, model, image, maxTokens }) {
  const text = image ? 'Inspect this image and reply exactly: 1' : 'Reply exactly: 1';
  if (protocol === 'google') {
    return {
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: { contents: [{ role: 'user', parts: image
        ? [{ text }, { inlineData: { mimeType: 'image/png', data: PROBE_IMAGE_DATA } }]
        : [{ text }] }], generationConfig: { maxOutputTokens: maxTokens } },
    };
  }
  if (protocol === 'anthropic') {
    return {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: { model, max_tokens: maxTokens, messages: [{ role: 'user', content: image
        ? [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PROBE_IMAGE_DATA } }]
        : text }] },
    };
  }
  if (protocol === 'openai-responses') {
    return {
      headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'content-type': 'application/json' },
      body: { model, max_output_tokens: maxTokens, store: false, input: image
        ? [{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: `data:image/png;base64,${PROBE_IMAGE_DATA}` }] }]
        : text },
    };
  }
  return {
    headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'content-type': 'application/json' },
    body: { model, max_tokens: maxTokens, messages: [{ role: 'user', content: image
      ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PROBE_IMAGE_DATA}` } }]
      : text }] },
  };
}

/**
 * Executes one text or image probe without retaining API keys or upstream bodies.
 */
// Onboarding needs enough output budget for reasoning models to emit their
// visible answer. The legacy config endpoint passes its historical 8/16 value.
export async function probeModelConnection({ protocol, baseUrl, apiKey = '', model, image = false, maxTokens = 256 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new NetworkFetchError('network_timeout', 'Connection timed out.')), TIMEOUT_MS);
  try {
    const urls = buildProviderChatEndpointCandidates({ protocol, baseUrl, model });
    const request = requestFor({ protocol, apiKey, model, image, maxTokens });
    let last = null;
    for (const url of urls) {
      const response = await networkFetch(url, {
        method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal,
      }, {
        signal: controller.signal, fetchImpl: fetch,
        retry: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5_000, retryOnPost: true },
      });
      const responseText = await response.text();
      if (response.ok) {
        let body;
        try { body = JSON.parse(responseText); } catch { body = null; }
        if (isExpectedProviderResponseShape(protocol, body) && !hasErrorFinish(body, protocol)) {
          return { ok: true };
        }
        last = { detail: isExpectedProviderResponseShape(protocol, body)
          ? 'Endpoint returned an error finish status.'
          : 'The endpoint returned an invalid completion response.' };
        continue;
      }
      const detail = responseDetail(responseText, response);
      if (urls.length > 1 && isFallbackStatus(response.status)) {
        last = { detail };
        continue;
      }
      return { ok: false, imageUnsupported: image && looksLikeImageUnsupported(detail), error: detail };
    }
    return { ok: false, imageUnsupported: image && looksLikeImageUnsupported(last?.detail || ''), error: last?.detail || 'Connection failed.' };
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || error?.code === 'network_timeout';
    return { ok: false, imageUnsupported: false, error: timedOut ? 'Connection timed out after 10s.' : (error?.message || String(error)) };
  } finally {
    clearTimeout(timer);
  }
}
