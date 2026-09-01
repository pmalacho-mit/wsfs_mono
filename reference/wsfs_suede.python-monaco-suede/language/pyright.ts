type Notifier = {
  sendNotification: (method: string, params: unknown) => Promise<void>;
};

type NewWorkerRequest = {
  type: "browser/newWorker";
  initialData: unknown;
  port: MessagePort;
};

const isNewWorkerRequest = (data: unknown): data is NewWorkerRequest =>
  (data as NewWorkerRequest | undefined)?.type === "browser/newWorker";

/**
 * Type evaluation happens on child workers, which the server cannot spawn from
 * inside a worker: it asks the page for one and hands back the port to speak on.
 */
const relayChildWorkers = (server: Worker, newWorker: () => Worker) =>
  server.addEventListener("message", ({ data }: MessageEvent) => {
    if (!isNewWorkerRequest(data)) return;
    const { initialData, port } = data;
    newWorker().postMessage(
      { type: "browser/boot", mode: "background", initialData, port },
      [port],
    );
  });

export const startPyright = (newWorker: () => Worker) => {
  const server = newWorker();
  relayChildWorkers(server, newWorker);
  server.postMessage({ type: "browser/boot", mode: "foreground" });
  return server;
};

/**
 * The language server keeps its own synchronous, in-memory filesystem inside
 * the worker. This only makes the path exist — content reaches the server as
 * an open document.
 */
export const createFile = (client: Notifier, uri: string) =>
  client.sendNotification("pyright/createFile", { uri });

export const deleteFile = (client: Notifier, uri: string) =>
  client.sendNotification("pyright/deleteFile", { uri });
