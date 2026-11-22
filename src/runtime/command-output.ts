import { StringDecoder } from "node:string_decoder";
import { redact, safeText } from "../activity/data.ts";
interface CommandOutputData {
  readonly decoder: StringDecoder;
  pending: string;
  discarding: boolean;
  ready: string;
  readonly save: (text: string) => void;
  longLines: number;
}

export type CommandOutput = Pick<
  ReturnType<typeof bindCommandOutput>,
  "longLines" | "push" | "finish"
>;

export function createCommandOutput(save: (text: string) => void): CommandOutput {
  const decoder: StringDecoder = new StringDecoder("utf8");

  return bindCommandOutput({
    decoder,
    pending: "",
    discarding: false,
    ready: "",
    save,
    longLines: 0,
  });
}

function bindCommandOutput(self: CommandOutputData) {
  return Object.assign(self, {
    push: commandOutputPush.bind(undefined, self),
    finish: commandOutputFinish.bind(undefined, self),
  });
}

function commandOutputPush(self: CommandOutputData, chunk: Buffer): void {
  commandOutputConsume(self, self.decoder.write(chunk));
  if (self.ready) {
    self.save(self.ready);
    self.ready = "";
  }
}

function commandOutputFinish(self: CommandOutputData): void {
  commandOutputConsume(self, self.decoder.end());
  if (self.pending && !self.discarding) {
    commandOutputEmit(self, self.pending);
  }
  self.pending = "";
  if (self.ready) {
    self.save(self.ready);
    self.ready = "";
  }
}

function commandOutputEmit(self: CommandOutputData, text: string): void {
  self.ready += safeText(redact(text));
  while (self.ready.length >= 2000) {
    const code = self.ready.charCodeAt(1999);
    const boundary = code >= 0xd800 && code <= 0xdbff ? 1999 : 2000;
    self.save(self.ready.slice(0, boundary));
    self.ready = self.ready.slice(boundary);
  }
}

function commandOutputConsume(self: CommandOutputData, text: string): void {
  self.pending += text;
  let newline = self.pending.indexOf("\n");
  while (newline >= 0) {
    const line = self.pending.slice(0, newline + 1);
    if (!self.discarding && line.length <= 65536) {
      commandOutputEmit(self, line);
    } else if (!self.discarding) {
      commandOutputEmit(self, "[Overlong output line omitted for safe streaming/redaction]\n");
      self.longLines++;
    }
    self.pending = self.pending.slice(newline + 1);
    self.discarding = false;
    newline = self.pending.indexOf("\n");
  }
  if (self.pending.length > 65536) {
    if (!self.discarding) {
      commandOutputEmit(self, "[Overlong output line omitted for safe streaming/redaction]\n");
      self.longLines++;
    }
    self.pending = "";
    self.discarding = true;
  }
}
