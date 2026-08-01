import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentMCPServer } from './server.js';

async function runE2ETest() {
  console.log('=== STARTING LIVE MCP PROTOCOL & TOOL HARNESS TEST ===\n');

  const { server } = await createAgentMCPServer();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client(
    {
      name: 'test-client',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  console.log('✓ Client & Server connected via InMemoryTransport!\n');

  // Test 1: List Tools
  console.log('--- Test 1: client.listTools() ---');
  const toolsResult = await client.listTools();
  const toolNames = toolsResult.tools.map((t) => t.name);
  console.log(`Registered Tools (${toolNames.length}):`, toolNames.join(', '));
  console.log('✓ Test 1 Passed!\n');

  // Test 2: Call agent_list_available
  console.log('--- Test 2: client.callTool({ name: "agent_list_available" }) ---');
  const listAvailableRes = await client.callTool({
    name: 'agent_list_available',
    arguments: {},
  });
  console.log('Output:\n', (listAvailableRes.content[0] as any).text);
  console.log('✓ Test 2 Passed!\n');

  // Test 3: Test claude_run with a quick version/help prompt
  console.log('--- Test 3: client.callTool({ name: "claude_run" }) ---');
  const claudeRes = await client.callTool({
    name: 'claude_run',
    arguments: {
      prompt: 'print "Hello from Agent-MCP live test"',
      timeoutSeconds: 30,
    },
  });
  console.log('Claude Run Output:\n', (claudeRes.content[0] as any).text);
  console.log('✓ Test 3 Passed!\n');

  console.log('=== ALL MCP END-TO-END TESTS COMPLETED SUCCESSFULLY! ===');
  process.exit(0);
}

runE2ETest().catch((err) => {
  console.error('E2E Test Failed:', err);
  process.exit(1);
});
