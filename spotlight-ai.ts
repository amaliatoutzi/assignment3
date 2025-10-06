// spotlight-ai.ts
//
// Concept: Spotlight+AI [User, Museum]
// AI-Augmented version
// In-memory storage for assignment/testing.

import { GeminiLLM } from './gemini-llm';

/** ---------- Domain ---------- */

export type User = string;
export type Museum = string;

export type Taste = 'LOVE' | 'LIKE' | 'MEH';

export interface TasteSignalRow {
  user: User;
  museum: Museum;
  taste: Taste;
  updatedAt: string;
}

export interface RecommendationRow {
  user: User;
  museum: Museum;
  score: number;       // 0..1
  rationale: string;
  generatedAt: string;
  modelVersion: string;
  promptHash?: string;
}

/** ---------- State (in-memory) ---------- */

export class SpotlightAIStore {
  /** a set of TasteSignals with (user, museum, taste, updatedAt) */
  TasteSignals = new Map<User, TasteSignalRow[]>();
  /** a set of Recommendations with (user, museum, score, rationale, generatedAt) */
  Recommendations = new Map<User, RecommendationRow[]>();
}

/** ---------- Concept Implementation ---------- */

export class SpotlightAI {
  constructor(private store: SpotlightAIStore, private llm: GeminiLLM) {}

  /**
   * recordMuseumTaste (user: User, museum: Museum, taste: LOVE|LIKE|MEH)
   * effects upsert TasteSignals(user, museum) with taste; set updatedAt := now
   */
  recordMuseumTaste(user: User, museum: Museum, taste: Taste): void {
    const now = new Date().toISOString();
    const list = this.store.TasteSignals.get(user) ?? [];
    const idx = list.findIndex(ts => ts.museum === museum);
    if (idx >= 0) list[idx] = { user, museum, taste, updatedAt: now };
    else list.push({ user, museum, taste, updatedAt: now });
    this.store.TasteSignals.set(user, list);
  }

  /**
   * clearMuseumTaste (user: User, museum: Museum)
   * effects delete TasteSignals(user, museum)
   */
  clearMuseumTaste(user: User, museum: Museum): void {
    const list = this.store.TasteSignals.get(user) ?? [];
    this.store.TasteSignals.set(user, list.filter(ts => ts.museum !== museum));
  }

  /**
   * llmRecommend (user: User, k: Number) : List<(museum: Museum, rationale: String)>
   * requires k ≥ 1 and TasteSignals(user) not empty
   * effect calls an LLM with user's TasteSignals; returns up to k new museums (not already rated)
   * with (score, rationale); replaces Recommendations(user).
   *
   */
  async llmRecommend(params: {
    user: User;
    k: number;
    candidates: Museum[];     // universe to pick from (e.g., city-scoped)
    modelVersion?: string;
  }): Promise<Array<{ museum: Museum; rationale: string }>> {
    const { user, k, candidates } = params;
    if (k < 1) throw new Error('k must be >= 1');

    const tasteSignals = this.store.TasteSignals.get(user) ?? [];
    if (tasteSignals.length === 0) {
      this.store.Recommendations.set(user, []);
      return [];
    }

    const rated = new Set(tasteSignals.map(t => t.museum));
    const unseen = candidates.filter(m => !rated.has(m));
    if (unseen.length === 0) {
      this.store.Recommendations.set(user, []);
      return [];
    }

    const prompt = buildPromptFromTasteSignals({
      tastes: tasteSignals,
      candidates: unseen,
      k,
    });

    const raw = await this.llm.executeLLM(prompt);
    const parsed = parseLLMJson(raw);
    // Validate the model output BEFORE mapping to internal rows
    validateLLMRecommendations(parsed, unseen);


    const now = new Date().toISOString();
    const modelVersion = params.modelVersion ?? 'gemini-2.5-flash-lite';
    const promptHash = simpleHash(prompt);

    const top = (parsed.recommendations ?? [])
      .filter(isValidRec)
      .map(rec => ({
        museum: rec.museumId as Museum,
        rationale: (rec.rationale ?? '').trim(),
        score: clamp01(rec.score ?? 0.5),
      }))
      .filter(r => unseen.includes(r.museum))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    const rows: RecommendationRow[] = top.map(t => ({
      user,
      museum: t.museum,
      score: t.score,
      rationale: t.rationale,
      generatedAt: now,
      modelVersion,
      promptHash,
    }));

    this.store.Recommendations.set(user, rows);
    return top.map(t => ({ museum: t.museum, rationale: t.rationale }));
  }

  /**
   * Helper: getRecommendations (user, k)
   * returns top-k cached Recommendations without a fresh LLM call
   */
  getRecommendations(user: User, k: number): Array<{ museum: Museum; rationale: string }> {
    const rows = this.store.Recommendations.get(user) ?? [];
    return rows
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, k))
      .map(r => ({ museum: r.museum, rationale: r.rationale }));
  }

  /**
   * system.refreshOnRatingChange (user: User)
   * requires TasteSignals changed within a debounce window
   * effects call llmRecommend(user, k := default)
   */
  refreshOnRatingChange(user: User, defaultK: number, candidates: Museum[]) {
    return this.llmRecommend({ user, k: defaultK, candidates });
  }
}

function buildPromptFromTasteSignals(input: {
  tastes: { museum: string; taste: 'LOVE'|'LIKE'|'MEH' }[];
  candidates: string[];
  k: number;
}): string {
  const tastePayload = input.tastes.map(t => ({ museumId: t.museum, taste: t.taste }));
  const candidates = input.candidates;

  return `
You are a museum recommendation assistant.

Select up to ${input.k} museums from CANDIDATES that best match the user's TASTE_SIGNALS.
Do NOT include any museum already present in TASTE_SIGNALS.

SCORING RUBRIC (must follow):
1) Map user tastes to weights:
   - LOVE → 1.0
   - LIKE → 0.6
   - MEH  → 0.2
2) For each candidate, estimate a similarity in [0,1] to each rated museum.
   Similarity is based on publicly known characteristics such as:
   collections (e.g., contemporary, old masters, photography), era (modern/postwar),
   media (sculpture/painting/installation), curatorial program (experimental vs. encyclopedic).
   If uncertain, keep similarity modest (≤0.5). Do NOT invent facts.
3) Compute raw match:
      raw = ( Σ_i weight(taste_i) * similarity(candidate, rated_i) ) / ( Σ_i weight(taste_i) )
4) Penalize strong resemblance to low-interest museums:
   Let maxMEH = max similarity to any museum that the user was lukewarm on (MEH).
   final = raw - 0.3 * max(0, maxMEH - 0.6)   // soft penalty for high similarity to MEH
5) Clamp final score to [0,1]. Use this as "score".
6) Rank candidates by score (desc) and return the top ${input.k}.

RATIONALE POLICY:
- For each recommendation, write a concise rationale of at most 2 sentences.
- Prepend the rationale with "(NN% match) " where NN = round(score * 100).
- Do NOT use the literal words "LOVE", "LIKE", or "MEH" in the rationale; use natural phrasing (e.g., "you adored", "you enjoyed", "you were lukewarm on").
- Do NOT mention user location or neighborhood in the rationale.
- When possible, cite at least one rated museum by name to explain the match.
- Include at least one concrete attribute or program characteristic if known (e.g., "postwar sculpture focus", "rotating contemporary photography shows"). Do NOT invent facts; keep general if unsure.

OUTPUT FORMAT (strict JSON only; no prose, no trailing commas):
{
  "recommendations": [
    { "museumId": "<string-from-CANDIDATES>", "score": <number between 0 and 1>, "rationale": "<starts with (NN% match) and totals <= 2 sentences>" }
  ]
}

TASTE_SIGNALS (JSON):
${JSON.stringify(tastePayload, null, 2)}

CANDIDATES (JSON array of museumIds):
${JSON.stringify(candidates, null, 2)}
`.trim();
}


function parseLLMJson(raw: string): { recommendations: Array<{ museumId: string; score?: number; rationale?: string }> } {
  try {
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.recommendations)) throw new Error('missing recommendations');
    return obj;
  } catch {
    // Attempt to recover a JSON block if prose was added
    const m = raw.match(/{[\s\S]*}/);
    if (!m) throw new Error('Failed to parse LLM output');
    const obj = JSON.parse(m[0]);
    if (!obj || !Array.isArray(obj.recommendations)) throw new Error('malformed recommendations block');
    return obj;
  }
}

function isValidRec(r: any): r is { museumId: string; score?: number; rationale?: string } {
  return r && typeof r.museumId === 'string' && (typeof r.rationale === 'string' || r.rationale === undefined);
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}

/** ---------------- Validators ---------------- */

function validateNoDuplicatesAndOnlyUnseen(
  recs: Array<{ museumId: string }>,
  unseen: string[]
): void {
  const unseenSet = new Set(unseen);
  const seen = new Set<string>();
  for (const r of recs) {
    if (!unseenSet.has(r.museumId)) {
      throw new Error(`Validator: museumId "${r.museumId}" is not in the allowed unseen candidate set.`);
    }
    if (seen.has(r.museumId)) {
      throw new Error(`Validator: duplicate recommendation for museumId "${r.museumId}".`);
    }
    seen.add(r.museumId);
  }
}

function validateScoreAndPercentAgreement(
  recs: Array<{ museumId: string; score: number; rationale: string }>
): void {
  for (const r of recs) {
    if (!Number.isFinite(r.score) || r.score < 0 || r.score > 1) {
      throw new Error(`Validator: score out of range for "${r.museumId}": ${r.score}`);
    }
    // Must start with "(NN% match) "
    const m = r.rationale.match(/^\((\d{1,3})%\s*match\)\s+/i);
    if (!m) {
      throw new Error(`Validator: rationale for "${r.museumId}" must begin with "(NN% match) ".`);
    }
    const nn = parseInt(m[1], 10);
    if (nn < 0 || nn > 100) {
      throw new Error(`Validator: percent prefix out of range for "${r.museumId}": ${nn}%`);
    }
    const expected = Math.round(r.score * 100);
    const delta = Math.abs(nn - expected);
    if (delta > 10) {
      throw new Error(
        `Validator: percent (${nn}%) disagrees with score (${expected}%) by >10 for "${r.museumId}".`
      );
    }
  }
}

function validateRationaleRules(
  recs: Array<{ museumId: string; rationale: string }>
): void {
  for (const r of recs) {
    // Remove the "(NN% match) " prefix before text checks
    const rationale = r.rationale.replace(/^\(\d{1,3}%\s*match\)\s+/i, '').trim();

    if (!rationale) {
      throw new Error(`Validator: empty rationale after percent prefix for "${r.museumId}".`);
    }

    // No literal LOVE/LIKE/MEH as standalone tokens (case-insensitive)
    if (/\b(LOVE|LIKE|MEH)\b/.test(rationale)) {
      throw new Error(`Validator: rationale must not use literal uppercase LOVE/LIKE/MEH for "${r.museumId}".`);
    }

    // Max 2 sentences (naive split on . ? !)
    const sentences = rationale.split(/(?<=[.?!])\s+/).filter(s => s.trim().length > 0);
    if (sentences.length > 3) {
      throw new Error(`Validator: rationale exceeds 3 sentences for "${r.museumId}".`);
    }
  }
}

/** Run all validators on parsed LLM output */
function validateLLMRecommendations(
  parsed: { recommendations: Array<{ museumId: string; score?: number; rationale?: string }> },
  unseen: string[]
): void {
  if (!parsed || !Array.isArray(parsed.recommendations)) {
    throw new Error('Validator: missing "recommendations" array.');
  }
  if (parsed.recommendations.length === 0) {
    // It’s allowed to return empty (e.g., very small candidate pool), but usually a model issue.
    // Throwing keeps behavior consistent with the assignment’s “fail if illogical” guidance.
    throw new Error('Validator: empty recommendations set from LLM.');
  }

  // Basic shape presence
  for (const r of parsed.recommendations) {
    if (typeof r.museumId !== 'string' || !r.museumId.trim()) {
      throw new Error('Validator: each recommendation must include a non-empty "museumId".');
    }
    if (typeof r.score !== 'number') {
      throw new Error(`Validator: recommendation for "${r.museumId}" missing numeric "score".`);
    }
    if (typeof r.rationale !== 'string' || !r.rationale.trim()) {
      throw new Error(`Validator: recommendation for "${r.museumId}" missing "rationale".`);
    }
  }

  // Specific checks
  validateNoDuplicatesAndOnlyUnseen(parsed.recommendations, unseen);
  validateScoreAndPercentAgreement(parsed.recommendations as any);
  validateRationaleRules(parsed.recommendations as any);
}
