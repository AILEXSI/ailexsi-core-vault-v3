/**
 * Localhost HTTP bridge over long-lived DesktopHost.
 *
 * Tauri (and the Vite UI) call this bridge — never a second EventStore.
 *
 *   UI / Tauri invoke
 *        ↓
 *   HTTP 127.0.0.1:DESKTOP_HOST_PORT  (Channel Token)
 *        ↓
 *   DesktopHost (Session Actor)
 *        ↓
 *   AgencyBoundary.commitCanonical
 *        ↓
 *   PostgresEventStore
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  getDesktopHost,
  invokeDesktopCommand,
  type DesktopHostStartOptions,
  type DesktopMemoryCommand,
} from "./desktop-host.js";
import { formatV2Error } from "./errors.js";

export const DEFAULT_DESKTOP_HOST_PORT = 17890;

export interface DesktopBridgeServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(json);
}

function readChannelToken(req: http.IncomingMessage): string | undefined {
  const header = req.headers["x-channel-token"];
  if (typeof header === "string" && header.length > 0) return header;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }
  return undefined;
}

function requireChannelToken(req: http.IncomingMessage): boolean {
  const expected = process.env.DESKTOP_HOST_TOKEN;
  const got = readChannelToken(req);
  return Boolean(expected && got && got === expected);
}

const COMMANDS = new Set<DesktopMemoryCommand>([
  "memory.create",
  "memory.get",
  "memory.list",
  "memory.update",
  "memory.archive",
  "memory.restore",
  "memory.history",
  "memory.retrieve",
  "memory.context",
  "continuity.export",
  "continuity.inspect",
  "continuity.rehydrate",
  "cultivation.session.create",
  "cultivation.session.get",
  "cultivation.chat",
  "cultivation.proposal.reject",
  "cultivation.proposal.defer",
  "cultivation.proposal.accept",
]);

/**
 * Start HTTP bridge. Starts DesktopHost once (long-lived) with given options.
 * Binds 127.0.0.1 only. Channel Token required on /commands. No CORS *.
 */
export async function startDesktopBridgeServer(
  options: DesktopHostStartOptions & {
    port?: number;
    host?: string;
  } = {}
): Promise<DesktopBridgeServer> {
  const host = getDesktopHost();
  if (!host.isRunning) {
    await host.start({
      connectionString: options.connectionString,
      producer: options.producer ?? "v2-desktop-bridge",
      environment: options.environment ?? "development",
      migrate: options.migrate,
      harborPersistDir: options.harborPersistDir,
      actor: options.actor,
    });
  } else if (options.actor && !host.getSessionActor()) {
    host.attachActor(options.actor);
  }

  const requested = options.host ?? "127.0.0.1";
  if (requested !== "127.0.0.1" && requested !== "localhost") {
    throw new Error("Desktop bridge binds 127.0.0.1 only");
  }
  const bindHost = "127.0.0.1";
  const preferredPort =
    options.port ??
    Number(process.env.DESKTOP_HOST_PORT ?? DEFAULT_DESKTOP_HOST_PORT);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        send(res, 204, {});
        return;
      }

      const url = new URL(req.url ?? "/", `http://${bindHost}`);

      if (req.method === "GET" && url.pathname === "/health") {
        const st = host.status();
        send(res, st.running ? 200 : 503, {
          ok: st.running,
          ...st,
          path: "DesktopHost → MemoryCommandAdapter → PostgresEventStore",
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/status") {
        send(res, 200, host.status());
        return;
      }

      if (req.method === "POST" && url.pathname.startsWith("/commands/")) {
        if (!requireChannelToken(req)) {
          send(res, 401, { ok: false, error: "missing channel token" });
          return;
        }
        const command = url.pathname.slice("/commands/".length) as DesktopMemoryCommand;
        if (!COMMANDS.has(command)) {
          send(res, 404, { error: `unknown command: ${command}` });
          return;
        }
        const raw = await readBody(req);
        const args = raw ? JSON.parse(raw) : {};
        const result = await invokeDesktopCommand(command, args);
        send(res, 200, { ok: true, command, result });
        return;
      }

      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, {
        ok: false,
        error: formatV2Error(e),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort, bindHost, () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const url = `http://${bindHost}:${addr.port}`;

  return {
    port: addr.port,
    url,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
