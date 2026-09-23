import {
  DEFAULT_TOOL_PROFILE,
  MINIMAL_TOOL_NAMES,
  TOOL_DEFINITIONS,
  TOOL_PROFILE_NAMES,
  getAllTools,
  getMinimalTools,
  getReadOnlyTools,
  getToolsForProfile,
  isToolProfile,
  resolveAllowedToolNamesForProfile,
  resolveToolProfile,
} from '../tools/definitions.js';
import { RobloxStudioMCPServer } from '../server.js';

describe('tool profiles', () => {
  test('exports the backward-compatible profile union with full default', () => {
    expect(TOOL_PROFILE_NAMES).toEqual(['full', 'inspector', 'minimal']);
    expect(DEFAULT_TOOL_PROFILE).toBe('full');
    expect(resolveToolProfile(undefined)).toBe('full');
    expect(isToolProfile('full')).toBe(true);
    expect(isToolProfile('inspector')).toBe(true);
    expect(isToolProfile('minimal')).toBe(true);
    expect(isToolProfile('unknown')).toBe(false);
  });

  test('full profile keeps the default surface unchanged', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(42);
    expect(getAllTools()).toHaveLength(42);
    expect(getToolsForProfile('full')).toHaveLength(42);
    expect(getToolsForProfile(undefined)).toHaveLength(42);
    expect(new Set(getToolsForProfile('full').map((tool) => tool.name))).toEqual(
      new Set(getAllTools().map((tool) => tool.name)),
    );
    expect(new Set(getAllTools().map((tool) => tool.name)).size).toBe(42);
  });

  test('inspector profile is read-only', () => {
    const inspector = getToolsForProfile('inspector');
    const readOnly = getReadOnlyTools();
    expect(inspector).toHaveLength(24);
    expect(readOnly).toHaveLength(24);
    expect(inspector.map((tool) => tool.name)).toEqual(readOnly.map((tool) => tool.name));
    for (const tool of inspector) {
      expect(tool.category).toBe('read');
    }
  });

  test('minimal profile is a common-tools subset', () => {
    const minimal = getMinimalTools();
    expect(minimal.map((tool) => tool.name).sort()).toEqual([...MINIMAL_TOOL_NAMES].sort());
    expect(minimal).toHaveLength(12);
    const fullNames = new Set(getAllTools().map((tool) => tool.name));
    const inspectorNames = new Set(getReadOnlyTools().map((tool) => tool.name));
    for (const tool of minimal) {
      expect(fullNames.has(tool.name)).toBe(true);
      expect(inspectorNames.has(tool.name)).toBe(true);
      expect(tool.category).toBe('read');
    }
    expect(minimal.length).toBeLessThan(getReadOnlyTools().length);
  });

  test('resolver rejects unknown profiles and resolves allowed names', () => {
    expect(() => resolveToolProfile('unknown')).toThrow(/Unknown tool profile/);
    expect(() => getToolsForProfile('unknown')).toThrow(/Unknown tool profile/);
    expect(resolveAllowedToolNamesForProfile('full').size).toBe(42);
    expect(resolveAllowedToolNamesForProfile('inspector').size).toBe(24);
    expect(resolveAllowedToolNamesForProfile('minimal').size).toBe(12);
    expect(resolveAllowedToolNamesForProfile(undefined).size).toBe(42);
  });

  test('server intersects the profile with configured tools via allowedTools', () => {
    const full = new RobloxStudioMCPServer({
      name: 'profile-test',
      version: '0.0.0',
      tools: getAllTools(),
    });
    expect(full.getToolProfile()).toBe('full');
    expect(((full as unknown) as { allowedToolNames: Set<string> }).allowedToolNames.size).toBe(42);

    const inspector = new RobloxStudioMCPServer({
      name: 'profile-test',
      version: '0.0.0',
      tools: getAllTools(),
      toolProfile: 'inspector',
    });
    expect(inspector.getToolProfile()).toBe('inspector');
    const inspectorAllowed = ((inspector as unknown) as { allowedToolNames: Set<string> }).allowedToolNames;
    expect(inspectorAllowed.size).toBe(24);
    expect(inspectorAllowed.has('execute_luau')).toBe(false);
    expect(inspectorAllowed.has('get_script_source')).toBe(true);

    const minimal = new RobloxStudioMCPServer({
      name: 'profile-test',
      version: '0.0.0',
      tools: getAllTools(),
      toolProfile: 'minimal',
    });
    expect(minimal.getToolProfile()).toBe('minimal');
    const minimalAllowed = ((minimal as unknown) as { allowedToolNames: Set<string> }).allowedToolNames;
    expect(minimalAllowed.size).toBe(12);
    expect([...minimalAllowed].sort()).toEqual([...MINIMAL_TOOL_NAMES].sort());
  });
});
