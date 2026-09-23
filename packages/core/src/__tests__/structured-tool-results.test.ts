import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeService } from '../bridge-service.js';
import { normalizeToolResult } from '../mcp-runtime.js';
import { RobloxStudioTools, toStructuredResult } from '../tools/index.js';

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value);
  return buffer;
}

function rbxString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([uint32(bytes.length), bytes]);
}

function chunk(type: string, content = Buffer.alloc(0)): Buffer {
  return Buffer.concat([
    Buffer.from(type, 'latin1'),
    uint32(0),
    uint32(content.length),
    Buffer.alloc(4),
    content,
  ]);
}

function propChunk(classId: number, name: string, values: string[]): Buffer {
  return chunk(
    'PROP',
    Buffer.concat([uint32(classId), rbxString(name), Buffer.from([0x01]), ...values.map(rbxString)]),
  );
}

function buildSkillsFixture(): Buffer {
  const base = ['---', 'name: docs-search', 'description: Find Roblox docs.', '---', '# Base'].join('\n');
  const names = ['SKILL'];
  const values = [base];
  const inst = Buffer.concat([
    uint32(7),
    rbxString('StringValue'),
    Buffer.from([0]),
    uint32(names.length),
    Buffer.alloc(names.length * 4),
  ]);
  const header = Buffer.concat([
    Buffer.from('<roblox!\x89\xff\r\n\x1a\n', 'latin1'),
    Buffer.alloc(2),
    int32(1),
    int32(names.length),
    Buffer.alloc(8),
  ]);
  return Buffer.concat([header, chunk('INST', inst), propChunk(7, 'Name', names), propChunk(7, 'Value', values), chunk('END\0')]);
}

describe('structured tool results', () => {
  test('helper keeps legacy text byte-identical and exposes structuredContent', () => {
    const body = { success: true, value: 42 };
    const result = toStructuredResult(body);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(body);
    expect(result.structuredContent).toEqual(body);
  });

  test('helper output normalizes identically for modern and legacy eras', () => {
    const raw = toStructuredResult({ success: true, value: 42 });
    const modern = normalizeToolResult(raw, 'modern');
    const legacy = normalizeToolResult(raw, 'legacy');
    expect(modern.structuredContent).toEqual({ success: true, value: 42 });
    expect(legacy.structuredContent).toEqual({ success: true, value: 42 });
    expect(JSON.parse(String((legacy.content[0] as { text: string }).text))).toEqual({
      success: true,
      value: 42,
    });
  });

  test('get_connected_instances returns structured content', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const result = await tools.getConnectedInstances();
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text).toHaveProperty('instances');
    expect(text).toHaveProperty('multiplayerGroups');
    expect((result as { structuredContent?: unknown }).structuredContent).toEqual(text);
  });

  test('get_request_status for unknown ids returns structured content', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const result = await tools.getRequestStatus('missing-id');
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text.requestId).toBe('missing-id');
    expect(text.state).toBe('unknown');
    expect((result as { structuredContent?: unknown }).structuredContent).toEqual(text);
    const normalized = normalizeToolResult(result, 'modern');
    expect(normalized.structuredContent).toMatchObject({ requestId: 'missing-id' });
  });

  test('get_roblox_skills list returns structured content', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-results-test-'));
    const bundlePath = path.join(directory, 'Assistant.rbxm');
    fs.writeFileSync(bundlePath, buildSkillsFixture());
    const previousOverride = process.env.ROBLOX_STUDIO_ASSISTANT_BUNDLE;
    process.env.ROBLOX_STUDIO_ASSISTANT_BUNDLE = bundlePath;
    try {
      const tools = new RobloxStudioTools(new BridgeService());
      const result = await tools.getRobloxSkills('list');
      const text = JSON.parse((result.content[0] as { text: string }).text);
      expect(text.action).toBe('list');
      expect((result as { structuredContent?: unknown }).structuredContent).toEqual(text);
    } finally {
      if (previousOverride === undefined) delete process.env.ROBLOX_STUDIO_ASSISTANT_BUNDLE;
      else process.env.ROBLOX_STUDIO_ASSISTANT_BUNDLE = previousOverride;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
