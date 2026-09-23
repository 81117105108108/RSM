import type { CreatorStoreSearchCategory } from '../opencloud-client.js';
import { asRecord, asRows, numberField, optionalNumberField, stringField } from './util.js';

const MAX_SEARCH_ASSET_DESCRIPTION_LENGTH = 240;
const MAX_ASSET_PREVIEW_HIERARCHY_NODES = 100;

export const CREATOR_STORE_SEARCH_TYPES = new Set<string>([
  'Audio',
  'Model',
  'Decal',
  'Plugin',
  'MeshPart',
  'Video',
  'FontFamily',
  'Image',
  'Particle',
  'VFX',
]);
export const CREATOR_STORE_SORT_CATEGORIES = new Set<string>([
  'Relevance',
  'Trending',
  'Top',
  'AudioDuration',
  'CreateTime',
  'UpdatedTime',
  'Ratings',
]);
export function normalizeCreatorStoreSearch(
  assetType: string,
  query?: string,
): {
  requestedAssetType: string;
  searchCategoryType: CreatorStoreSearchCategory;
  effectiveQuery?: string;
} {
  if (!CREATOR_STORE_SEARCH_TYPES.has(assetType)) {
    throw new Error(
      `search_assets assetType must be one of: ${Array.from(CREATOR_STORE_SEARCH_TYPES).join(', ')}`,
    );
  }

  const trimmedQuery = query?.trim() || undefined;
  if (assetType === 'Image') {
    return {
      requestedAssetType: assetType,
      searchCategoryType: 'Decal',
      effectiveQuery: trimmedQuery,
    };
  }

  if (assetType === 'Particle' || assetType === 'VFX') {
    const suffix = assetType === 'Particle' ? 'particle effect' : 'VFX';
    const alreadyEffectSpecific = trimmedQuery !== undefined && /\b(?:particle|vfx|effect)\b/i.test(trimmedQuery);
    return {
      requestedAssetType: assetType,
      searchCategoryType: 'Model',
      effectiveQuery: trimmedQuery
        ? alreadyEffectSpecific ? trimmedQuery : `${trimmedQuery} ${suffix}`
        : suffix,
    };
  }

  return {
    requestedAssetType: assetType,
    searchCategoryType: assetType as CreatorStoreSearchCategory,
    effectiveQuery: trimmedQuery,
  };
}

export function normalizeSearchAssetDescription(description: string | undefined): string {
  const normalized = description?.replace(/\s+/g, ' ').trim() ?? '';
  if (normalized.length <= MAX_SEARCH_ASSET_DESCRIPTION_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_SEARCH_ASSET_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

export function robloxAssetIdFromContentId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  const direct = /^(?:rbxassetid:\/\/)?(\d+)$/.exec(trimmed);
  const query = /[?&]id=(\d+)(?:&|$)/i.exec(trimmed);
  const rawId = direct?.[1] ?? query?.[1];
  if (!rawId) return undefined;

  const parsed = Number(rawId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function compactPreviewHierarchy(value: unknown): {
  hierarchy: Record<string, unknown>[];
  truncated: boolean;
} {
  let remaining = MAX_ASSET_PREVIEW_HIERARCHY_NODES;
  let truncated = false;

  const compactNode = (row: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (remaining <= 0) {
      truncated = true;
      return undefined;
    }
    remaining--;

    const node: Record<string, unknown> = {
      name: stringField(row, 'name'),
      className: stringField(row, 'className'),
    };
    const properties = asRecord(row.properties);
    if (properties && Object.keys(properties).length > 0) {
      node.properties = properties;
    }

    const children = asRows(row.children);
    if (children.length > 0) {
      const compactedChildren: Record<string, unknown>[] = [];
      for (const child of children) {
        const compacted = compactNode(child);
        if (!compacted) break;
        compactedChildren.push(compacted);
      }
      if (compactedChildren.length > 0) {
        node.children = compactedChildren;
      }
      if (compactedChildren.length < children.length) {
        node.childCount = children.length;
        node.truncated = true;
        truncated = true;
      }
    } else if (row.truncated === true) {
      node.truncated = true;
      const childCount = numberField(row, 'childCount');
      if (childCount > 0) node.childCount = childCount;
    }
    return node;
  };

  const hierarchy: Record<string, unknown>[] = [];
  for (const root of asRows(value)) {
    const compacted = compactNode(root);
    if (!compacted) break;
    hierarchy.push(compacted);
  }
  return { hierarchy, truncated };
}

export function compactSoundReference(sound: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    name: stringField(sound, 'name'),
    className: stringField(sound, 'className'),
  };
  const path = stringField(sound, 'path');
  if (path) compact.path = path;
  const assetId = robloxAssetIdFromContentId(
    sound.assetId ?? sound.soundId ?? sound.asset,
  );
  if (assetId !== undefined) compact.assetId = assetId;

  const volume = optionalNumberField(sound, 'volume');
  if (volume !== undefined && volume !== 1) compact.volume = volume;
  const playbackSpeed = optionalNumberField(sound, 'playbackSpeed');
  if (playbackSpeed !== undefined && playbackSpeed !== 1) {
    compact.playbackSpeed = playbackSpeed;
  }
  const timeLength = optionalNumberField(sound, 'timeLength');
  if (timeLength !== undefined && timeLength > 0) compact.duration = timeLength;
  if (sound.looped === true) compact.looped = true;
  if (sound.autoPlay === true) compact.autoPlay = true;
  return compact;
}
