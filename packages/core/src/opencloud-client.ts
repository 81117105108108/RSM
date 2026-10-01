export interface OpenCloudConfig {
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
}

export type CreatorStoreSearchCategory =
  | 'Audio'
  | 'Model'
  | 'Decal'
  | 'Plugin'
  | 'MeshPart'
  | 'Video'
  | 'FontFamily';

export interface AssetSearchParams {
  searchCategoryType: CreatorStoreSearchCategory;
  query?: string;
  pageToken?: string;
  pageNumber?: number;
  maxPageSize?: number;
  sortDirection?: 'None' | 'Ascending' | 'Descending';
  sortCategory?: 'Relevance' | 'Trending' | 'Top' | 'AudioDuration' | 'CreateTime' | 'UpdatedTime' | 'Ratings';
  userId?: number;
  groupId?: number;
}

export interface CreatorInfo {
  userId?: number;
  groupId?: number;
  name?: string;
  verified?: boolean;
}

export interface VotingInfo {
  showVotes: boolean;
  upVotes: number;
  downVotes: number;
  canVote: boolean;
  voteCount: number;
  upVotePercent: number;
}

export interface AssetInfo {
  id: number;
  textureId?: number;
  name: string;
  description?: string;
  assetTypeId?: number;
  durationSeconds?: number;
  createTime?: string;
  updateTime?: string;
  categoryPath?: string;
}

export interface CreatorStoreAsset {
  voting?: VotingInfo;
  creator?: CreatorInfo;
  asset?: AssetInfo;
  creatorStoreProduct?: {
    purchasable: boolean;
    purchasePrice?: {
      currencyCode: string;
      quantity: {
        significand: number;
        exponent: number;
      };
    };
  };
}

export interface AssetSearchResponse {
  nextPageToken?: string;
  creatorStoreAssets: CreatorStoreAsset[];
  totalResults: number;
  filteredKeyword?: string;
}

export interface ThumbnailResponse {
  targetId: number;
  state: 'Completed' | 'Pending' | 'Error' | 'Blocked';
  imageUrl?: string;
}

export type AssetType = 'Audio' | 'Decal' | 'Model' | 'Animation' | 'Video';

export interface AssetUploadRequest {
  assetType: AssetType;
  displayName: string;
  description: string;
  creationContext: {
    creator: {
      userId?: string;
      groupId?: string;
    };
  };
}

export interface AssetOperationResponse {
  path: string;
  done: boolean;
  response?: {
    '@type': string;
    assetId: string;
    displayName: string;
    assetType: string;
    revisionId?: string;
    revisionCreateTime?: string;
  };
  error?: {
    code: number;
    message: string;
  };
}

export interface AssetVersionInfo {
  path: string;
  createTime?: string;
  creationContext?: {
    creator?: {
      userId?: string;
      groupId?: string;
    };
  };
  moderationResult?: {
    moderationState?: string;
  };
  published?: boolean;
}

export interface AssetVersionsResponse {
  assetVersions: AssetVersionInfo[];
  nextPageToken?: string;
}

export interface DownloadedAudioAsset {
  data: Buffer;
  mimeType: 'audio/mpeg' | 'audio/ogg' | 'audio/wav' | 'audio/flac';
}

type AssetDeliveryResponse = {
  location?: string;
  errors?: Array<{
    code?: number;
    message?: string;
  }>;
};

function detectAudioMimeType(
  data: Buffer,
): DownloadedAudioAsset['mimeType'] | undefined {
  if (data.length >= 4 && data.subarray(0, 4).toString('ascii') === 'OggS') {
    return 'audio/ogg';
  }
  if (data.length >= 4 && data.subarray(0, 4).toString('ascii') === 'fLaC') {
    return 'audio/flac';
  }
  if (
    data.length >= 12
    && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return 'audio/wav';
  }
  if (
    data.length >= 3
    && (
      data.subarray(0, 3).toString('ascii') === 'ID3'
      || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)
    )
  ) {
    return 'audio/mpeg';
  }
  return undefined;
}

export class OpenCloudClient {
  private apiKey: string;
  private baseUrl: string;
  private timeout: number;
  private cache = new Map<string, { exp: number; val: unknown }>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(config: OpenCloudConfig = {}) {
    this.apiKey = config.apiKey || process.env.ROBLOX_OPEN_CLOUD_API_KEY || '';
    this.baseUrl = config.baseUrl || 'https://apis.roblox.com';
    this.timeout = config.timeout && Number.isFinite(config.timeout)
      ? Math.min(Math.max(config.timeout, 2000), 60_000) : 15_000;
  }

  hasApiKey(): boolean {
    return !!this.apiKey;
  }

  private cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.exp > now) return Promise.resolve(hit.val as T);
    const f = this.inflight.get(key) as Promise<T> | undefined;
    if (f) return f;
    const p = fn().then((v) => {
      const isNull = v === null || v === undefined;
      if (!isNull) {
        if (this.cache.size > 300) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(key, { exp: Date.now() + ttlMs, val: v });
      }
      this.inflight.delete(key);
      return v;
    }).catch((e) => { this.inflight.delete(key); throw e; });
    this.inflight.set(key, p);
    return p;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async fetchRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
    const caller = init.signal as AbortSignal | undefined;
    if (caller?.aborted) throw new DOMException('Aborted', 'AbortError');
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeout);
      const onAbort = () => ctrl.abort();
      caller?.addEventListener?.('abort', onAbort, { once: true });
      try {
        const res = await fetch(url, { ...init, signal: ctrl.signal });
        if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
          const ra = Number(res.headers.get('retry-after'));
          await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 4000) : 250 * 2 ** i + Math.random() * 120);
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        return res;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError' && caller?.aborted) throw e;
        lastErr = e;
        if (i < attempts - 1) await this.sleep(250 * 2 ** i + Math.random() * 120);
      } finally {
        clearTimeout(t);
        caller?.removeEventListener?.('abort', onAbort);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async request<T>(
    endpoint: string,
    options: {
      method?: string;
      params?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      authRequired?: boolean;
    } = {}
  ): Promise<T> {
    const { method = 'GET', params, body, authRequired = true } = options;

    if (authRequired && !this.apiKey) {
      throw new Error(
        'Open Cloud API key not configured. Set ROBLOX_OPEN_CLOUD_API_KEY environment variable.'
      );
    }

    const url = new URL(`${this.baseUrl}${endpoint}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (authRequired && this.apiKey) {
        headers['x-api-key'] = this.apiKey;
      }

      const response = await this.fetchRetry(url.toString(), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      }, 3);

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage: string;
        try {
          const errorJson = JSON.parse(errorBody);
          errorMessage = errorJson.detail || errorJson.message || errorBody;
        } catch {
          errorMessage = errorBody;
        }

        if (response.status === 401) {
          throw new Error('Invalid or expired API key');
        } else if (response.status === 403) {
          throw new Error(`API key lacks required permissions: ${errorMessage}`);
        } else if (response.status === 429) {
          throw new Error('Rate limit exceeded. Please try again later.');
        } else {
          throw new Error(`Open Cloud API error (${response.status}): ${errorMessage}`);
        }
      }

      return (await response.json()) as T;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('Request timed out');
        }
        throw error;
      }
      throw new Error(`Unknown error: ${String(error)}`);
    }
  }

  async searchAssets(params: AssetSearchParams): Promise<AssetSearchResponse> {
    const q = typeof params.query === 'string' ? params.query.slice(0, 200) : params.query;
    const size = params.maxPageSize && Number.isFinite(params.maxPageSize)
      ? Math.min(Math.max(Math.floor(params.maxPageSize), 1), 100) : 25;
    const key = `s:${params.searchCategoryType}:${q ?? ''}:${size}:${params.sortCategory ?? ''}:${params.sortDirection ?? ''}:${params.userId ?? ''}:${params.groupId ?? ''}:${params.pageNumber ?? ''}:${params.pageToken ?? ''}`;
    return this.cached(key, 60_000, () => this.request<AssetSearchResponse>('/toolbox-service/v2/assets:search', {
      authRequired: false,
      params: {
        searchCategoryType: params.searchCategoryType,
        query: q,
        pageToken: params.pageToken,
        pageNumber: params.pageNumber,
        maxPageSize: size,
        sortDirection: params.sortDirection,
        sortCategory: params.sortCategory,
        userId: params.userId,
        groupId: params.groupId,
      },
    }));
  }

  async getAssetDetails(assetId: number): Promise<CreatorStoreAsset> {
    if (!Number.isFinite(assetId) || assetId <= 0) throw new Error(`Invalid assetId ${String(assetId)}`);
    const id = Math.floor(assetId);
    return this.cached(`d:${id}`, 300_000, () => this.request<CreatorStoreAsset>(`/toolbox-service/v2/assets/${id}`, {
      authRequired: false,
    }));
  }

  async listAssetVersions(
    assetId: number | string,
    maxPageSize = 10,
    pageToken?: string,
  ): Promise<AssetVersionsResponse> {
    return this.request<AssetVersionsResponse>(`/assets/v1/assets/${assetId}/versions`, {
      params: {
        maxPageSize,
        pageToken,
      },
    });
  }

  async getAssetThumbnail(
    assetId: number,
    size: '150x150' | '420x420' | '768x432' = '420x420'
  ): Promise<{ base64: string; mimeType: string } | null> {
    if (!Number.isFinite(assetId) || assetId <= 0) return null;
    const id = Math.floor(assetId);
    return this.cached(`t:${id}:${size}`, 300_000, async () => {
      const url = `https://thumbnails.roblox.com/v1/assets?assetIds=${id}&size=${size}&format=Png`;

      try {
        const response = await this.fetchRetry(url, {}, 2);
        if (!response.ok) return null;

        const data = (await response.json()) as { data: ThumbnailResponse[] };
        const thumbnail = data.data[0];

        if (!thumbnail || thumbnail.state !== 'Completed' || !thumbnail.imageUrl) {
          return null;
        }

        // Fetch the actual image and convert to base64
        const imageResponse = await this.fetchRetry(thumbnail.imageUrl, {}, 2);
        if (!imageResponse.ok) return null;

        const arrayBuffer = await imageResponse.arrayBuffer();
        if (arrayBuffer.byteLength > 3_000_000) return null;
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        return { base64, mimeType: 'image/png' };
      } catch {
        return null;
      }
    });
  }

  async getAssetThumbnails(
    assetIds: number[],
    size: '150x150' | '420x420' | '768x432' = '420x420'
  ): Promise<Map<number, string>> {
    const result = new Map<number, string>();
    if (assetIds.length === 0) return result;

    const batches = [];
    for (let i = 0; i < assetIds.length; i += 100) {
      batches.push(assetIds.slice(i, i + 100));
    }

    for (const batch of batches) {
      const url = `https://thumbnails.roblox.com/v1/assets?assetIds=${batch.join(',')}&size=${size}&format=Png`;
      try {
        const response = await fetch(url);
        if (response.ok) {
          const data = (await response.json()) as { data: ThumbnailResponse[] };
          for (const thumbnail of data.data) {
            if (thumbnail.state === 'Completed' && thumbnail.imageUrl) {
              result.set(thumbnail.targetId, thumbnail.imageUrl);
            }
          }
        }
      } catch {
        // Continue with other batches on failure
      }
    }

    return result;
  }

  async downloadAudioAssetContent(
    assetId: number,
    maxBytes: number,
  ): Promise<DownloadedAudioAsset> {
    if (!this.apiKey) {
      throw new Error(
        'Open Cloud API key not configured. Set ROBLOX_OPEN_CLOUD_API_KEY with asset:read permission to download audio previews.',
      );
    }
    if (!Number.isSafeInteger(assetId) || assetId <= 0) {
      throw new Error('Audio asset ID must be a positive integer.');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('Audio preview byte limit must be a positive integer.');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const deliveryResponse = await fetch(
        `${this.baseUrl}/asset-delivery-api/v1/assetId/${assetId}`,
        {
          headers: {
            'x-api-key': this.apiKey,
          },
          signal: controller.signal,
        },
      );
      if (!deliveryResponse.ok) {
        throw new Error(
          `Roblox asset delivery request failed (${deliveryResponse.status}).`,
        );
      }

      const delivery = await deliveryResponse.json() as AssetDeliveryResponse;
      if (!delivery.location) {
        const detail = delivery.errors
          ?.map((entry) => entry.message)
          .filter((message): message is string => !!message)
          .join('; ');
        throw new Error(detail || 'Roblox asset delivery returned no download location.');
      }

      const location = new URL(delivery.location);
      if (
        location.protocol !== 'https:'
        || !(
          location.hostname === 'contentdelivery.roblox.com'
          || location.hostname === 'rbxcdn.com'
          || location.hostname.endsWith('.rbxcdn.com')
        )
      ) {
        throw new Error('Roblox asset delivery returned an untrusted download location.');
      }

      const contentResponse = await fetch(location, {
        signal: controller.signal,
      });
      if (!contentResponse.ok) {
        throw new Error(
          `Roblox audio download failed (${contentResponse.status}).`,
        );
      }

      const declaredLength = Number(contentResponse.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error(`Audio asset exceeds the ${maxBytes}-byte preview limit.`);
      }
      if (!contentResponse.body) {
        throw new Error('Roblox audio download returned an empty body.');
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const reader = contentResponse.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new Error(`Audio asset exceeds the ${maxBytes}-byte preview limit.`);
        }
        chunks.push(Buffer.from(value));
      }

      const data = Buffer.concat(chunks, totalBytes);
      if (data.length === 0) {
        throw new Error('Roblox audio download returned no bytes.');
      }
      const mimeType = detectAudioMimeType(data);
      if (!mimeType) {
        throw new Error('Downloaded asset is not a supported MP3, OGG, WAV, or FLAC audio file.');
      }
      return { data, mimeType };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Audio preview download timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async createAsset(
    uploadRequest: AssetUploadRequest,
    fileContent: Buffer,
    fileName: string
  ): Promise<AssetOperationResponse> {
    const formData = new FormData();
    formData.append('request', JSON.stringify(uploadRequest));
    formData.append(
      'fileContent',
      new Blob([new Uint8Array(fileContent)], { type: this.getMimeType(fileName) }),
      fileName
    );

    const operation = await this.requestMultipart<AssetOperationResponse>(
      '/assets/v1/assets',
      formData
    );
    if (operation.done) return operation;
    return this.pollOperation(operation.path);
  }

  private getMimeType(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      // Image (Decal)
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      bmp: 'image/bmp',
      tga: 'image/tga',
      // Audio
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      wav: 'audio/wav',
      flac: 'audio/flac',
      // Model
      fbx: 'model/fbx',
      gltf: 'model/gltf+json',
      glb: 'model/gltf-binary',
      rbxm: 'model/x-rbxm',
      rbxmx: 'model/x-rbxm',
      // Video
      mp4: 'video/mp4',
      mov: 'video/mov',
    };
    if (!ext || !mimeTypes[ext]) {
      throw new Error(
        `Unsupported file format: .${ext ?? '(none)'}. Supported: ` +
        'Image: png/jpg/bmp/tga, Audio: mp3/ogg/wav/flac, Model: fbx/gltf/glb/rbxm/rbxmx, Video: mp4/mov'
      );
    }
    return mimeTypes[ext];
  }

  private async requestMultipart<T>(
    endpoint: string,
    formData: FormData
  ): Promise<T> {
    if (!this.apiKey) {
      throw new Error(
        'Open Cloud API key not configured. Set ROBLOX_OPEN_CLOUD_API_KEY environment variable.'
      );
    }

    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey },
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage: string;
        try {
          const errorJson = JSON.parse(errorBody);
          errorMessage = errorJson.detail || errorJson.message || errorBody;
        } catch {
          errorMessage = errorBody;
        }

        if (response.status === 401) {
          throw new Error('Invalid or expired API key');
        } else if (response.status === 403) {
          throw new Error(`API key lacks required permissions: ${errorMessage}`);
        } else if (response.status === 429) {
          throw new Error('Rate limit exceeded. Please try again later.');
        } else {
          throw new Error(`Open Cloud API error (${response.status}): ${errorMessage}`);
        }
      }

      return (await response.json()) as T;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('Request timed out');
        }
        throw error;
      }
      throw new Error(`Unknown error: ${String(error)}`);
    }
  }

  private async pollOperation(
    operationPath: string,
    maxAttempts = 30,
    intervalMs = 2000
  ): Promise<AssetOperationResponse> {
    const operationId = operationPath.replace('operations/', '');
    for (let i = 0; i < maxAttempts; i++) {
      const result = await this.request<AssetOperationResponse>(
        `/assets/v1/operations/${operationId}`
      );
      if (result.done) return result;
      if (result.error) {
        throw new Error(`Asset upload failed: ${result.error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `Asset upload timed out after ${(maxAttempts * intervalMs) / 1000}s. Operation ID: ${operationId}`
    );
  }
}
