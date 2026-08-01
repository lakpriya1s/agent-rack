import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface LauncherModalProps {
  availableAgents: string[];
  workspaces: string[];
  onLaunch: (agentId: string, prompt: string, workspace: string, kind: 'task' | 'review', model?: string) => void;
  onCancel: () => void;
}

export const LauncherModal: React.FC<LauncherModalProps> = ({
  availableAgents,
  workspaces,
  onLaunch,
  onCancel,
}) => {
  const [selectedAgentIdx, setSelectedAgentIdx] = useState(0);
  const [kind, setKind] = useState<'task' | 'review'>('task');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [activeField, setActiveField] = useState<'agent' | 'kind' | 'model' | 'prompt' | 'submit'>('agent');
  const [error, setError] = useState<string | null>(null);

  const currentAgent = availableAgents[selectedAgentIdx] || 'claude';
  const defaultWorkspace = workspaces[0] || process.cwd();

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (activeField === 'agent') {
      if (key.leftArrow || key.upArrow) {
        setSelectedAgentIdx((prev) => (prev > 0 ? prev - 1 : availableAgents.length - 1));
      } else if (key.rightArrow || key.downArrow) {
        setSelectedAgentIdx((prev) => (prev < availableAgents.length - 1 ? prev + 1 : 0));
      } else if (key.return || key.tab) {
        setActiveField('kind');
      }
    } else if (activeField === 'kind') {
      if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
        setKind((prev) => (prev === 'task' ? 'review' : 'task'));
      } else if (key.return || key.tab) {
        setActiveField('model');
      }
    } else if (activeField === 'model') {
      if (key.return || key.tab) {
        setActiveField('prompt');
      } else if (key.backspace || key.delete) {
        setModel((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setModel((prev) => prev + input);
      }
    } else if (activeField === 'prompt') {
      if (key.return) {
        if (!prompt.trim() && kind === 'task') {
          setError('Prompt cannot be empty for task session.');
          return;
        }
        setActiveField('submit');
      } else if (key.backspace || key.delete) {
        setPrompt((prev) => prev.slice(0, -1));
        setError(null);
      } else if (input && !key.ctrl && !key.meta) {
        setPrompt((prev) => prev + input);
        setError(null);
      }
    } else if (activeField === 'submit') {
      if (key.return) {
        onLaunch(currentAgent, prompt, defaultWorkspace, kind, model.trim() || undefined);
      } else if (key.upArrow || key.tab) {
        setActiveField('prompt');
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="green" padding={1} marginY={1}>
      <Text bold color="green">
        🚀 LAUNCH NEW AGENT SESSION
      </Text>
      <Text color="gray" dimColor>Use Arrow keys / Tab to navigate, Enter to select/submit, Esc to cancel</Text>

      {/* Select Agent */}
      <Box marginTop={1} gap={2}>
        <Text bold color={activeField === 'agent' ? 'yellow' : 'white'}>
          Select Agent:
        </Text>
        {availableAgents.map((ag, idx) => (
          <Text
            key={ag}
            bold={idx === selectedAgentIdx}
            color={idx === selectedAgentIdx ? 'inverse' : 'cyan'}
          >
            [{ag}]
          </Text>
        ))}
      </Box>

      {/* Select Kind */}
      <Box marginTop={1} gap={2}>
        <Text bold color={activeField === 'kind' ? 'yellow' : 'white'}>
          Session Kind:
        </Text>
        <Text bold color={kind === 'task' ? 'inverse' : 'magenta'}>
          [Task Run]
        </Text>
        <Text bold color={kind === 'review' ? 'inverse' : 'magenta'}>
          [Code Review]
        </Text>
      </Box>

      {/* Model Override */}
      <Box marginTop={1} flexDirection="column">
        <Text bold color={activeField === 'model' ? 'yellow' : 'white'}>
          Model (optional):
        </Text>
        <Box borderStyle="single" borderColor={activeField === 'model' ? 'yellow' : 'gray'} paddingX={1}>
          <Text color="white">
            {model || <Text color="gray" dimColor>Leave empty to use the agent's default</Text>}
            {activeField === 'model' && <Text color="yellow">❚</Text>}
          </Text>
        </Box>
      </Box>

      {/* Prompt Input */}
      <Box marginTop={1} flexDirection="column">
        <Text bold color={activeField === 'prompt' ? 'yellow' : 'white'}>
          Prompt / Instructions:
        </Text>
        <Box borderStyle="single" borderColor={activeField === 'prompt' ? 'yellow' : 'gray'} paddingX={1}>
          <Text color="white">
            {prompt || <Text color="gray" dimColor>Type agent instructions here...</Text>}
            {activeField === 'prompt' && <Text color="yellow">❚</Text>}
          </Text>
        </Box>
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red" bold>
            ⚠️ {error}
          </Text>
        </Box>
      )}

      {/* Submit */}
      <Box marginTop={1} justifyContent="flex-end">
        <Box borderStyle="single" borderColor={activeField === 'submit' ? 'green' : 'gray'} paddingX={2}>
          <Text bold color={activeField === 'submit' ? 'inverse' : 'green'}>
            [ Launch {currentAgent.toUpperCase()} Session ]
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
