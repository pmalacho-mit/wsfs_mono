import type {
  DataCallback,
  Disposable,
  Message,
  MessageReader,
  MessageWriter,
} from "vscode-languageserver-protocol";

export type MessageTransform = (message: Message) => Message;

export type MessageInterceptor = {
  incoming: MessageTransform;
  outgoing: MessageTransform;
};

class TransformingReader implements MessageReader {
  constructor(
    private readonly inner: MessageReader,
    private readonly transform: MessageTransform,
  ) {}

  get onError() {
    return this.inner.onError;
  }
  get onClose() {
    return this.inner.onClose;
  }
  get onPartialMessage() {
    return this.inner.onPartialMessage;
  }

  listen = (callback: DataCallback): Disposable =>
    this.inner.listen((message) => callback(this.transform(message)));

  dispose = () => this.inner.dispose();
}

class TransformingWriter implements MessageWriter {
  constructor(
    private readonly inner: MessageWriter,
    private readonly transform: MessageTransform,
  ) {}

  get onError() {
    return this.inner.onError;
  }
  get onClose() {
    return this.inner.onClose;
  }

  write = (message: Message) => this.inner.write(this.transform(message));

  end = () => this.inner.end();

  dispose = () => this.inner.dispose();
}

/**
 * Every message between the editor and the language server passes through
 * here, which is the only place both directions of a request can be rewritten
 * consistently.
 */
export const intercept = (
  transports: { reader: MessageReader; writer: MessageWriter },
  { incoming, outgoing }: MessageInterceptor,
) => ({
  reader: new TransformingReader(transports.reader, incoming),
  writer: new TransformingWriter(transports.writer, outgoing),
});
