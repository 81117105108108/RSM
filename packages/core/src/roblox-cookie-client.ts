export interface CookieImageUploadOptions {
  fileContent: Buffer;
  fileName: string;
  displayName: string;
  description: string;
  userId?: string;
  groupId?: string;
}

interface UserAuthAssetOperation {
  path?: string;
  operationId?: string;
  done?: boolean;
  response?: {
    assetId?: string | number;
    code?: string | number;
    message?: string;
  };
  error?: {
    code?: string | number;
    message?: string;
  };
  code?: string | number;
  message?: string;
}

export class RobloxCookieClient {
  private cookie: string;
  private csrfToken: string | null = null;
  private timeoutMs = 15_000;

  constructor(cookie?: string) {
    this.cookie = cookie || process.env.ROBLOSECURITY || '';
  }

  hasCookie(): boolean {
    return !!this.cookie;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async fetchTimeout(url: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  private async fetchWithCsrf(
    url: string,
    options: RequestInit = {},
    attempts = 3,
  ): Promise<Response> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      const headers: Record<string, string> = {
        Cookie: `.ROBLOSECURITY=${this.cookie}`,
        ...(options.headers as Record<string, string> || {}),
      };

      if (this.csrfToken) {
        headers['X-CSRF-TOKEN'] = this.csrfToken;
      }

      try {
        const response = await this.fetchTimeout(url, { ...options, headers });

        if (response.status === 403) {
          const newToken = response.headers.get('x-csrf-token');
          if (newToken) {
            this.csrfToken = newToken;
            headers['X-CSRF-TOKEN'] = newToken;
            return await this.fetchTimeout(url, { ...options, headers });
          }
        }
        if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
          lastErr = new Error(`HTTP ${response.status}`);
          if (i < attempts - 1) await this.sleep(250 * 2 ** i + Math.random() * 120);
          continue;
        }
        return response;
      } catch (e) {
        lastErr = e;
        if (i < attempts - 1) await this.sleep(250 * 2 ** i + Math.random() * 120);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async uploadImage(options: CookieImageUploadOptions): Promise<{ assetId: number }> {
    if (!this.cookie) {
      throw new Error('ROBLOSECURITY cookie is not set.');
    }

    const creator = await this.resolveCreator(options.userId, options.groupId);
    const request = {
      assetType: 'Image',
      displayName: options.displayName,
      description: options.description,
      creationContext: { creator },
    };
    const formData = new FormData();
    formData.append('request', JSON.stringify(request));
    formData.append(
      'fileContent',
      new Blob(
        [new Uint8Array(options.fileContent)],
        { type: this.getImageMimeType(options.fileName) },
      ),
      options.fileName,
    );

    const response = await this.fetchWithCsrf(
      'https://apis.roblox.com/assets/user-auth/v1/assets',
      {
        method: 'POST',
        body: formData,
      },
    );
    const operation = await this.readOperation(response, 'Image upload');
    return { assetId: await this.completeOperation(operation) };
  }

  private async resolveCreator(
    userId?: string,
    groupId?: string,
  ): Promise<{ userId: string } | { groupId: string }> {
    if (groupId) return { groupId };
    if (userId) return { userId };

    const response = await this.fetchWithCsrf(
      'https://users.roblox.com/v1/users/authenticated',
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to resolve authenticated Roblox user (${response.status}): ${body}`);
    }

    const authenticatedUser = await response.json() as { id?: number | string };
    const resolvedUserId = String(authenticatedUser.id ?? '');
    if (!/^\d+$/.test(resolvedUserId) || resolvedUserId === '0') {
      throw new Error('Authenticated Roblox user response did not include a valid user ID.');
    }
    return { userId: resolvedUserId };
  }

  private getImageMimeType(fileName: string): string {
    const extension = fileName.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      bmp: 'image/bmp',
      tga: 'image/tga',
    };
    const mimeType = extension ? mimeTypes[extension] : undefined;
    if (mimeType) return mimeType;
    throw new Error(
      `Unsupported image format: .${extension ?? '(none)'}. Supported: png/jpg/jpeg/bmp/tga`,
    );
  }

  private async readOperation(
    response: Response,
    action: string,
  ): Promise<UserAuthAssetOperation> {
    const body = await response.text();
    const capped = body.length > 5_000 ? `${body.slice(0, 5_000)}…` : body;
    if (!response.ok) {
      throw new Error(`${action} failed (${response.status}): ${capped}`);
    }

    try {
      return JSON.parse(body) as UserAuthAssetOperation;
    } catch {
      throw new Error(`${action} returned malformed JSON: ${capped}`);
    }
  }

  private operationAssetId(operation: UserAuthAssetOperation): number | null {
    const rawAssetId = operation.response?.assetId;
    if (rawAssetId === undefined) return null;
    const assetId = Number(rawAssetId);
    if (!Number.isSafeInteger(assetId) || assetId <= 0) {
      throw new Error(`Image upload returned an invalid asset ID: ${String(rawAssetId)}`);
    }
    return assetId;
  }

  private operationError(operation: UserAuthAssetOperation): string | null {
    if (operation.error?.message) return operation.error.message;
    if (operation.response?.message && operation.response.assetId === undefined) {
      return operation.response.message;
    }
    if (operation.message) return operation.message;
    return null;
  }

  private async completeOperation(operation: UserAuthAssetOperation): Promise<number> {
    const initialError = this.operationError(operation);
    if (initialError) throw new Error(`Image upload failed: ${initialError}`);

    const initialAssetId = this.operationAssetId(operation);
    if (initialAssetId !== null) return initialAssetId;
    if (operation.done) {
      throw new Error('Image upload completed without an asset ID.');
    }

    const operationId = operation.operationId ?? operation.path?.split('/').pop();
    if (!operationId) {
      throw new Error('Image upload response did not include an operation ID.');
    }
    return this.pollOperation(operationId);
  }

  private async pollOperation(
    operationId: string,
    maxAttempts = 20,
    intervalMs = 2000,
  ): Promise<number> {
    const url = `https://apis.roblox.com/assets/user-auth/v1/operations/${encodeURIComponent(operationId)}`;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await this.fetchWithCsrf(url);
      const operation = await this.readOperation(response, 'Image upload status');
      const operationError = this.operationError(operation);
      if (operationError) throw new Error(`Image upload failed: ${operationError}`);

      const assetId = this.operationAssetId(operation);
      if (assetId !== null) return assetId;
      if (operation.done) {
        throw new Error('Image upload completed without an asset ID.');
      }
      if (attempt < maxAttempts - 1) {
        const backoff = Math.min(intervalMs * 1.5 ** attempt, 10_000) + Math.random() * 250;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
    throw new Error(
      `Image upload timed out. Operation ID: ${operationId}`,
    );
  }

  async getAssetDetails(
    assetIds: number[]
  ): Promise<Array<Record<string, unknown>>> {
    if (!this.cookie) {
      throw new Error('ROBLOSECURITY cookie is not set.');
    }
    if (!Array.isArray(assetIds) || assetIds.length === 0 || assetIds.length > 100) {
      throw new Error('assetIds must be 1-100 asset IDs');
    }
    const clean = assetIds.map((id) => Math.floor(Number(id))).filter((id) => Number.isSafeInteger(id) && id > 0);
    if (clean.length !== assetIds.length) throw new Error('assetIds must all be positive integers');

    const response = await this.fetchWithCsrf(
      'https://itemconfiguration.roblox.com/v1/creations/get-asset-details',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds: clean }),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to get asset details (${response.status}): ${body}`);
    }

    return response.json() as Promise<Array<Record<string, unknown>>>;
  }
}
