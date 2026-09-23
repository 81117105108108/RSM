#!/usr/bin/env node
// search_objects treats queries as literal text (not Lua patterns), scopes to
// an optional root, and stops at limit with truncated=true.

import {
  McpClient,
  runTest,
  assert,
  selectEditInstance,
  waitForEditPeer,
} from './lib/mcp-client.mjs';

const FOLDER = '__RSMCP_SearchObjects';

await runTest('search_objects literal matching, root, and limit', async ({ track }) => {
  const client = track(new McpClient('search-objects'));
  await client.start();
  await client.initialize();
  await waitForEditPeer(client);

  const edit = selectEditInstance(await client.callTool('get_connected_instances', {}));
  const instance_id = edit?.id ?? edit?.instanceId;
  assert(typeof instance_id === 'string' && instance_id.length > 0, 'edit instance is connected');

  const setup = await client.callTool('execute_luau', {
    target: 'edit',
    instance_id,
    code: `local f = Instance.new("Folder")
f.Name = "${FOLDER}"
for _, name in { "a.b(1)", "a.b(2)", "axb(" } do
  local p = Instance.new("Folder")
  p.Name = name
  p.Parent = f
end
f.Parent = workspace`,
  });
  assert(setup.success === true, `created search fixture${setup.error ? ` (${setup.error})` : ''}`);

  try {
    const root = `game.Workspace.${FOLDER}`;
    const all = await client.callTool('search_objects', { query: 'a.b(', root, instance_id });
    assert(all.count === 2 && all.truncated === false, `"a.b(" matches only literal names (got ${JSON.stringify(all)})`);

    const limited = await client.callTool('search_objects', { query: 'a.b(', root, limit: 1, instance_id });
    assert(limited.count === 1 && limited.truncated === true, `limit=1 truncates (got ${JSON.stringify(limited)})`);

    const missing = await client.callToolError('search_objects', { query: 'x', root: `${root}.Nope`, instance_id });
    assert(typeof missing.error === 'string', 'missing root reports an error');
  } finally {
    await client.callTool('execute_luau', {
      target: 'edit',
      instance_id,
      code: `local f = workspace:FindFirstChild("${FOLDER}") if f then f:Destroy() end`,
    });
  }
});
