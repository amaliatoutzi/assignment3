/**
 * LLM Integration (Gemini)
 * Minimal wrapper used by Spotlight+AI concept.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';

export interface Config {
  apiKey: string;
}

export class GeminiLLM {
  private apiKey: string;

  constructor(config: Config) {
    this.apiKey = config.apiKey;
  }

  async executeLLM(prompt: string): Promise<string> {
    try {
      const genAI = new GoogleGenerativeAI(this.apiKey);
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash-lite',
        generationConfig: { maxOutputTokens: 1000 }
      });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (err) {
      console.error('❌ Gemini API error:', (err as Error).message);
      throw err;
    }
  }
}
