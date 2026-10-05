/**
 * Sign-in to a remote (hosted) mount: a file-backed OAuth client for the MCP SDK and the
 * interactive browser flow behind `ynm login` (ADR-017, ADR-004).
 *
 * The local ynm is a public OAuth client: it registers itself with the server's identity
 * provider (dynamic client registration), signs the person in with PKCE through a loopback
 * redirect (RFC 8252), and keeps the result in `<ynmHome>/auth/<mount>.json`, readable only by
 * its owner. Tokens are never printed or logged.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  auth,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { tracedFetch } from "@ynm/telemetry";

/** Where a remote mount's credentials live: <ynmHome>/auth/<mountId>.json, mode 0600, dir 0700. */
export function remoteAuthPath(home: string, mountId: string): string {
  return join(home, "auth", `${encodeURIComponent(mountId)}.json`);
}

/** What one mount's credentials file holds. `url` binds them to the endpoint they were issued for. */
interface StoredRemoteAuth {
  url: string;
  /** The redirect URI the stored client registration was made with. */
  redirectUrl?: string;
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  codeVerifier?: string;
  /** Discovery results; the SDK checks the callback against them, so they outlive the redirect. */
  discovery?: OAuthDiscoveryState;
}

function readStored(home: string, mountId: string, url: string): StoredRemoteAuth {
  const file = remoteAuthPath(home, mountId);
  if (!existsSync(file)) return { url };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { url };
  }
  const stored = parsed as Partial<StoredRemoteAuth> | null;
  // A mount re-pointed at another server must sign in again: its credentials belong to the old one.
  if (!stored || stored.url !== url) return { url };
  return stored as StoredRemoteAuth;
}

function writeStored(home: string, mountId: string, stored: StoredRemoteAuth): void {
  const file = remoteAuthPath(home, mountId);
  const dir = join(home, "auth");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // Temp file + rename: a crash mid-write never leaves half a credentials file behind.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Raised when the server wants an interactive sign-in and this process cannot run one. */
export class RemoteSignInRequiredError extends Error {
  constructor(readonly mountId: string) {
    super(`not signed in to ${mountId}: run \`ynm login ${mountId}\``);
    this.name = "RemoteSignInRequiredError";
  }
}

/** Placeholder redirect for a provider built outside `ynm login`; login replaces it with a live port. */
const DEFAULT_REDIRECT = "http://127.0.0.1/callback";

export interface FileOAuthProviderOptions {
  home: string;
  mountId: string;
  url: string;
  /** Loopback redirect URI; default the one the stored registration was made with. */
  redirectUrl?: string;
  /**
   * Called with the authorization URL when the server needs the person to sign in. Without it the
   * provider throws {@link RemoteSignInRequiredError}: only `ynm login` opens a browser.
   */
  onAuthorize?: (url: URL) => void | Promise<void>;
}

/** A file-backed OAuthClientProvider for one remote mount. */
export class FileOAuthProvider implements OAuthClientProvider {
  readonly home: string;
  readonly mountId: string;
  readonly url: string;
  private readonly _redirectUrl: string;
  private readonly onAuthorize?: (url: URL) => void | Promise<void>;
  private _state?: string;

  constructor(opts: FileOAuthProviderOptions) {
    this.home = opts.home;
    this.mountId = opts.mountId;
    this.url = opts.url;
    this.onAuthorize = opts.onAuthorize;
    this._redirectUrl = opts.redirectUrl ?? this.read().redirectUrl ?? DEFAULT_REDIRECT;
  }

  private read(): StoredRemoteAuth {
    return readStored(this.home, this.mountId, this.url);
  }

  private update(change: (stored: StoredRemoteAuth) => void): void {
    const stored = this.read();
    change(stored);
    writeStored(this.home, this.mountId, stored);
  }

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  /** The redirect URI the stored client registration was made with, if any. */
  get registeredRedirectUrl(): string | undefined {
    const stored = this.read();
    return stored.clientInformation ? stored.redirectUrl : undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "ynm",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // A public client: PKCE proves possession, there is no secret to keep.
      token_endpoint_auth_method: "none",
    };
  }

  /** A fresh state per authorization request; the callback must echo the latest one. */
  state(): string {
    this._state = randomBytes(16).toString("base64url");
    return this._state;
  }

  /** The state sent with the latest authorization request. */
  get lastState(): string | undefined {
    return this._state;
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.read().clientInformation;
  }

  saveClientInformation(info: StoredOAuthClientInformation): void {
    this.update((s) => {
      s.clientInformation = info;
      s.redirectUrl = this._redirectUrl;
    });
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.update((s) => {
      s.tokens = tokens;
      // A code verifier is single-use; once it has bought tokens it is only a liability.
      delete s.codeVerifier;
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.onAuthorize) throw new RemoteSignInRequiredError(this.mountId);
    await this.onAuthorize(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.update((s) => {
      s.codeVerifier = codeVerifier;
    });
  }

  codeVerifier(): string {
    const verifier = this.read().codeVerifier;
    if (!verifier) throw new Error(`no sign-in in progress for ${this.mountId}`);
    return verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.update((s) => {
      s.discovery = state;
    });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.read().discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") {
      rmSync(remoteAuthPath(this.home, this.mountId), { force: true });
      return;
    }
    this.update((s) => {
      if (scope === "client") {
        delete s.clientInformation;
        delete s.redirectUrl;
      } else if (scope === "tokens") delete s.tokens;
      else if (scope === "verifier") delete s.codeVerifier;
      else delete s.discovery;
    });
  }
}

export interface LoginRemoteOptions {
  home: string;
  mountId: string;
  url: string;
  /** Opens the sign-in page; default the platform's opener. A failure only means the person opens the printed URL. */
  openBrowser?: (url: URL) => Promise<void>;
  /** Where progress lines go; default stderr. Never given a token. */
  print?: (line: string) => void;
  /** How long to wait for the browser to come back; default five minutes. */
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Signs in interactively: runs the browser flow and stores tokens. Resolves when signed in.
 *
 * Redirect strategy: the loopback listener reuses the port the stored client was registered with
 * when that port is free, so a returning person keeps one registration. When it is taken (or
 * nothing is registered yet) the listener takes any free port and the client registers again,
 * because Keycloak and most identity providers match redirect URIs exactly (RFC 8252 allows any
 * loopback port, but the registration must name the one used). A refresh that succeeds needs no
 * redirect at all, so the old registration is kept until a browser sign-in is actually needed.
 */
export async function loginRemote(opts: LoginRemoteOptions): Promise<{ scopes?: string }> {
  const print = opts.print ?? ((line: string) => console.error(line));
  const openBrowser = opts.openBrowser ?? openInBrowser;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const registered = new FileOAuthProvider(opts).registeredRedirectUrl;
  const server = await listenLoopback(loopbackPort(registered));
  const port = (server.address() as AddressInfo).port;
  const redirectUrl = `http://127.0.0.1:${port}/callback`;
  let authorizationUrl: URL | undefined;
  const provider = new FileOAuthProvider({
    home: opts.home,
    mountId: opts.mountId,
    url: opts.url,
    redirectUrl,
    onAuthorize: (u) => {
      authorizationUrl = u;
    },
  });
  const signedIn = () => ({ scopes: provider.tokens()?.scope });
  // Discovery, registration and the token exchange carry the command's trace headers.
  const authOpts = { serverUrl: opts.url, fetchFn: tracedFetch(opts.fetchFn) };
  let timer: NodeJS.Timeout | undefined;
  try {
    const callback = awaitCallback(server, () => provider.lastState);
    // Settled rejections are handled below; this keeps an early failure from going unhandled.
    callback.catch(() => {});
    let result = await auth(provider, authOpts);
    if (result === "AUTHORIZED") return signedIn();
    if (provider.registeredRedirectUrl !== redirectUrl) {
      // Registered with another port (or a placeholder): register again with this one.
      provider.invalidateCredentials("client");
      authorizationUrl = undefined;
      result = await auth(provider, authOpts);
      if (result === "AUTHORIZED") return signedIn();
    }
    if (!authorizationUrl) throw new Error("the server asked for a sign-in but gave no address");
    print(`Open this URL to sign in: ${authorizationUrl.href}`);
    try {
      await openBrowser(authorizationUrl);
    } catch {
      // The printed URL is the fallback.
    }
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("sign-in timed out")), timeoutMs);
    });
    const { code, iss } = await Promise.race([callback, timeout]);
    const final = await auth(provider, { ...authOpts, authorizationCode: code, iss });
    if (final !== "AUTHORIZED") throw new Error("sign-in did not complete");
    return signedIn();
  } finally {
    if (timer) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Forgets the stored credentials (client registration and tokens). */
export async function logoutRemote(opts: { home: string; mountId: string }): Promise<boolean> {
  const file = remoteAuthPath(opts.home, opts.mountId);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/** Whether credentials are stored (doctor/status use it); with `url`, only those issued for it. */
export function hasRemoteCredentials(home: string, mountId: string, url?: string): boolean {
  const file = remoteAuthPath(home, mountId);
  if (!existsSync(file)) return false;
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredRemoteAuth>;
    if (url !== undefined && stored.url !== url) return false;
    return Boolean(stored.tokens);
  } catch {
    return false;
  }
}

function loopbackPort(redirectUrl: string | undefined): number {
  if (!redirectUrl) return 0;
  try {
    const u = new URL(redirectUrl);
    return u.hostname === "127.0.0.1" && u.port ? Number(u.port) : 0;
  } catch {
    return 0;
  }
}

/** Listens on 127.0.0.1, on `port` when it is free, otherwise on any free port. */
async function listenLoopback(port: number): Promise<Server> {
  const attempt = (p: number) =>
    new Promise<Server>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(p, "127.0.0.1", () => {
        server.off("error", reject);
        resolve(server);
      });
    });
  if (port === 0) return attempt(0);
  try {
    return await attempt(port);
  } catch {
    return attempt(0);
  }
}

const PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>ynm</title><p style="font-family:system-ui,sans-serif">${message}</p>`;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

/** Resolves with the authorization code the identity provider sends back to /callback. */
function awaitCallback(
  server: Server,
  expectedState: () => string | undefined
): Promise<{ code: string; iss?: string }> {
  return new Promise((resolve, reject) => {
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const reply = (status: number, message: string) =>
        res
          .writeHead(status, { "Content-Type": "text/html; charset=utf-8", Connection: "close" })
          .end(PAGE(message));
      const error = u.searchParams.get("error");
      if (error) {
        const description = u.searchParams.get("error_description") ?? error;
        reply(400, `Sign-in failed: ${escapeHtml(description)}`);
        reject(new Error(`sign-in failed: ${description}`));
        return;
      }
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      const expected = expectedState();
      if (!code || (expected !== undefined && state !== expected)) {
        // A stray or forged request: refuse it and keep waiting for the real one.
        reply(400, "This sign-in link is not the one ynm is waiting for.");
        return;
      }
      reply(200, "Signed in to ynm. You can close this tab.");
      resolve({ code, iss: u.searchParams.get("iss") ?? undefined });
    });
  });
}

/** Opens `url` with the platform's opener; rejects when the opener cannot start. */
function openInBrowser(url: URL): Promise<void> {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url.href]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url.href.replace(/&/g, "^&")]]
        : ["xdg-open", [url.href]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
