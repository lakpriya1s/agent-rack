import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentMCPServer } from './server.js';
import path from 'path';
import fs from 'fs';

async function runHandoverDemo() {
  console.log('🚀 === STARTING SUB-AGENT HANDOVER DEMO: CLAUDE CODE CLI ===\n');

  const workspacePath = path.resolve('/Volumes/External/agent-mcp');
  const { server } = await createAgentMCPServer();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'master-agent', version: '1.0.0' },
    { capabilities: {} }
  );

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  console.log('✓ Connected to Agent-MCP Server over MCP Protocol transport.\n');
  console.log('📥 Handing over task to sub-agent "claude"...');
  console.log('Task Prompt: "Create src/utils/math.ts with basic arithmetic operations (add, subtract, multiply, divide) and a unit test file src/utils/math.test.ts"\n');

  const startTime = Date.now();

  const result = await client.callTool({
    name: 'claude_run',
    arguments: {
      prompt: 'Create a TypeScript file src/utils/math.ts that exports add, subtract, multiply, and divide functions with full type annotations. Then create src/utils/math.test.ts with unit tests for each function.',
      workspace: workspacePath,
      timeoutSeconds: 120,
    },
  });

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`⏱️ Sub-agent task completed in ${durationSec} seconds!\n`);

  console.log('=== SUB-AGENT TOOL OUTPUT ===\n');
  const outputText = (result.content[0] as any).text;
  console.log(outputText);
  console.log('\n===============================\n');

  // Verify created files
  const mathFile = path.join(workspacePath, 'src/utils/math.ts');
  const testFile = path.join(workspacePath, 'src/utils/math.test.ts');

  console.log('🔎 Verifying file generation on disk:');
  console.log(`- src/utils/math.ts exists: ${fs.existsSync(mathFile) ? 'YES ✓' : 'NO ✗'}`);
  console.log(`- src/utils/math.test.ts exists: ${fs.existsSync(testFile) ? 'YES ✓' : 'NO ✗'}\n`);

  if (fs.existsSync(mathFile)) {
    console.log('📄 Generated src/utils/math.ts Content:\n');
    console.log(fs.readFileSync(mathFile, 'utf-8'));
  }

  process.exit(0);
}

runHandoverDemo().catch((err) => {
  console.error('Handover Demo Failed:', err);
  process.exit(1);
});
