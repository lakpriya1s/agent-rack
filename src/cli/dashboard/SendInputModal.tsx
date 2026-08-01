import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface SendInputModalProps {
  sessionId: string;
  agentName: string;
  onSend: (message: string) => void;
  onCancel: () => void;
}

export const SendInputModal: React.FC<SendInputModalProps> = ({
  sessionId,
  agentName,
  onSend,
  onCancel,
}) => {
  const [message, setMessage] = useState('');

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      if (message.trim()) {
        onSend(message);
      }
    } else if (key.backspace || key.delete) {
      setMessage((prev) => prev.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta) {
      setMessage((prev) => prev + input);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" padding={1} marginY={1}>
      <Text bold color="yellow">
        💬 SEND INPUT TO RUNNING SESSION ({agentName} - {sessionId.slice(0, 8)})
      </Text>
      <Text color="gray" dimColor>Type input for interactive PTY/stdin and press Enter. Esc to cancel.</Text>

      <Box marginTop={1} borderStyle="single" borderColor="yellow" paddingX={1}>
        <Text color="white">
          {message}
          <Text color="yellow">❚</Text>
        </Text>
      </Box>

      <Box marginTop={1} justifyContent="flex-end">
        <Text color="cyan">[Enter] Send Message | [Esc] Cancel</Text>
      </Box>
    </Box>
  );
};
