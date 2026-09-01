import { AsyncMemory } from "./async-memory";
import {
  ChannelHost,
  ChannelWorker,
  type ChannelChunkMessage,
  type Patience,
} from "./channel";
import {
  ObjectProxyClient,
  ObjectProxyHost,
  type ProxyMessages,
} from "./object-proxy";
import {
  SyncCallClient,
  SyncCallHost,
  type SyncCallMessages,
  type SyncCallTargets,
} from "./sync-call";
import { settled } from "./settled";
import type { Typed } from "../utils";

export type BridgeMessages = ProxyMessages &
  SyncCallMessages &
  ChannelChunkMessage;

/** Which request a message belongs to, stamped on as it leaves the worker. */
export type BridgeMessage = Typed<BridgeMessages> & { request: number };

const BRIDGE_MESSAGE_TYPES = new Set<string>([
  "proxy_reflect",
  "proxy_promise",
  "proxy_release",
  "sync_call",
  "channel_chunk",
]);

const isBridgeMessage = (message: { type: string }): message is BridgeMessage =>
  BRIDGE_MESSAGE_TYPES.has(message.type);

/**
 * The host end of the bridge: owns the shared memory, answers the worker's
 * blocking requests, and hands out ids for the objects it keeps.
 */
export class HostBridge {
  readonly memory: AsyncMemory;
  readonly channel: ChannelHost;
  readonly objects: ObjectProxyHost;
  private readonly calls: SyncCallHost;

  constructor(targets: SyncCallTargets, capacity?: number) {
    this.memory = new AsyncMemory({ capacity });
    this.channel = new ChannelHost(this.memory);
    this.objects = new ObjectProxyHost(this.channel);
    this.calls = new SyncCallHost(
      targets,
      this.channel,
      this.objects.references,
    );
  }

  get buffers() {
    return this.memory.buffers;
  }

  /** @returns whether the message was addressed to the bridge */
  handle(message: { type: string }) {
    if (!isBridgeMessage(message)) return false;
    if (message.type === "sync_call") this.answer(message, message.request);
    else if (message.type === "channel_chunk") this.channel.sendNextChunk();
    else this.objects.handleProxyMessage(message, message.request);
    return true;
  }

  /**
   * A worker blocked on an answer has no way to notice that producing one went
   * wrong, so a failure here still has to reach it as an answer.
   */
  private answer(message: SyncCallMessages["sync_call"], request: number) {
    this.calls
      .respond(message, request)
      .catch((error) => this.objects.respond(settled.failure(error), request));
  }

  dispose() {
    this.memory.dispose();
  }
}

/**
 * The worker end of the bridge: turns host objects into proxies and host
 * functions into calls that block until they settle.
 */
export class WorkerBridge {
  readonly memory: AsyncMemory;
  readonly channel: ChannelWorker;
  readonly objects: ObjectProxyClient;
  readonly calls: SyncCallClient;

  constructor(
    buffers: AsyncMemory.Buffers,
    postMessage: (message: BridgeMessage) => void,
    patience?: Patience,
  ) {
    this.memory = new AsyncMemory(buffers);

    /** Every message says which request it belongs to. */
    const post = (message: { type: string }) =>
      postMessage({
        ...message,
        request: this.memory.request,
      } as BridgeMessage);

    this.channel = new ChannelWorker(
      this.memory,
      () => post({ type: "channel_chunk" }),
      patience,
    );
    this.objects = new ObjectProxyClient(this.channel, post);
    this.calls = new SyncCallClient(
      this.channel,
      post,
      this.objects.references,
    );
  }
}
