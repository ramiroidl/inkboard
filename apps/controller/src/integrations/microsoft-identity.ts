type FetchImplementation = typeof fetch;

/** Read-only access to tasks, a refresh token, and the account name for display. */
export const MICROSOFT_TODO_SCOPES = "openid profile offline_access Tasks.Read";
const AUTHORITY = "https://login.microsoftonline.com";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
  account: string | null;
}

export interface DeviceCodeSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
}

export type DevicePollResult =
  { status: "complete"; tokens: TokenSet } | { status: "pending"; slowDown: boolean };

/**
 * A Microsoft identity platform error. `requiresSignIn` marks errors only a new sign-in can
 * fix, such as a revoked or expired refresh token.
 */
export class MicrosoftAuthError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly requiresSignIn: boolean,
  ) {
    super(message);
  }
}

const SIGN_IN_ERRORS = new Set([
  "invalid_grant",
  "interaction_required",
  "consent_required",
  "login_required",
  "expired_token",
  "authorization_declined",
  "bad_verification_code",
]);

function accountFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== "string") {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const value = payload.preferred_username ?? payload.email ?? payload.name;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export class MicrosoftIdentityClient {
  public constructor(
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async startDeviceCode(clientId: string, tenant: string): Promise<DeviceCodeSession> {
    const body = await this.post(`${tenant}/oauth2/v2.0/devicecode`, {
      client_id: clientId,
      scope: MICROSOFT_TODO_SCOPES,
    });
    if (
      typeof body.device_code !== "string" ||
      typeof body.user_code !== "string" ||
      typeof body.verification_uri !== "string"
    ) {
      throw new MicrosoftAuthError(
        "Microsoft returned an invalid device code",
        "invalid_response",
        false,
      );
    }
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      expiresAt: this.now().getTime() + Number(body.expires_in ?? 900) * 1000,
      intervalSeconds: Math.max(1, Number(body.interval ?? 5)),
    };
  }

  public async pollDeviceCode(
    clientId: string,
    tenant: string,
    deviceCode: string,
  ): Promise<DevicePollResult> {
    try {
      const body = await this.post(`${tenant}/oauth2/v2.0/token`, {
        grant_type: DEVICE_CODE_GRANT,
        client_id: clientId,
        device_code: deviceCode,
      });
      return { status: "complete", tokens: this.toTokenSet(body, null) };
    } catch (error: unknown) {
      if (error instanceof MicrosoftAuthError) {
        if (error.code === "authorization_pending") {
          return { status: "pending", slowDown: false };
        }
        if (error.code === "slow_down") {
          return { status: "pending", slowDown: true };
        }
      }
      throw error;
    }
  }

  public async refresh(clientId: string, tenant: string, tokens: TokenSet): Promise<TokenSet> {
    const body = await this.post(`${tenant}/oauth2/v2.0/token`, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refreshToken,
      scope: MICROSOFT_TODO_SCOPES,
    });
    return this.toTokenSet(body, tokens);
  }

  private toTokenSet(body: Record<string, unknown>, previous: TokenSet | null): TokenSet {
    if (typeof body.access_token !== "string") {
      throw new MicrosoftAuthError("Microsoft returned no access token", "invalid_response", false);
    }
    const refreshToken =
      typeof body.refresh_token === "string" ? body.refresh_token : previous?.refreshToken;
    if (refreshToken === undefined) {
      throw new MicrosoftAuthError(
        "Microsoft returned no refresh token; offline_access is required",
        "invalid_response",
        true,
      );
    }
    return {
      accessToken: body.access_token,
      refreshToken,
      expiresAt: this.now().getTime() + Number(body.expires_in ?? 3600) * 1000,
      account: accountFromIdToken(body.id_token) ?? previous?.account ?? null,
    };
  }

  private async post(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetchImplementation(`${AUTHORITY}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
      const description =
        typeof body.error_description === "string"
          ? body.error_description.split(/\r?\n/)[0]!
          : `Microsoft sign-in returned HTTP ${response.status}`;
      throw new MicrosoftAuthError(description, code, SIGN_IN_ERRORS.has(code));
    }
    return body;
  }
}
