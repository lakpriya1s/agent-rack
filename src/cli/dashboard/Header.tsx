import React from 'react';
import { Box, Text } from 'ink';

interface HeaderProps {
  configPath?: string;
  activeSessions: number;
  maxSessions: number;
  activeTab: 'sessions' | 'launcher' | 'system' | 'reviews';
  sanitizedEnv: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  configPath,
  activeSessions,
  maxSessions,
  activeTab,
  sanitizedEnv,
}) => {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={0}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          ⚡ AGENT-RACK DASHBOARD <Text color="gray">v0.2.0</Text>
        </Text>
        <Text>
          Sessions: <Text bold color={activeSessions > 0 ? 'green' : 'yellow'}>{activeSessions}</Text> / {maxSessions}
        </Text>
      </Box>

      <Box justifyContent="space-between" marginTop={0}>
        <Text color="gray" dimColor>
          Config: {configPath || 'built-in default'}
        </Text>
        <Text color="gray" dimColor>
          Env Security: <Text color={sanitizedEnv ? 'green' : 'red'}>{sanitizedEnv ? '🔒 Sanitized' : '⚠️ Direct'}</Text>
        </Text>
      </Box>

      <Box marginTop={1} gap={2}>
        <Text bold color={activeTab === 'sessions' ? 'inverse' : 'blue'}>
          [1] 📋 Sessions ({activeSessions})
        </Text>
        <Text bold color={activeTab === 'launcher' ? 'inverse' : 'blue'}>
          [2] 🚀 Launch Agent
        </Text>
        <Text bold color={activeTab === 'system' ? 'inverse' : 'blue'}>
          [3] ⚙️ System & Fleet
        </Text>
        <Text bold color={activeTab === 'reviews' ? 'inverse' : 'blue'}>
          [4] 🔍 Code Reviews
        </Text>
      </Box>
    </Box>
  );
};
