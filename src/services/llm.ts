/**
 * A minimal client for any OpenAI-compatible `/v1/chat/completions` endpoint.
 *
 * Deliberately hand-rolled over `fetch` rather than pulling in a vendor SDK:
 * we use exactly one endpoint, and staying on the generic wire format is what
 * lets a user point LLM_BASE_URL at Ollama, LM Studio, llama.cpp or vLLM
 * without any code change.
 */

export interface LlmMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface LlmClient {
    /** Returns the raw assistant text. Callers parse and validate it themselves. */
    complete(messages: LlmMessage[], jsonSchema?: unknown): Promise<string>;
    /** Cheap liveness probe for the chat widget's setup message. */
    isReachable(): Promise<boolean>;
}

export interface LlmConfig {
    baseUrl: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
}

/** Thrown when the endpoint is unreachable, times out, or answers with an error. */
export class LlmUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LlmUnavailableError";
    }
}

interface ChatCompletionResponse {
    choices?: { message?: { content?: string } }[];
}

export function createLlmClient(config: LlmConfig): LlmClient {
    async function post(path: string, body: unknown, timeoutMs: number): Promise<Response> {
        // AbortSignal.timeout gives a hard wall-clock cap; fetch alone has none.
        return fetch(`${config.baseUrl}${path}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    }

    return {
        async complete(messages, jsonSchema) {
            let response: Response;
            try {
                response = await post(
                    "/v1/chat/completions",
                    {
                        model: config.model,
                        messages,
                        // Temperature 0: we want the same sentence to classify the
                        // same way every time, not creative variation.
                        temperature: 0,
                        stream: false,
                        // A hint, not a guarantee. Runtimes differ in whether they
                        // enforce json_schema, so callers must still validate.
                        ...(jsonSchema === undefined
                            ? {}
                            : {
                                  response_format: {
                                      type: "json_schema",
                                      json_schema: { name: "intent", schema: jsonSchema },
                                  },
                              }),
                    },
                    config.timeoutMs
                );
            } catch (err) {
                throw new LlmUnavailableError(
                    `Could not reach a model at ${config.baseUrl}: ${(err as Error).message}`
                );
            }

            if (!response.ok) {
                throw new LlmUnavailableError(
                    `Model endpoint returned ${response.status} ${response.statusText}`
                );
            }

            const payload = (await response.json()) as ChatCompletionResponse;
            const content = payload.choices?.[0]?.message?.content;

            if (typeof content !== "string") {
                throw new LlmUnavailableError("Model response contained no message content.");
            }

            return content;
        },

        async isReachable() {
            try {
                const response = await fetch(`${config.baseUrl}/v1/models`, {
                    // Short: this runs on page render and must never block it.
                    signal: AbortSignal.timeout(1500),
                });
                return response.ok;
            } catch {
                return false;
            }
        },
    };
}
