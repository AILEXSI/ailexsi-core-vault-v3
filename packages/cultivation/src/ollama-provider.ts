/**
 * Optional Ollama provider. Failures surface; never auto-write to Core.
 */

import type { LlmProvider } from "./types.js";

export class OllamaProvider implements LlmProvider {
  constructor(
    private readonly baseUrl = process.env.OLLAMA_BASE_URL ??
      "http://127.0.0.1:11434",
    private readonly model = process.env.OLLAMA_MODEL ?? "llama3.2"
  ) {}

  async complete(prompt: string, context: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt: `${context}\n\n${prompt}`,
        stream: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { response?: string };
    return data.response ?? "";
  }
}

/** Deterministic mock for tests — never hits network. */
export class MockLlmProvider implements LlmProvider {
  constructor(private readonly response: string) {}

  async complete(_prompt: string, _context: string): Promise<string> {
    return this.response;
  }
}
