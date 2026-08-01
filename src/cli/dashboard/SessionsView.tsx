import React from 'react';
import { Box, Text } from 'ink';
import { AgentSession } from '../../engine/session.js';
import { ParsedAgentEvent } from '../../adapters/base.js';

interface SessionsViewProps {
  sessions: AgentSession[];
  selectedIndex: number;
}

function getStatusBadge(status: string) {
  switch (status) {
    case 'running':
      return <Text color="green">● RUNNING</Text>;
    case 'completed':
      return <Text color="blue">✓ DONE</Text>;
    case 'failed':
      return <Text color="red">✖ FAILED</Text>;
    case 'cancelled':
      return <Text color="yellow">⊘ CANCELLED</Text>;
    case 'idle':
      return <Text color="gray">○ IDLE</Text>;
    default:
      return <Text color="gray">{status}</Text>;
  }
}

export const SessionsView: React.FC<SessionsViewProps> = ({ sessions, selectedIndex }) => {
  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="single" borderColor="gray" padding={2} alignItems="center" justifyContent="center">
        <Text bold color="yellow">No active or past sessions.</Text>
        <Text color="gray">Press <Text bold color="cyan">[l]</Text> or switch to <Text bold color="cyan">[2] Launch Agent</Text> tab to run a new agent session.</Text>
      </Box>
    );
  }

  const selectedSession = sessions[selectedIndex] || sessions[0];
  const info = selectedSession.getInfo();
  const events: ParsedAgentEvent[] = selectedSession.controller.getBuffer().getAll();
  const recentEvents = events.slice(-12);

  return (
    <Box flexDirection="row" gap={1} flexGrow={1}>
      {/* Left List Pane */}
      <Box flexDirection="column" width="35%" borderStyle="single" borderColor="blue" paddingX={1}>
        <Text bold color="cyan" underline>
          Sessions ({sessions.length})
        </Text>
        {sessions.map((s, idx) => {
          const isSelected = idx === selectedIndex;
          const sInfo = s.getInfo();
          return (
            <Box key={s.id} flexDirection="column" marginY={0}>
              <Text bold color={isSelected ? 'inverse' : undefined}>
                {isSelected ? '► ' : '  '}
                {sInfo.agentId} <Text color="gray">({sInfo.sessionId.slice(0, 8)})</Text>
              </Text>
              <Box paddingLeft={2} justifyContent="space-between">
                {getStatusBadge(sInfo.status)}
                <Text color="gray" dimColor>
                  {sInfo.eventCount} ev
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Right Details & Live Log Stream Pane */}
      <Box flexDirection="column" width="65%" borderStyle="single" borderColor="cyan" paddingX={1} gap={1}>
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold color="green">
            Session Details: <Text color="white">{info.sessionId}</Text>
          </Text>
          <Text>
            Agent: <Text bold color="yellow">{info.agentName}</Text> ({info.agentId}) | Kind: <Text color="magenta">{selectedSession.kind}</Text>
          </Text>
          <Text color="gray">Workspace: {info.workspace}</Text>
          <Text color="gray">Created: {new Date(info.createdAt).toLocaleTimeString()}</Text>
          {info.summary && (
            <Box marginTop={1} flexDirection="column">
              <Text bold color="white">Summary:</Text>
              <Text color="gray" wrap="truncate-end">
                {info.summary.slice(0, 150)}{info.summary.length > 150 ? '...' : ''}
              </Text>
            </Box>
          )}
        </Box>

        {/* Event Logs Stream */}
        <Box flexDirection="column" flexGrow={1}>
          <Text bold color="magenta" underline>
            Live Event Stream ({events.length} events)
          </Text>
          {recentEvents.length === 0 ? (
            <Text color="gray" dimColor>Waiting for agent events...</Text>
          ) : (
            recentEvents.map((ev, i) => {
              const time = new Date(ev.timestamp).toLocaleTimeString();
              let content = ev.content;
              let badge = <Text color="gray">[TEXT]</Text>;
              if (ev.type === 'tool_call') {
                badge = <Text color="cyan">[TOOL] {ev.toolName || ''}</Text>;
                content = typeof ev.input === 'object' ? JSON.stringify(ev.input) : String(ev.input || ev.content);
              } else if (ev.type === 'thought') {
                badge = <Text color="magenta">[THOUGHT]</Text>;
              } else if (ev.type === 'error') {
                badge = <Text color="red">[ERROR]</Text>;
              } else if (ev.type === 'status') {
                badge = <Text color="yellow">[STATUS]</Text>;
              }

              return (
                <Text key={i} wrap="truncate-end">
                  <Text color="gray">[{time}]</Text> {badge} {content.replace(/\n/g, ' ')}
                </Text>
              );
            })
          )}
        </Box>
      </Box>
    </Box>
  );
};
