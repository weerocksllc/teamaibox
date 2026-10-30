import { randomUUID } from "node:crypto";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const TRANSITIONS = Object.freeze({
  queued: new Set(["preparing", "failed", "cancelled"]),
  preparing: new Set(["queued", "running", "failed", "cancelled"]),
  running: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
});
const KEY = /^[a-z][a-z0-9_.-]{1,127}$/;

function requireKey(value, label) {
  if (typeof value !== "string" || !KEY.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function publicTask(record) {
  return Object.freeze({
    kind: "task",
    id: record.id,
    ownerIdentityId: record.ownerIdentityId,
    taskKind: record.taskKind,
    titleKey: record.titleKey,
    state: record.state,
    progress: record.progress,
    progressRevision: record.progressRevision,
    cancellationRequested: record.cancellationRequestedAt !== null,
    results: Object.freeze(structuredClone(record.results)),
    failure: record.failure ? Object.freeze(structuredClone(record.failure)) : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    terminalAt: record.terminalAt?.toISOString() ?? null,
  });
}

function publicConfirmation(record) {
  return Object.freeze({
    kind: "agent_operation_confirmation",
    id: record.id,
    ownerIdentityId: record.ownerIdentityId,
    agentSessionKey: record.agentSessionKey,
    operationKind: record.operationKind,
    titleKey: record.titleKey,
    scope: Object.freeze(structuredClone(record.scope)),
    status: record.status,
    expiresAt: record.expiresAt.toISOString(),
    decidedAt: record.decidedAt?.toISOString() ?? null,
  });
}

export class TaskCenter {
  #repository;
  #clock;

  constructor({ repository, clock = () => new Date() }) {
    if (!repository) throw new TypeError("task-center repository is required");
    this.#repository = repository;
    this.#clock = clock;
  }

  async createTask({ ownerIdentityId, taskKind, titleKey, id = randomUUID() }) {
    requireKey(taskKind, "task kind");
    requireKey(titleKey, "task title key");
    const now = this.#clock();
    const task = {
      id,
      ownerIdentityId,
      taskKind,
      titleKey,
      state: "queued",
      progress: 0,
      progressRevision: 1,
      cancellationRequestedAt: null,
      results: [],
      failure: null,
      createdAt: now,
      updatedAt: now,
      terminalAt: null,
    };
    await this.#repository.insertTask(task);
    await this.#repository.appendTaskEvent(id, {
      eventId: randomUUID(), eventKind: "state", state: "queued", progress: 0,
      progressRevision: 1, messageKey: "tasks.state.queued", payload: {}, createdAt: now,
    });
    return publicTask(task);
  }

  async listOwnTasks(ownerIdentityId) {
    const tasks = await this.#repository.listTasksByOwner(ownerIdentityId);
    return Object.freeze(tasks.map(publicTask));
  }

  async taskEvents(ownerIdentityId, taskId, afterSequence = 0) {
    const task = await this.#ownedTask(ownerIdentityId, taskId);
    const events = await this.#repository.listTaskEvents(task.id, afterSequence);
    return Object.freeze(events.map((event) => Object.freeze({
      ...structuredClone(event),
      createdAt: event.createdAt.toISOString(),
    })));
  }

  async transition(taskId, nextState, { messageKey = `tasks.state.${nextState}` } = {}) {
    const task = await this.#requiredTask(taskId);
    if (!Object.hasOwn(TRANSITIONS, nextState) || !TRANSITIONS[task.state].has(nextState)) {
      throw new PlatformError("invalid_task_transition", "Task state transition is invalid", { status: 409 });
    }
    const now = this.#clock();
    task.state = nextState;
    task.updatedAt = now;
    if (nextState === "completed") task.progress = 100;
    if (TERMINAL_STATES.has(nextState)) task.terminalAt = now;
    await this.#repository.updateTask(task);
    await this.#repository.appendTaskEvent(task.id, {
      eventId: randomUUID(), eventKind: "state", state: nextState,
      progress: task.progress, progressRevision: task.progressRevision,
      messageKey: requireKey(messageKey, "task event message key"), payload: {}, createdAt: now,
    });
    return publicTask(task);
  }

  async beginRetry(taskId) {
    const task = await this.#requiredTask(taskId);
    if (task.state !== "preparing") {
      throw new PlatformError("invalid_task_transition", "Only a preparing task can begin a retry revision", { status: 409 });
    }
    task.progressRevision += 1;
    task.progress = 0;
    task.updatedAt = this.#clock();
    await this.#repository.updateTask(task);
    await this.#repository.appendTaskEvent(task.id, {
      eventId: randomUUID(), eventKind: "progress_reset", state: task.state,
      progress: 0, progressRevision: task.progressRevision,
      messageKey: "tasks.progress.retry_started", payload: {}, createdAt: task.updatedAt,
    });
    return publicTask(task);
  }

  async reportProgress(taskId, { progress, messageKey = "tasks.progress.updated", payload = {} }) {
    const task = await this.#requiredTask(taskId);
    if (!["preparing", "running"].includes(task.state)) {
      throw new PlatformError("task_not_running", "Task progress cannot be updated in its current state", { status: 409 });
    }
    if (!Number.isFinite(progress) || progress < task.progress || progress < 0 || progress > 99.99) {
      throw new PlatformError("invalid_task_progress", "Task progress must be monotonic within its current attempt", { status: 409 });
    }
    const now = this.#clock();
    task.progress = progress;
    task.updatedAt = now;
    await this.#repository.updateTask(task);
    await this.#repository.appendTaskEvent(task.id, {
      eventId: randomUUID(), eventKind: "progress", state: task.state,
      progress, progressRevision: task.progressRevision,
      messageKey: requireKey(messageKey, "task event message key"),
      payload: structuredClone(payload), createdAt: now,
    });
    return publicTask(task);
  }

  async requestCancellation(ownerIdentityId, taskId) {
    const task = await this.#ownedTask(ownerIdentityId, taskId);
    if (TERMINAL_STATES.has(task.state)) {
      throw new PlatformError("task_already_terminal", "Completed tasks cannot be cancelled", { status: 409 });
    }
    if (!task.cancellationRequestedAt) {
      const now = this.#clock();
      task.cancellationRequestedAt = now;
      task.updatedAt = now;
      await this.#repository.updateTask(task);
      await this.#repository.appendTaskEvent(task.id, {
        eventId: randomUUID(), eventKind: "cancellation_requested", state: task.state,
        progress: task.progress, progressRevision: task.progressRevision,
        messageKey: "tasks.cancellation.requested", payload: {}, createdAt: now,
      });
    }
    return publicTask(task);
  }

  async complete(taskId, results) {
    if (!Array.isArray(results) || results.length === 0 || results.some((result) =>
      typeof result?.label !== "string" || typeof result?.artifactRef !== "string")) {
      throw new TypeError("completed task results require labeled artifact references");
    }
    const task = await this.#requiredTask(taskId);
    if (task.state !== "running") throw new PlatformError("invalid_task_transition", "Only a running task can complete", { status: 409 });
    task.results = structuredClone(results);
    await this.#repository.updateTask(task);
    return this.transition(taskId, "completed", { messageKey: "tasks.state.completed" });
  }

  async fail(taskId, { errorCode, guidanceKey, retryable, retryAction = null }) {
    requireKey(errorCode, "task error code");
    requireKey(guidanceKey, "retry guidance key");
    if (retryAction !== null) requireKey(retryAction, "retry action key");
    const task = await this.#requiredTask(taskId);
    if (TERMINAL_STATES.has(task.state)) throw new PlatformError("task_already_terminal", "Task is already terminal", { status: 409 });
    task.failure = { errorCode, guidanceKey, retryable: Boolean(retryable), retryAction };
    await this.#repository.updateTask(task);
    return this.transition(taskId, "failed", { messageKey: guidanceKey });
  }

  async createAgentConfirmation({ ownerIdentityId, agentSessionKey, operationKind, titleKey, scope, expiresAt }) {
    requireKey(operationKind, "Agent operation kind");
    requireKey(titleKey, "Agent confirmation title key");
    const now = this.#clock();
    const expiry = new Date(expiresAt);
    if (!(expiry > now)) throw new TypeError("Agent confirmation expiry must be in the future");
    const confirmation = {
      id: randomUUID(), ownerIdentityId, agentSessionKey, operationKind, titleKey,
      scope: structuredClone(scope), status: "pending", createdAt: now,
      expiresAt: expiry, decidedAt: null, decidedBy: null,
    };
    await this.#repository.insertAgentConfirmation(confirmation);
    return publicConfirmation(confirmation);
  }

  async listOwnAgentConfirmations(ownerIdentityId) {
    await this.#repository.expireAgentConfirmations(this.#clock());
    const records = await this.#repository.listAgentConfirmationsByOwner(ownerIdentityId);
    return Object.freeze(records.map(publicConfirmation));
  }

  async decideAgentConfirmation(ownerIdentityId, confirmationId, decision) {
    if (!new Set(["approved", "denied"]).has(decision)) throw new TypeError("Agent confirmation decision is invalid");
    await this.#repository.expireAgentConfirmations(this.#clock());
    const confirmation = await this.#repository.findAgentConfirmation(confirmationId);
    if (!confirmation || confirmation.ownerIdentityId !== ownerIdentityId) {
      throw new PlatformError("confirmation_not_found", "Agent operation confirmation was not found", { status: 404 });
    }
    if (confirmation.status !== "pending") {
      throw new PlatformError("confirmation_not_pending", "Agent operation confirmation is no longer pending", { status: 409 });
    }
    confirmation.status = decision;
    confirmation.decidedAt = this.#clock();
    confirmation.decidedBy = ownerIdentityId;
    await this.#repository.updateAgentConfirmation(confirmation);
    return publicConfirmation(confirmation);
  }

  async cancelAgentConfirmation(ownerIdentityId, confirmationId) {
    await this.#repository.expireAgentConfirmations(this.#clock());
    const confirmation = await this.#repository.findAgentConfirmation(confirmationId);
    if (!confirmation || confirmation.ownerIdentityId !== ownerIdentityId) {
      throw new PlatformError("confirmation_not_found", "Agent operation confirmation was not found", { status: 404 });
    }
    if (confirmation.status !== "pending") return publicConfirmation(confirmation);
    confirmation.status = "cancelled";
    confirmation.decidedAt = this.#clock();
    confirmation.decidedBy = ownerIdentityId;
    await this.#repository.updateAgentConfirmation(confirmation);
    return publicConfirmation(confirmation);
  }

  async #requiredTask(taskId) {
    const task = await this.#repository.findTask(taskId);
    if (!task) throw new PlatformError("task_not_found", "Task was not found", { status: 404 });
    return task;
  }

  async #ownedTask(ownerIdentityId, taskId) {
    const task = await this.#requiredTask(taskId);
    if (task.ownerIdentityId !== ownerIdentityId) {
      throw new PlatformError("task_not_found", "Task was not found", { status: 404 });
    }
    return task;
  }
}

export const taskStates = Object.freeze(Object.keys(TRANSITIONS));
