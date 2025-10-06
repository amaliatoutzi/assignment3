/**
 * Spotlight+AI Test Cases (Final Prompt)
 *
 * Three scenarios:
 *  1) Cold start → first taste → AI recommendations
 *  2) Richer taste profile → refreshOnRatingChange
 *  3) LLM outage handling and fallback path
 *
 */

import { SpotlightAI, SpotlightAIStore } from './spotlight-ai';
import { GeminiLLM, Config } from './gemini-llm';

function loadConfig(): Config {
  try {
    const cfg = require('../config.json'); // { "apiKey": "..." }
    return cfg;
  } catch (err) {
    console.error('Error: Could not load ../config.json with your Gemini API key.');
    console.error('Details:', (err as Error).message);
    process.exit(1);
  }
}

function header(title: string) {
  console.log(`\n${title}\n${'='.repeat(title.length)}\n`);
}

function block(title: string, content: unknown) {
  console.log(title);
  console.log('-'.repeat(title.length));
  if (typeof content === 'string') console.log(content);
  else console.dir(content, { depth: null });
  console.log('');
}


// print cleaner
type Rec = { museum: string; rationale: string; score?: number };

function printRecsTable(title: string, recs: Rec[]) {
  console.log(`\n${title}`);
  console.log('='.repeat(title.length));
  if (!recs || recs.length === 0) {
    console.log('(none)\n');
    return;
  }

  // Extract "(NN% match)" from rationale; if absent, compute from score.
  function extractMatch(r: Rec): { pct: string; rationale: string } {
    const m = r.rationale.match(/^\((\d{1,3})% match\)\s*/i);
    if (m) {
      return { pct: `${m[1]}%`, rationale: r.rationale.slice(m[0].length) };
    }
    const pct = r.score != null ? `${Math.round(Math.max(0, Math.min(1, r.score)) * 100)}%` : '';
    return { pct, rationale: r.rationale };
  }

  // Simple word wrap for rationale to a reasonable width (no truncation).
  function wrap(text: string, width: number): string[] {
    const words = text.replace(/\s+/g, ' ').trim().split(' ');
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      if (!line.length) {
        line = w;
      } else if ((line + ' ' + w).length <= width) {
        line += ' ' + w;
      } else {
        lines.push(line);
        line = w;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  // Build row data
  const rows = recs.map((r, i) => {
    const { pct, rationale } = extractMatch(r);
    return {
      idx: String(i + 1),
      museum: r.museum,
      match: pct,
      rationaleLines: wrap(r.rationale.startsWith('(') ? rationale : rationale, 100), // 100-char wrap
    };
  });

  // Column widths
  const W_IDX = 3;
  const W_MUSEUM = Math.max(6, ...rows.map(r => r.museum.length));
  const W_MATCH = 7;
  const W_RATIONALE = 100;

  const header = ['#', 'Museum', 'Match', 'Rationale'];
  const line =
    '+' + [
      '-'.repeat(W_IDX + 2),
      '-'.repeat(W_MUSEUM + 2),
      '-'.repeat(W_MATCH + 2),
      '-'.repeat(W_RATIONALE + 2),
    ].join('+') + '+';

  function pad(s: string, w: number) {
    return s.length > w ? s.slice(0, w - 1) + '…' : s + ' '.repeat(w - s.length);
  }
  function row(c0: string, c1: string, c2: string, c3: string) {
    return `| ${pad(c0, W_IDX)} | ${pad(c1, W_MUSEUM)} | ${pad(c2, W_MATCH)} | ${pad(c3, W_RATIONALE)} |`;
  }

  console.log(line);
  console.log(row(header[0], header[1], header[2], header[3]));
  console.log(line);

  for (const r of rows) {
    // First line of this recommendation prints all columns
    console.log(row(r.idx, r.museum, r.match, r.rationaleLines[0] ?? ''));
    // Subsequent wrapped lines print only the rationale column
    for (let i = 1; i < r.rationaleLines.length; i++) {
      console.log(row('', '', '', r.rationaleLines[i]));
    }
  }

  console.log(line + '\n');
}



/**
 * Test 1: Cold start → first taste → AI recs
 * - With no TasteSignals, llmRecommend should return [] (UI falls back to Popular)
 * - After adding one strong taste, llmRecommend returns personalized recs with rationales
 */
export async function testColdStartThenAI(): Promise<void> {
  header('TEST 1: Cold start → first taste → AI recommendations');

  const store = new SpotlightAIStore();
  const llm = new GeminiLLM(loadConfig());
  const spotlight = new SpotlightAI(store, llm);

  const user = 'u:new';
  const candidates = ['met', 'guggenheim', 'whitney', 'brooklyn', 'new-museum'];

  // Cold start: expect empty rec list (fallback handled at UI level)
  const recsBefore = await spotlight.llmRecommend({ user, k: 3, candidates });
  printRecsTable('Cold start (expected empty)', recsBefore);

  // User logs first strong preference
  spotlight.recordMuseumTaste(user, 'met', 'LOVE');

  // Personalized run
  const recsAfter = await spotlight.llmRecommend({ user, k: 3, candidates });
  printRecsTable('After first taste (personalized recs)', recsAfter);

  // Cached read (no new LLM call)
  const cached = spotlight.getRecommendations(user, 2);
  printRecsTable('Cached top-2 (no LLM call)', cached);
}

/**
 * Test 2: Richer profile + refreshOnRatingChange
 * - Seed multiple tastes across domains
 * - Run llmRecommend(k=5)
 * - Update a taste and trigger refreshOnRatingChange
 * - Read cached results without a new LLM call
 */
export async function testHistoryAndRefresh(): Promise<void> {
  header('TEST 2: Richer taste profile + refreshOnRatingChange');

  const store = new SpotlightAIStore();
  const llm = new GeminiLLM(loadConfig());
  const spotlight = new SpotlightAI(store, llm);

  const user = 'u:history';
  const candidates = [
    'met', 'guggenheim', 'natural-history', 'whitney', 'brooklyn', 'new-museum',
    'ps1', 'frick', 'morgan', 'new-gallery', 'queens-museum', 'bronx-museum'
  ];

  // Rich, mixed profile
  spotlight.recordMuseumTaste(user, 'met', 'LOVE');               // encyclopedic + strong modern wing
  spotlight.recordMuseumTaste(user, 'guggenheim', 'LIKE');        // modern/architecture positive
  spotlight.recordMuseumTaste(user, 'natural-history', 'MEH');    // not a science-first visitor
  spotlight.recordMuseumTaste(user, 'frick', 'LIKE');             // old masters, intimate galleries
  spotlight.recordMuseumTaste(user, 'ps1', 'LOVE');               // experimental contemporary
  spotlight.recordMuseumTaste(user, 'morgan', 'LIKE');            // manuscripts, drawings
  spotlight.recordMuseumTaste(user, 'new-gallery', 'MEH');        // less into focused single-region collections

  const first = await spotlight.llmRecommend({ user, k: 5, candidates });
  printRecsTable('Initial recommendations (k=5)', first);


  // Upgrade a taste and refresh
  spotlight.recordMuseumTaste(user, 'guggenheim', 'LOVE');
  const refreshed = await spotlight.refreshOnRatingChange(user, 5, candidates);
  printRecsTable('After updating taste and refresh', refreshed);


  // Cached top-3
  const cached = spotlight.getRecommendations(user, 3);
  printRecsTable('Cached top-3', cached);
}

/**
 * Test 3: LLM outage handling
 * - Seed tastes
 * - Use a throwing LLM to simulate outage
 * - Verify error and fallback guidance
 */
class ThrowingLLM extends GeminiLLM {
  constructor() { super({ apiKey: 'invalid' }); }
  async executeLLM(): Promise<string> {
    throw new Error('Simulated LLM service outage');
  }
}

export async function testLLMErrorFallback(): Promise<void> {
  header('TEST 3: LLM outage handling');

  const store = new SpotlightAIStore();
  const llm = new ThrowingLLM();
  const spotlight = new SpotlightAI(store, llm);

  const user = 'u:error';
  const candidates = ['whitney', 'brooklyn', 'new-museum', 'ps1', 'frick'];

  // Seed tastes
  spotlight.recordMuseumTaste(user, 'met', 'LOVE');
  spotlight.recordMuseumTaste(user, 'frick', 'LIKE');

  try {
    await spotlight.llmRecommend({ user, k: 3, candidates });
  } catch (err) {
    block('Caught LLM error (expected)', (err as Error).message);
    block('Fallback guidance', [
      'Show Popular or Browse Museums.',
      'Offer a Try Again button once the service is back.',
      'Keep last good Recommendations cached to avoid UI flicker.'
    ]);
  }
}

async function main(): Promise<void> {
  console.log('Spotlight+AI Test Suite');
  console.log('=======================\n');

  try {
    await testColdStartThenAI();
    await testHistoryAndRefresh();
    await testLLMErrorFallback();

    console.log('\nTests complete.\n');
  } catch (error) {
    console.error('Test error:', (error as Error).message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
