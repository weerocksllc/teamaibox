import { PlatformError } from "../../../../packages/observability/src/index.mjs";

function model(value) {
  if (typeof value !== "string" || !/^[^\s\u0000-\u001f]{1,512}$/u.test(value)) throw new TypeError("Assistant queued model is invalid");
  return value;
}

function assistantComputeFailure(error) {
  if (error?.name === "AbortError") return error;
  if (error?.code === "compute_worker_busy") {
    return new PlatformError("assistant_compute_busy", "Assistant compute capacity is busy", {
      cause: error, status: 503, retryable: true,
    });
  }
  if (error?.retryable === true || error?.code === "compute_worker_unavailable"
      || error?.code === "compute_route_unavailable") {
    return new PlatformError("assistant_compute_unavailable", "Assistant compute gateway is unavailable", {
      cause: error, status: 503, retryable: true,
    });
  }
  return error;
}

export class QueuedAssistantAnswerRunner {
  #compute;
  #model;
  #maximumOutputTokens;

  constructor({ computeApi, modelAlias, maximumOutputTokens = 256 }) {
    if (!computeApi?.handle) throw new TypeError("Assistant queued compute API is required");
    if (!Number.isSafeInteger(maximumOutputTokens) || maximumOutputTokens < 1 || maximumOutputTokens > 4096) {
      throw new TypeError("Assistant queued output limit is invalid");
    }
    this.#compute = computeApi;
    this.#model = model(modelAlias);
    this.#maximumOutputTokens = maximumOutputTokens;
  }

  async run({ ownerIdentityId, run, history, signal, emit }) {
    const currentInput = [...history].reverse().find((message) => message.role === "user" && message.runId === run.id);
    for (const artifact of currentInput?.artifacts ?? []) {
      if (typeof artifact?.artifactId === "string" && typeof artifact?.label === "string") {
        await emit({
          type: "source.cited",
          source: { referenceId: artifact.artifactId, label: artifact.label, url: artifact.downloadPath ?? null },
        });
      }
    }
    try {
      const response = await this.#compute.handle({
        method: "POST",
        pathname: "/v1/chat/completions",
        context: { identityId: ownerIdentityId },
        requestId: `assistant-${run.id}`,
        headers: { "idempotency-key": `assistant-${run.id}` },
        body: {
          model: this.#model,
          stream: true,
          max_tokens: this.#maximumOutputTokens,
          temperature: 0,
          stream_options: { include_usage: true },
          messages: history.filter((message) => (message.role === "user" || message.role === "assistant") && message.content)
            .map((message) => ({ role: message.role, content: message.content })),
          x_teamaibox: {
            data_class: "confidential",
            idempotency_key: `assistant-${run.id}`,
            extensions: { client: "official.assistant", conversation_id: run.conversationId },
          },
        },
      });
      if (response?.kind !== "sse" || !response.events?.[Symbol.asyncIterator]) {
        throw new PlatformError("assistant_compute_invalid", "Assistant compute queue returned an invalid stream", { status: 502 });
      }
      let sawCompletion = false;
      for await (const item of response.events) {
        if (signal?.aborted) {
          const error = new Error("Assistant run was cancelled");
          error.name = "AbortError";
          throw error;
        }
        const value = item?.data;
        if (!value || typeof value !== "object") throw new PlatformError("assistant_compute_invalid", "Assistant compute queue returned an invalid event", { status: 502 });
        const choice = value.choices?.[0];
        if (typeof choice?.delta?.content === "string" && choice.delta.content) await emit({ type: "text_delta", delta: choice.delta.content });
        if (typeof choice?.finish_reason === "string") sawCompletion = true;
        if (Number.isSafeInteger(value.usage?.prompt_tokens) && Number.isSafeInteger(value.usage?.completion_tokens)) {
          await emit({
            type: "usage.updated",
            usage: {
              inputTokens: value.usage.prompt_tokens,
              outputTokens: value.usage.completion_tokens,
              costMicrounits: 0,
              currency: "CNY",
            },
          });
        }
      }
      if (!sawCompletion) throw new PlatformError("assistant_compute_incomplete", "Assistant compute queue ended before completion", { status: 502, retryable: true });
    } catch (error) {
      throw assistantComputeFailure(error);
    }
  }
}
