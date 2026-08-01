import React from 'react';
import { Box, Text } from 'ink';

interface FooterProps {
  statusMessage?: string;
}

export const Footer: React.FC<FooterProps> = ({ statusMessage }) => {
  return (
    <Box flexDirection="column" marginTop={1}>
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
