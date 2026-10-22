import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from '@captiondoor/domain';
export { AppError as RingContractError } from '@captiondoor/domain';

export type RingMode = 'demo' | 'playground' | 'live';
const API_ORIGIN = 'https://api.amazonvision.com';
const TOKEN_URL = 'https://oauth.ring.com/oauth/token';
const AUTHORIZE_URL = 'https://account.ring.com/account/integrations/partner-link/authorize';
const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_SDP_BYTES = 64 * 1024;
export type RingWebhookEvent = {
  accountId: string; deliveryId: string; eventId: string; occurredAt: number;
  type: 'button_press' | 'device_removed' | 'device_offline' | 'app_integration_removed' | 'subscription_deactivated' | 'ignored';
  deviceId?: string; originalType: string;
};

/** Verify bytes before parsing. A signature authenticates Ring, not a selected household. */
export function verifyRingSignature(raw: Uint8Array | string, signature: string | null | undefined, signingKey: string): boolean {
  if (!signingKey) throw new AppError('RING_CREDENTIALS_REQUIRED', 503, 'Ring webhook verification is not configured.');
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
  if (bytes.length > MAX_WEBHOOK_BYTES) return false;
  const expected = createHmac('sha256', signingKey).update(bytes).digest();
  const validFormat = typeof signature === 'string' && /^sha256=[0-9a-f]{64}$/i.test(signature);
  const received = validFormat ? Buffer.from(signature!.slice(7), 'hex') : Buffer.alloc(32);
  return timingSafeEqual(expected, received) && validFormat;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_RING_EVENT', 400, 'Ring event structure is invalid.');
  return value as Record<string, unknown>;
}
function boundedString(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new AppError('INVALID_RING_EVENT', 400, 'Ring event field is invalid.');
  return value;
}
const optionalRecord = (value: unknown): Record<string, unknown> | undefined => value === undefined || value === null ? undefined : record(value);
export function normalizeRingWebhook(payload: unknown, allowedAccounts?: ReadonlySet<string>): RingWebhookEvent {
  const root = record(payload), meta = record(root.meta), data = record(root.data), attributes = record(data.attributes);
  if (meta.version !== '1.1') throw new AppError('UNSUPPORTED_RING_VERSION', 400, 'Ring webhook version is not supported.');
  const accountId = boundedString(meta.account_id, 256);
  if (allowedAccounts && !allowedAccounts.has(accountId)) throw new AppError('RING_ACCOUNT_DENIED', 403, 'Ring account is not linked.');
  const originalType = boundedString(data.type, 100);
  // Subscription lifecycle envelopes document meta.time without attributes.timestamp.
  const timestamp = attributes.timestamp ?? (attributes.source_type !== 'devices' && typeof meta.time === 'string' ? Date.parse(meta.time) : undefined);
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new AppError('INVALID_RING_EVENT', 400, 'Ring event timestamp is invalid.');
  const deviceId = attributes.source_type === 'devices' && typeof attributes.source === 'string' ? boundedString(attributes.source, 256) : undefined;
  if (originalType === 'button_press' && (!deviceId || attributes.source_type !== 'devices')) throw new AppError('INVALID_RING_EVENT', 400, 'Ring button press must name a device.');
  const types = ['button_press', 'device_removed', 'device_offline', 'app_integration_removed', 'subscription_deactivated'] as const;
  const type = types.find(t => t === originalType) ?? 'ignored';
  return { accountId, deliveryId: boundedString(meta.request_id, 256), eventId: boundedString(data.id), occurredAt: timestamp, type, deviceId, originalType };
}
export function parseRingWebhook(raw: Uint8Array | string, signature: string | null | undefined, signingKey: string, allowedAccounts?: ReadonlySet<string>): RingWebhookEvent {
  if (!verifyRingSignature(raw, signature, signingKey)) throw new AppError('INVALID_RING_SIGNATURE', 401, 'Ring signature is invalid.');
  let payload: unknown;
  try { payload = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); }
  catch { throw new AppError('INVALID_RING_EVENT', 400, 'Ring event is not valid JSON.'); }
  return normalizeRingWebhook(payload, allowedAccounts);
}
export function normalizeRingEvent(payload: unknown, allowedAccounts?: ReadonlySet<string>): { accountId: string; deviceId: string; eventId: string; deliveryId: string; occurredAt: number } | null {
  const event = normalizeRingWebhook(payload, allowedAccounts);
  return event.type === 'button_press' ? { accountId: event.accountId, deviceId: event.deviceId!, eventId: event.eventId, deliveryId: event.deliveryId, occurredAt: event.occurredAt } : null;
}

export type RingOAuthAttempt = { state: string; verifier: string; createdAt: number; expiresAt: number; redirectUri: string };
export function createRingOAuthAttempt(clientId: string, redirectUri: string, now = Date.now()): { attempt: RingOAuthAttempt; authorizationUrl: string } {
  if (!clientId) throw new AppError('RING_CREDENTIALS_REQUIRED', 503, 'Ring OAuth is not configured.');
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.hash) throw new AppError('RING_REDIRECT_INVALID', 500, 'Ring requires a registered HTTPS callback.');
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
  const authorizationUrl = new URL(AUTHORIZE_URL);
  authorizationUrl.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'ava.v1:read', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  return { attempt: { state, verifier, createdAt: now, expiresAt: now + 600_000, redirectUri }, authorizationUrl: authorizationUrl.toString() };
}
/** Caller atomically consumes the persisted attempt before exchanging its single-use code. */
export function validateRingOAuthState(attempt: RingOAuthAttempt, returnedState: string, now = Date.now()): void {
  const expected = Buffer.from(attempt.state), actual = Buffer.from(returnedState);
  const equal = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!equal || now < attempt.createdAt || now >= attempt.expiresAt) throw new AppError('RING_OAUTH_STATE_INVALID', 403, 'Ring linking attempt expired or did not match.');
}
export type RingTokens = { accessToken: string; refreshToken: string; expiresAt: number; tokenType: 'Bearer'; scope: string };
export type RingDevice = { id: string; type: string; attributes: Record<string, unknown>; raw: Record<string, unknown>; online?: boolean };
/** JSON:API related data lives in included[], joined using relationship type+id. */
export function parseRingDevices(payload: unknown): RingDevice[] {
  const body = record(payload);
  if (!Array.isArray(body.data)) throw new AppError('RING_INVALID_RESPONSE', 502, 'Ring returned an invalid device list.');
  const related = new Map<string, Record<string, unknown>>();
  if (Array.isArray(body.included)) for (const value of body.included) {
    const item = record(value);
    if (typeof item.type === 'string' && typeof item.id === 'string') related.set(`${item.type}\0${item.id}`, item);
  }
  return body.data.map(value => {
    const item = record(value), attributes = record(item.attributes);
    const relations = optionalRecord(item.relationships);
    const statusRelation = optionalRecord(relations?.status);
    const statusRef = optionalRecord(statusRelation?.data);
    const statusResource = statusRef && typeof statusRef.type === 'string' && typeof statusRef.id === 'string' ? related.get(`${statusRef.type}\0${statusRef.id}`) : undefined;
    const statusAttributes = optionalRecord(statusResource?.attributes);
    const online = statusAttributes && typeof statusAttributes.online === 'boolean' ? statusAttributes.online : undefined;
    return { id: boundedString(item.id, 256), type: boundedString(item.type, 100), attributes, raw: item, ...(online === undefined ? {} : { online }) };
  });
}
export type RingClientOptions = {
  mode: RingMode; accessToken?: string | (() => Promise<string>); clientId?: string; clientSecret?: string;
  fetch?: typeof fetch;
};
/** Persist this INTERNAL record server-side. Only id/answer/expiresAt may reach the browser. */
export type RingMediaSession = { id: string; deviceId: string; location: string; answer: string; expiresAt: number; source: 'PLAYGROUND' | 'LIVE' };

export function validateRingSessionLocation(location: string, deviceId: string): string {
  let url: URL;
  try { url = new URL(location); } catch { throw new AppError('RING_SESSION_URL_INVALID', 502, 'Ring returned an invalid media session.'); }
  const prefix = `/v1/devices/${encodeURIComponent(deviceId)}/media/streaming/whep/sessions/`;
  const suffix = url.pathname.slice(prefix.length);
  if (url.origin !== API_ORIGIN || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix) || !/^[A-Za-z0-9._~-]{1,512}$/.test(suffix) || suffix === '.' || suffix === '..') throw new AppError('RING_SESSION_URL_INVALID', 502, 'Ring returned an untrusted media session URL.');
  return url.toString();
}
export function validateReceiveOnlyOffer(offer: string): void {
  if (Buffer.byteLength(offer, 'utf8') > MAX_SDP_BYTES || !/^v=0\r?\n/.test(offer)) throw new AppError('INVALID_SDP', 400, 'Media offer is invalid.');
  if (/(?:^|\r?\n)a=(sendrecv|sendonly|inactive)(?:\r?\n|$)/.test(offer)) throw new AppError('INVALID_SDP', 400, 'Ring media must be receive-only.');
  const sections = offer.split(/\r?\nm=/), session = sections.shift()!;
  let video = 0, audio = 0;
  for (const section of sections) {
    const kind = section.split(' ')[0];
    if (kind === 'video') video++; else if (kind === 'audio') audio++; else throw new AppError('INVALID_SDP', 400, 'Only incoming audio and video are supported.');
    const direction = section.match(/(?:^|\r?\n)a=(recvonly|sendrecv|sendonly|inactive)(?:\r?\n|$)/)?.[1]
      ?? session.match(/(?:^|\r?\n)a=(recvonly|sendrecv|sendonly|inactive)(?:\r?\n|$)/)?.[1];
    if (direction !== 'recvonly') throw new AppError('INVALID_SDP', 400, 'Ring media must be receive-only.');
  }
  if (video !== 1 || audio > 1) throw new AppError('INVALID_SDP', 400, 'One incoming video track is required.');
}

export class RingClient {
  private readonly transport: typeof fetch;
  constructor(private readonly options: RingClientOptions) { this.transport = options.fetch ?? fetch; }
  private assertExternal(): void {
    if (this.options.mode === 'demo') throw new AppError('RING_LOCAL_MODE', 409, 'Local simulation does not call Ring.');
  }
  private async bearer(): Promise<string> {
    this.assertExternal();
    const token = typeof this.options.accessToken === 'function' ? await this.options.accessToken() : this.options.accessToken;
    if (!token || /[\r\n]/.test(token)) throw new AppError('RING_CREDENTIALS_REQUIRED', 503, 'Ring access credentials are unavailable.');
    return token;
  }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.bearer();
    try {
      const response = await this.transport(`${API_ORIGIN}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new AppError(response.status === 401 ? 'RING_ACCESS_EXPIRED' : response.status === 403 ? 'RING_ACCESS_DENIED' : 'RING_REQUEST_FAILED', response.status === 401 || response.status === 403 ? 403 : 502, 'Ring could not complete this request.');
      return response;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('RING_UNAVAILABLE', 502, 'Ring is unavailable. Text communication remains available.');
    }
  }
  private liveCredentials(): { clientId: string; clientSecret: string } {
    this.assertExternal();
    if (this.options.mode !== 'live') throw new AppError('RING_LINK_MODE_REQUIRED', 409, 'Playground tokens cannot link or refresh a Ring account.');
    const { clientId, clientSecret } = this.options;
    if (!clientId || !clientSecret) throw new AppError('RING_CREDENTIALS_REQUIRED', 503, 'Ring linking credentials are unavailable.');
    return { clientId, clientSecret };
  }
  private async tokenExchange(fields: Record<string, string>): Promise<RingTokens> {
    const credentials = this.liveCredentials();
    let response: Response;
    try { response = await this.transport(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...fields, client_id: credentials.clientId, client_secret: credentials.clientSecret }), redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
    catch { throw new AppError('RING_UNAVAILABLE', 502, 'Ring token service is unavailable.'); }
    if (!response.ok) throw new AppError('RING_TOKEN_EXCHANGE_FAILED', 502, 'Ring did not authorize the account. Re-linking may be required.');
    const body = record(await response.json());
    if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' || body.token_type !== 'Bearer' || typeof body.expires_in !== 'number' || body.expires_in <= 0) throw new AppError('RING_INVALID_RESPONSE', 502, 'Ring returned an invalid token response.');
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000, tokenType: 'Bearer', scope: typeof body.scope === 'string' ? body.scope : '' };
  }
  exchangeAuthorizationCode(code: string, verifier: string): Promise<RingTokens> {
    if (!code || verifier.length < 43 || verifier.length > 128) throw new AppError('RING_OAUTH_INVALID', 400, 'Ring authorization callback is invalid.');
    return this.tokenExchange({ grant_type: 'authorization_code', code, code_verifier: verifier });
  }
  refresh(refreshToken: string): Promise<RingTokens> {
    if (!refreshToken) throw new AppError('RING_CREDENTIALS_REQUIRED', 503, 'Ring refresh credentials are unavailable.');
    return this.tokenExchange({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }
  async getAccount(): Promise<Record<string, unknown>> { return record(await (await this.request('/v1/users/me')).json()); }
  async getAccountId(): Promise<string> {
    const data = record((await this.getAccount()).data);
    if (data.type !== 'users') throw new AppError('RING_INVALID_RESPONSE', 502, 'Ring returned an invalid account profile.');
    return boundedString(data.id, 256);
  }
  async listDevices(): Promise<RingDevice[]> {
    return parseRingDevices(await (await this.request('/v1/devices?include=capabilities,status')).json());
  }
  async getDeviceConfigurations(deviceId: string): Promise<Record<string, unknown>> { return record(await (await this.request(`/v1/devices/${encodeURIComponent(deviceId)}/configurations`)).json()); }
  async completeLink(maskedAccountIdentifier: string): Promise<void> {
    this.liveCredentials();
    if (!maskedAccountIdentifier.includes('*') || maskedAccountIdentifier.length > 256) throw new AppError('RING_ACCOUNT_IDENTIFIER_INVALID', 400, 'Use an obfuscated signed-in account identifier.');
    await this.request('/v1/accounts/me/app-integrations', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed', account_identifier: maskedAccountIdentifier }) });
  }
  /** Only partner-initiated OAuth apps. One-way linking must instruct removal in Ring. */
  async unlink(linkMethod: 'partner-oauth' | 'one-way' = 'partner-oauth'): Promise<void> {
    this.liveCredentials();
    if (linkMethod !== 'partner-oauth') throw new AppError('RING_UNLINK_IN_RING', 409, 'Remove this one-way integration in the Ring app.');
    await this.request('/v1/accounts/me/app-integrations', { method: 'DELETE' });
  }
  async createWhepSession(deviceId: string, offer: string, powerSource: 'battery' | 'line' = 'battery'): Promise<RingMediaSession> {
    validateReceiveOnlyOffer(offer);
    const configuration = record(record((await this.getDeviceConfigurations(deviceId)).data).attributes);
    const encryption = configuration.e2e_encryption;
    if (encryption && record(encryption).enabled === true) throw new AppError('RING_MEDIA_ENCRYPTED', 409, 'Encrypted Ring media is unavailable to this integration. Text remains available.');
    const response = await this.request(`/v1/devices/${encodeURIComponent(deviceId)}/media/streaming/whep/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' }, body: offer });
    if (response.status !== 201) throw new AppError('RING_INVALID_RESPONSE', 502, 'Ring did not create a media session.');
    const location = validateRingSessionLocation(response.headers.get('Location') ?? '', deviceId);
    const answer = await response.text();
    if (!/^v=0\r?\n/.test(answer) || Buffer.byteLength(answer) > MAX_SDP_BYTES) throw new AppError('RING_INVALID_RESPONSE', 502, 'Ring returned an invalid media answer.');
    return { id: randomUUID(), deviceId, location, answer, expiresAt: Date.now() + (powerSource === 'line' ? 60_000 : 30_000), source: this.options.mode === 'playground' ? 'PLAYGROUND' : 'LIVE' };
  }
  async closeWhepSession(session: Pick<RingMediaSession, 'location' | 'deviceId'>): Promise<void> {
    const url = new URL(validateRingSessionLocation(session.location, session.deviceId));
    await this.request(url.pathname, { method: 'DELETE' });
  }
}
