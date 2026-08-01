import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { AgentMCPConfig } from '../../config/schema.js';
import { listAgentAvailability, AgentAvailability } from '../../engine/availability.js';

interface SystemViewProps {
  config: AgentMCPConfig;
  configPath?: string;
}

export const SystemView: React.FC<SystemViewProps> = ({ config, configPath }) => {
  const [availability, setAvailability] = useState<AgentAvailability[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    listAgentAvailability(config).then((results) => {
      if (isMounted) {
        setAvailability(results);
        setLoading(false);
      }
    });
    return () => {
      isMounted = false;
    };
  }, [config]);

  return (
    <Box flexDirection="column" gap={1} flexGrow={1}>
      {/* Agent Fleet Table */}
      <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan" underline>
          🤖 Configured Agent Fleet
        </Text>
        {loading ? (
          <Text color="gray">Probing CLI agent binaries on PATH...</Text>
        ) : (
          availability.map((ag) => (
            <Box key={ag.agentId} justifyContent="space-between">
              <Box gap={1}>
                <Box width={12}>
                  <Text bold color="white">
                    {ag.agentId}
                  </Text>
                </Box>
                <Box width={14}>
                  <Text color="yellow">
                    cmd: {ag.command}
                  </Text>
                </Box>
                <Box width={20}>
                  <Text color="magenta">
                    [{ag.transport}]
                  </Text>
                </Box>
              </Box>
              <Text bold color={ag.status === 'available' ? 'green' : 'red'}>
                {ag.status === 'available' ? '✓ AVAILABLE' : '✖ NOT INSTALLED'}
              </Text>
            </Box>
          ))
        )}
      </Box>

      {/* Security & Workspaces */}
      <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
        <Text bold color="yellow" underline>
          🛡️ Security & Sandbox Boundaries
        </Text>
        <Text>
          Max Concurrent Sessions: <Text bold color="cyan">{config.security.maxConcurrentSessions}</Text>
        </Text>
        <Text>
          Default Timeout: <Text bold color="cyan">{config.security.defaultTimeoutSeconds}s</Text>
        </Text>
        <Text>
          Environment Sanitization: <Text bold color={config.security.sanitizeEnv ? 'green' : 'red'}>{config.security.sanitizeEnv ? 'Enabled (Stripping tokens/secrets)' : 'Disabled'}</Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text bold color="white">Allowed Workspaces ({config.allowedWorkspaces.length}):</Text>
          {config.allowedWorkspaces.map((ws, i) => (
            <Text key={i} color="gray">
              • {ws}
            </Text>
          ))}
        </Box>
      </Box>

      {/* Config File Details */}
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
        <Text bold color="white" underline>
          📁 Active Config Reference
        </Text>
        <Text color="gray">Config File: {configPath || 'Loaded from default fallback'}</Text>
        <Text color="gray">Transport Mode: {config.transport}</Text>
      </Box>
    </Box>
  );
};
