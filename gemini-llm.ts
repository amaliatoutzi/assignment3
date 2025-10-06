/**
 * LLM Integration (Gemini)
 * Minimal wrapper used by Spotlight+AI concept.
 */
import crypto from 'node:crypto';

export interface Config {
  apiKey: string;
  timeoutMs?: number;   // default 10000
}

const MEMO_TTL_MS = 15_000;
const MAX_RETRIES = 2;
const BACKOFF_MS = 500;

const memo: Map<string, { at: number; text: string }> = new Map();

function promptKey(model: string, prompt: string) {
  return crypto.createHash('sha256').update(model + '::' + prompt).digest('base64url');
}

function getMemo(key: string) {
  const hit = memo.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MEMO_TTL_MS) { memo.delete(key); return null; }
  return hit.text;
}

function setMemo(key: string, text: string) {
  memo.set(key, { at: Date.now(), text });
}

export class GeminiLLM {
  constructor(private cfg: Config) {}

  async executeLLM(prompt: string, modelName = 'gemini-2.5-flash-lite'): Promise<string> {
    const key = promptKey(modelName, prompt);
    const cached = getMemo(key);
    if (cached) return cached; // idempotent within TTL

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(this.cfg.apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { maxOutputTokens: 1000 },
    });

    let attempt = 0, delay = BACKOFF_MS;
    while (true) {
      attempt++;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), this.cfg.timeoutMs ?? 10_000);

      try {
        const res = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }]}]}, { signal: ctl.signal });
        clearTimeout(t);
        const text = res.response.text();
        setMemo(key, text);
        return text;
      } catch (err: any) {
        clearTimeout(t);
        const msg = String(err?.message || err);
        const code = String(err?.status || err?.code || '').toUpperCase();
        const isTimeout = err?.name === 'AbortError' || /abort|timeout/i.test(msg);
        const isTransient = isTimeout || /(429|500|502|503|504)/.test(code);

        if (attempt > 1 + MAX_RETRIES || !isTransient) {
          const label = isTimeout ? `LLM_TIMEOUT` : (isTransient ? `LLM_TRANSIENT_${code || 'UNKNOWN'}` : `LLM_ERROR`);
          throw new Error(`${label}: ${msg}`);
        }
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 4_000);
      }
    }
  }
}
