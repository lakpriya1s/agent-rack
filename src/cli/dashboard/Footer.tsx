import React from 'react';
import { Box, Text } from 'ink';
import type { DashboardServerMode } from './serverCoordinator.js';

interface FooterProps {
  statusMessage?: string;
  serverMode: DashboardServerMode;
}

export const Footer: React.FC<FooterProps> = ({ statusMessage, serverMode }) => {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingX={1}>
        <Text bold color={serverMode === 'auto-started' ? 'green' : 'cyan'}>
          {serverMode === 'auto-started'
            ? 'AUTO-STARTED — this shared server stops when the dashboard closes.'
            : 'EXISTING — connected without owning the shared server.'}
        </Text>
      </Box>
      {statusMessage && (
        <Box paddingX={1}>
          <Text bold color="yellow">
            ℹ️ {statusMessage}
          </Text>
        </Box>
      )}
      <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
        <Text dimColor>
          <Text bold color="cyan">[1-4]</Text> Switch Tab | <Text bold color="cyan">[↑/↓]</Text> Select Session | <Text bold color="cyan">[c]</Text> Cancel | <Text bold color="cyan">[s]</Text> Send Input
        </Text>
        <Text dimColor>
          <Text bold color="cyan">[l]</Text> New Agent | <Text bold color="cyan">[q/Ctrl+C]</Text> Quit
        </Text>
      </Box>
    </Box>
  );
};
