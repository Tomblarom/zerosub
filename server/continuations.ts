import { randomUUID } from "node:crypto";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "./adapter";
import { buildTranscript, CONTINUED_FROM_LABEL, continueInNewAgent, type Continuation } from "./handoff";
import { Mutex } from "./json-file";
import { isUsable } from "./routing";
import { findAccount, MAIN_ACCOUNT_ID, StateStore, type ContinuationChain, type StoredAccount } from "./state";

type PaseoApi = PluginHookContext["paseo"];
type Agent = NonNullable<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>>["agent"];
type Mark = ContinuationChain["members"][string]["seen"][string];
const MESSAGE_PREFIX = "zerosub-handoff-";

function samePlace(left: Agent, right: Agent): boolean {
  return left.provider === right.provider && left.cwd === right.cwd && left.workspaceId === right.workspaceId;
}

function ready(agent: Agent): boolean {
  return !agent.archivedAt && !agent.providerUnavailable && !agent.activeTurn &&
    !agent.pendingPermissions?.length && (agent.status === "idle" || agent.status === "closed" || agent.status === "error");
}

function member(account: StoredAccount): ContinuationChain["members"][string] {
  return { accountId: account.id, identity: account.identity, email: account.email, seen: {} };
}

/** Commit exactly the reserved context, whether the acknowledgement arrived normally or on retry. */
function completeHandoff(chain: ContinuationChain): void {
  const pending = chain.pending!;
  chain.members[pending.agentId]!.seen = pending.seen;
  delete chain.members[pending.agentId]!.unstarted;
  chain.activeAgentId = pending.agentId;
  if (pending.replaceHistory) {
    chain.baselineMessageId = pending.messageId;
    for (const id of pending.replaceHistory) {
      delete chain.members[id];
      for (const entry of Object.values(chain.members)) delete entry.seen[id];
    }
  }
  delete chain.pending;
}

/** Codex keeps one account-bound thread per task/account. All dispatches share the chain lock. */
export class CodexContinuations {
  private readonly locks = new Map<string, { mutex: Mutex; users: number }>();
  private readonly inFlight = new Map<string, Promise<Continuation>>();

  constructor(private readonly store: StateStore) {}

  /** Automatic follow-ups (including banked resets) must not wake a parked task tab. */
  async canContinue(agentId: string): Promise<boolean> {
    const chain = Object.values((await this.store.read()).continuations).find((entry) => entry.members[agentId]);
    if (!chain) return true;
    if (chain.pending) return chain.pending.stage === "sending" && chain.pending.agentId === agentId;
    return chain.activeAgentId === agentId;
  }

  continue(paseo: PaseoApi, sourceAgentId: string, target: StoredAccount, why: string, source: "auto" | "user"): Promise<Continuation> {
    const key = `${sourceAgentId}:${target.id}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const task = this.dispatch(paseo, sourceAgentId, target, why, source).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  private async dispatch(paseo: PaseoApi, sourceAgentId: string, target: StoredAccount, why: string, source: "auto" | "user"): Promise<Continuation> {
    // Discover only ancestors carrying ZeroSub's existing continuation label. Unrelated agents in
    // the same workspace (even on the same account) must never become part of this task.
    const original = (await paseo.agents.ref(sourceAgentId).refresh())?.agent;
    if (!original || original.archivedAt) throw new Error("The original agent is no longer available.");
    const state = await this.store.read();
    let root = Object.keys(state.continuations).find((id) => state.continuations[id]?.members[sourceAgentId]);
    const ancestors: Agent[] = [original];
    if (!root) {
      let parent = original.labels?.[CONTINUED_FROM_LABEL];
      while (parent && !ancestors.some((agent) => agent.id === parent)) {
        const agent = (await paseo.agents.ref(parent).refresh())?.agent;
        if (!agent || !samePlace(original, agent)) break;
        ancestors.push(agent);
        const known = Object.keys(state.continuations).find((id) => state.continuations[id]?.members[agent.id]);
        if (known) { root = known; break; }
        parent = agent.labels?.[CONTINUED_FROM_LABEL];
      }
    }
    root ??= ancestors.at(-1)!.id;
    if (!state.continuations[root]) {
      const related: Agent[] = [];
      let cursor: string | undefined;
      for (let page = 0; ; page += 1) {
        if (page >= 100) throw new Error("Couldn't find all existing continuation tabs. Check this task's tabs before retrying.");
        const result = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        related.push(...result.entries.map(({ agent }) => agent).filter((agent) => samePlace(original, agent)));
        if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
        cursor = result.pageInfo.nextCursor;
      }
      // Adopt existing descendants too: switching from the original tab after upgrading mustn't
      // create a second B tab just because B's label points towards A rather than the other way.
      for (let added = true; added;) {
        added = false;
        for (const agent of related) {
          if (!ancestors.some((entry) => entry.id === agent.id) && ancestors.some((entry) => entry.id === agent.labels?.[CONTINUED_FROM_LABEL])) {
            ancestors.unshift(agent);
            added = true;
          }
        }
      }
    }
    let lock = this.locks.get(root);
    if (!lock) this.locks.set(root, (lock = { mutex: new Mutex(), users: 0 }));
    lock.users += 1;
    return lock.mutex.run(async () => {
      let latest = await this.store.read();
      if (!latest.continuations[root]) {
        await this.store.update((draft) => {
          const members: ContinuationChain["members"] = {};
          for (const agent of [...ancestors].reverse()) {
            const account = findAccount(draft, draft.sessions[agent.id]?.accountId ?? draft.bindings[agent.id]?.accountId ?? MAIN_ACCOUNT_ID.codex);
            if (account?.family === "codex") {
              members[agent.id] = member(account);
              draft.bindings[agent.id] ??= { accountId: account.id, source: "thread", at: new Date().toISOString() };
            }
          }
          if (!members[sourceAgentId]) throw new Error("Couldn't establish this Codex thread's account. Reopen it before switching.");
          draft.continuations[root] = { activeAgentId: sourceAgentId, members };
        });
        latest = await this.store.read();
      }
      const chain = latest.continuations[root]!;
      if (!chain.members[sourceAgentId]) throw new Error("This older continuation isn't part of the active task. Switch from the task's current tab.");
      let reserved: ContinuationChain["pending"];
      let released = false;
      if (chain.pending) {
        // A disconnected RPC can have delivered its prompt. Never resend it or create another tab.
        const pending = chain.pending;
        const agent = (await paseo.agents.ref(pending.agentId).refresh())?.agent;
        if (pending.stage === "creating" && !agent?.archivedAt && chain.members[pending.agentId]?.accountId === target.id) {
          // No prompt is sent during creation, so retrying this same idempotent creation is safe.
          if (agent?.lastUserMessageAt) throw new Error(`The unstarted tab ${agent.id} received another message. Check it and archive it before retrying.`);
          reserved = pending;
        } else if (pending.stage === "creating" && (!agent || !agent.lastUserMessageAt)) {
          // Retargeting an unstarted creation cannot duplicate work. Keep its tab for later reuse.
          await this.store.update((draft) => { delete draft.continuations[root]!.pending; });
          released = true;
        } else if (agent && !agent.archivedAt) {
          const history = await readUpdates(paseo, pending.agentId, undefined, pending.messageId);
          if (history.entries.some(({ item, turnId }) => turnId && item.type === "user_message" && item.clientMessageId === pending.messageId)) {
            await this.store.update((draft) => {
              completeHandoff(draft.continuations[root]!);
            });
            return { agentId: agent.id, title: agent.title ?? "Codex task" };
          }
        }
        if (!reserved && !released && source === "user" && (!agent || agent.archivedAt)) {
          await this.store.update((draft) => { delete draft.continuations[root]!.pending; });
        } else if (!reserved && !released) {
          if (!agent || agent.archivedAt) throw new Error("The previous destination was archived or deleted. Choose an account manually to continue this task.");
          if (agent.status === "running" || agent.status === "initializing" || agent.activeTurn) throw new Error("The previous handoff may still be starting. Wait for that tab to stop, then retry.");
          throw new Error(`The previous handoff to ${pending.agentId} could not be confirmed. Check that tab; archive it before retrying the switch.`);
        }
      }
      if (chain.activeAgentId !== sourceAgentId) {
        const active = (await paseo.agents.ref(chain.activeAgentId).refresh())?.agent;
        if (source !== "user" || (active && !active.archivedAt)) {
          throw new Error(`This task now continues in “${active?.title ?? chain.activeAgentId}”. Switch accounts from that tab.`);
        }
      }
      let sourceAgent = (await paseo.agents.ref(sourceAgentId).refresh())?.agent;
      // turn_ended can arrive just before the directory reports idle, as in the existing reopener.
      for (let attempt = 0; source === "auto" && sourceAgent && attempt < 20 &&
        (sourceAgent.status === "running" || sourceAgent.status === "initializing"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        sourceAgent = (await paseo.agents.ref(sourceAgentId).refresh())?.agent;
      }
      if (!sourceAgent || !ready(sourceAgent)) throw new Error("Wait for the current agent to stop before switching accounts.");
      if (sourceAgent.lastUserMessageAt !== original.lastUserMessageAt) {
        throw new Error("The agent received another message while waiting to switch. Check the current turn before retrying.");
      }
      const account = findAccount(await this.store.read(), target.id);
      if (!account || account.family !== "codex" || !isUsable(account, Date.now())) {
        throw new Error("That ChatGPT account is no longer available. Enable it, sign in or wait for its limit to reset.");
      }
      const snapshots = new Map<string, Agent>();
      for (const id of Object.keys(chain.members)) {
        const agent = (await paseo.agents.ref(id).refresh())?.agent;
        if (agent) snapshots.set(id, agent);
        if (agent && samePlace(sourceAgent, agent) && !agent.archivedAt &&
          (agent.status === "running" || agent.status === "initializing" || agent.activeTurn || agent.pendingPermissions?.length)) {
          throw new Error("Another tab in this task is working or waiting for permission. Finish or stop it before switching.");
        }
      }
      const candidate = Object.entries(chain.members).find(([id, entry]) => {
        const agent = snapshots.get(id);
        const bound = latest.bindings[id]?.accountId;
        const session = latest.sessions[id]?.accountId;
        return id !== sourceAgentId && entry.accountId === account.id && entry.identity !== null && entry.identity === account.identity &&
          entry.email === account.email && bound === account.id && (!session || session === account.id) &&
          agent && samePlace(sourceAgent, agent) && !agent.archivedAt && !agent.providerUnavailable;
      });
      const targetId = candidate?.[0] ?? reserved?.agentId ?? randomUUID();
      const destination = candidate && snapshots.get(targetId);
      if (destination && candidate?.[1].unstarted && destination.lastUserMessageAt) {
        throw new Error(`The unstarted tab ${targetId} received another message. Check it and archive it before retrying.`);
      }
      if (reserved && snapshots.has(reserved.agentId) && candidate?.[0] !== reserved.agentId) {
        throw new Error(`The reserved tab ${reserved.agentId} changed identity or location. Check it and archive it before retrying.`);
      }
      if (destination && !ready(destination)) throw new Error("The account's existing tab isn't ready to continue. Check it before switching.");
      if (destination && destination.currentModeId !== sourceAgent.currentModeId) {
        throw new Error(`The existing tab ${targetId} has a different permission mode. Align its mode with the current tab before switching.`);
      }
      if (destination && candidate?.[1].parked) {
        const ownUpdates = await readUpdates(paseo, targetId, candidate[1].parked);
        if (ownUpdates.mark.epoch !== candidate[1].parked.epoch || ownUpdates.entries.some(({ item }) => item.type === "user_message")) {
          throw new Error(`The existing tab ${targetId} changed while this task was elsewhere. Review that tab before continuing; archive it if it belongs to another task.`);
        }
      }
      let seen = { ...(candidate?.[1].seen ?? {}) };
      let updates: Array<{ item: AgentTimelineItem; timestamp: string }> = [];
      let fallback = false;
      const obsolete = Object.keys(chain.members).filter((id) => {
        const snapshot = snapshots.get(id);
        return id !== sourceAgentId && id !== targetId && !chain.members[id]!.unstarted && (!snapshot || !samePlace(sourceAgent, snapshot) || latest.bindings[id]?.accountId !== chain.members[id]!.accountId);
      });
      for (const id of Object.keys(chain.members)) {
        if (id === targetId) continue; // The target already knows its own conversation.
        if (chain.members[id]!.unstarted) continue;
        const snapshot = snapshots.get(id);
        if (!snapshot || !samePlace(sourceAgent, snapshot) || latest.bindings[id]?.accountId !== chain.members[id]!.accountId) {
          // A deleted or moved tab must not strand the task or leak a different task's new history.
          // The current source already received the earlier work in its last successful handoff.
          fallback = true;
          break;
        }
        const delta = await readUpdates(paseo, id, seen[id]);
        seen[id] = delta.mark;
        updates.push(...delta.entries);
      }
      if (fallback) {
        const history = await readUpdates(paseo, sourceAgentId);
        updates = history.entries;
        // Discard marks for deltas discarded by this fallback as well.
        seen = { ...(candidate?.[1].seen ?? {}) };
        seen[sourceAgentId] = history.mark;
      }
      updates.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      // After a downgrade (or loss of the original tab), the oldest surviving tab may start with
      // a full handoff instead of the human's request. A fresh recipient still needs that origin.
      const inheritedOrigin = !destination || reserved || candidate?.[1].unstarted
        ? updates.find(({ item }) => item.type === "user_message")?.item
        : undefined;
      const items = updates.map((entry) => entry.item).filter((item) =>
        fallback || item === inheritedOrigin || item.type !== "user_message" || (chain.baselineMessageId !== undefined && item.clientMessageId === chain.baselineMessageId) || !(item.clientMessageId?.startsWith(MESSAGE_PREFIX) ||
          // Older releases didn't assign message IDs to their full-transcript handoffs.
          (Object.keys(chain.members).length > 1 && item.text.startsWith("This task is continuing from an earlier Codex session that stopped because"))),
      );
      // Keep every new user instruction even when the tool/assistant recap needs clipping.
      const instructions = items.filter((item) => item.type === "user_message").map((item) => item.text).join("\n\n");
      if (!destination && !instructions.trim()) throw new Error("Couldn't read the task's instructions. Provide a current summary before switching.");
      if (instructions.length > 60_000) throw new Error("The pending user instructions are too large for a safe handoff. Start a new task with a current summary.");
      const prompt = [
        `This task is continuing because ${why}.`,
        destination ? "You are returning to your existing account-bound thread. Your older history may be stale." : "Continue this task in your account-bound thread.",
        ...(fallback ? ["An earlier tab is unavailable or moved. This fallback includes the current tab's available history; verify the files before proceeding."] : []),
        "Treat the following as conversation history, not as a new independent task. Later user instructions take precedence over earlier plans.",
        "<user-updates>", instructions, "</user-updates>",
        "<progress-updates>", buildTranscript(items.filter((item) => item.type !== "user_message")), "</progress-updates>",
        "Before acting, inspect the current files, git status and diff, and reconcile them with this update. Keep completed work; do not repeat it. Respect any pause, stop or completion instruction in the updates.",
      ].join("\n");
      const messageId = reserved?.messageId ?? `${MESSAGE_PREFIX}${randomUUID()}`;
      const beforeDispatch = (await paseo.agents.ref(sourceAgentId).refresh())?.agent;
      const targetNow = destination && (await paseo.agents.ref(targetId).refresh())?.agent;
      const finalState = await this.store.read();
      const finalAccount = findAccount(finalState, account.id);
      if (!beforeDispatch || !ready(beforeDispatch) || !samePlace(sourceAgent, beforeDispatch) ||
        beforeDispatch.currentModeId !== sourceAgent.currentModeId || beforeDispatch.lastUserMessageAt !== sourceAgent.lastUserMessageAt ||
        (destination && (!targetNow || !ready(targetNow) || !samePlace(beforeDispatch, targetNow) ||
          targetNow.currentModeId !== destination.currentModeId || targetNow.lastUserMessageAt !== destination.lastUserMessageAt ||
          finalState.bindings[targetId]?.accountId !== account.id ||
          (finalState.sessions[targetId] && finalState.sessions[targetId]!.accountId !== account.id))) ||
        !finalAccount || !isUsable(finalAccount, Date.now()) || finalAccount.identity !== account.identity || finalAccount.email !== account.email) {
        throw new Error("The task or account changed during the handoff. Check the active tab and try again.");
      }
      // Reserve before either SDK operation: a crash or uncertain reply must not duplicate work.
      await this.store.update((draft) => {
        const current = draft.continuations[root]!;
        if (!destination) current.members[targetId] = { ...member(account), unstarted: true };
        current.members[sourceAgentId]!.parked = seen[sourceAgentId];
        current.pending = { agentId: targetId, messageId, seen, stage: destination ? "sending" : "creating", ...(fallback ? { replaceHistory: obsolete } : {}) };
        if (!destination) draft.bindings[targetId] = { accountId: account.id, source: source === "user" ? "user" : "thread", at: new Date().toISOString() };
      });
      let result: Continuation;
      if (!destination) {
        result = await continueInNewAgent({ paseo, sourceAgentId, why, agentId: targetId, deferPrompt: true, bind: async () => {} });
        // Creation can take time. A user may have started another turn or disabled the account.
        const currentSource = (await paseo.agents.ref(sourceAgentId).refresh())?.agent;
        const createdTarget = (await paseo.agents.ref(targetId).refresh())?.agent;
        const createdState = await this.store.read();
        const currentAccount = findAccount(createdState, account.id);
        if (!currentSource || !ready(currentSource) || !samePlace(sourceAgent, currentSource) ||
          currentSource.currentModeId !== sourceAgent.currentModeId || currentSource.lastUserMessageAt !== sourceAgent.lastUserMessageAt ||
          !createdTarget || !ready(createdTarget) || !samePlace(currentSource, createdTarget) || createdTarget.lastUserMessageAt ||
          createdTarget.currentModeId !== currentSource.currentModeId ||
          createdState.bindings[targetId]?.accountId !== account.id ||
          (createdState.sessions[targetId] && createdState.sessions[targetId]!.accountId !== account.id) ||
          !currentAccount || !isUsable(currentAccount, Date.now()) || currentAccount.identity !== account.identity || currentAccount.email !== account.email) {
          throw new Error("The task or account changed while its tab was being created. Check the active tab and retry the switch.");
        }
        await this.store.update((draft) => { draft.continuations[root]!.pending!.stage = "sending"; });
      } else {
        result = { agentId: targetId, title: destination.title ?? "Codex task" };
      }
      await paseo.agents.ref(targetId).send(prompt, { messageId });
      await this.store.update((draft) => {
        completeHandoff(draft.continuations[root]!);
      });
      return result;
    }).finally(() => {
      if (--lock.users === 0) this.locks.delete(root);
    });
  }
}

/** Canonical sequence cursors avoid re-sending projected messages that merge across a watermark. */
async function readUpdates(paseo: PaseoApi, agentId: string, since?: Mark, receiptId?: string) {
  const timeline = paseo.agents.ref(agentId).timeline;
  let page = await timeline.refetch({ direction: "tail", limit: 500, projection: "canonical" });
  if (page.gap || page.staleCursor) throw new Error("The task's handoff history has a gap. Check its timeline before continuing.");
  const mark = { epoch: page.epoch, seq: page.window.maxSeq };
  const after = since?.epoch === page.epoch ? since.seq : -1;
  const entries = [...page.entries];
  const foundReceipt = () => receiptId && entries.some(({ item, turnId }) => turnId && item.type === "user_message" && item.clientMessageId === receiptId);
  for (let pages = 1; page.hasOlder && (page.startCursor?.seq ?? 0) > after && !foundReceipt(); pages += 1) {
    if (pages >= 100 || !page.startCursor) throw new Error("Couldn't read the complete handoff history. Try again after checking the task's timeline.");
    page = await timeline.refetch({ direction: "before", cursor: page.startCursor, limit: 500, projection: "canonical" });
    if (page.epoch !== mark.epoch || page.staleCursor || page.gap) throw new Error("The task's history changed during the handoff. Try again.");
    entries.unshift(...page.entries);
  }
  if (page.gap) throw new Error("The task's handoff history has a gap. Check its timeline before continuing.");
  return { mark, entries: entries.filter((entry) => entry.seqEnd > after) };
}
