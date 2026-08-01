import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { AgentMCPConfig } from '../../config/schema.js';
import { AgentSessionInfo } from '../../engine/session.js';
import { ParsedAgentEvent } from '../../adapters/base.js';
import { DashboardRemoteClient } from './remoteClient.js';
import { Header } from './Header.js';
import { Footer } from './Footer.js';
import { SessionsView } from './SessionsView.js';
import { SystemView } from './SystemView.js';
import { ReviewView } from './ReviewView.js';
import { LauncherModal } from './LauncherModal.js';
import { SendInputModal } from './SendInputModal.js';

interface AppProps {
  config: AgentMCPConfig;
  configPath?: string;
  version?: string;
  remoteClient: DashboardRemoteClient;
}

const SESSION_LIST_POLL_MS = 1500;
const SESSION_LOGS_POLL_MS = 750;

export const DashboardApp: React.FC<AppProps> = ({ config, configPath, version, remoteClient }) => {
  const { exit } = useApp();
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const [events, setEvents] = useState<ParsedAgentEvent[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<'sessions' | 'launcher' | 'system' | 'reviews'>('sessions');
  const [statusMessage, setStatusMessage] = useState<string | undefined>(undefined);
  const [showSendInputModal, setShowSendInputModal] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const eventsOffsetRef = useRef(0);
  const selectedSessionIdRef = useRef<string | undefined>(undefined);
  const logsPollInFlightRef = useRef(false);

  const availableAgents = Object.keys(config.agents);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const list = await remoteClient.listSessions();
        if (!cancelled) {
          setSessions(list);
          setSelectedIndex((prev) => Math.min(prev, Math.max(0, list.length - 1)));
          setConnectionLost(false);
        }
      } catch {
        if (!cancelled) setConnectionLost(true);
      }
    };
    poll();
    const interval = setInterval(poll, SESSION_LIST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [remoteClient]);

  useEffect(() => {
    const selected = sessions[selectedIndex];
    if (!selected) {
      setEvents([]);
      return;
    }
    if (selectedSessionIdRef.current !== selected.sessionId) {
      selectedSessionIdRef.current = selected.sessionId;
      eventsOffsetRef.current = 0;
      setEvents([]);
    }

    let cancelled = false;
    const poll = async () => {
      if (logsPollInFlightRef.current) return;

      logsPollInFlightRef.current = true;
      try {
        const newEvents = await remoteClient.getSessionLogs(selected.sessionId, eventsOffsetRef.current);
        if (!cancelled && newEvents.length > 0) {
          eventsOffsetRef.current += newEvents.length;
          setEvents((prev) => [...prev, ...newEvents]);
        }
      } catch {
        // Connection issues are already surfaced by the session-list poll above.
      } finally {
        logsPollInFlightRef.current = false;
      }
    };
    poll();
    const interval = setInterval(poll, SESSION_LOGS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [remoteClient, sessions, selectedIndex]);

  const activeSessionsCount = sessions.filter((s) => s.status === 'running').length;

  useInput((input, key) => {
    if (activeTab === 'launcher' || showSendInputModal) {
      return;
    }

    if (input === 'q') {
      exit();
      return;
    }

    if (input === '1') {
      setActiveTab('sessions');
    } else if (input === '2' || input === 'l') {
      setActiveTab('launcher');
    } else if (input === '3') {
      setActiveTab('system');
    } else if (input === '4') {
      setActiveTab('reviews');
    } else if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : Math.max(0, sessions.length - 1)));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => (prev < sessions.length - 1 ? prev + 1 : 0));
    } else if (input === 'c') {
      const selected = sessions[selectedIndex];
      if (selected && selected.status === 'running') {
        remoteClient
          .cancelSession(selected.sessionId)
          .then(() => setStatusMessage(`Session ${selected.sessionId.slice(0, 8)} cancelled.`))
          .catch((err) =>
            setStatusMessage(`Error cancelling session: ${err instanceof Error ? err.message : String(err)}`)
          );
      } else {
        setStatusMessage('No active running session selected to cancel.');
      }
    } else if (input === 's') {
      const selected = sessions[selectedIndex];
      if (selected && selected.status === 'running') {
        setShowSendInputModal(true);
      } else {
        setStatusMessage('Select a running session to send input.');
      }
    }
  });

  const handleLaunch = async (
    agentId: string,
    prompt: string,
    workspace: string,
    kind: 'task' | 'review',
    model?: string
  ) => {
    try {
      const session = await remoteClient.createSession(agentId, prompt, workspace, kind, model);
      setSessions((prev) => [session, ...prev]);
      setSelectedIndex(0);
      setActiveTab('sessions');
      setStatusMessage(`Launched ${agentId} (${kind}) session ${session.sessionId.slice(0, 8)}`);
    } catch (err) {
      setStatusMessage(`Failed to launch agent: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSendInput = async (message: string) => {
    const selected = sessions[selectedIndex];
    if (selected) {
      try {
        await remoteClient.sendInput(selected.sessionId, message);
        setStatusMessage(`Sent input to ${selected.agentId} (${selected.sessionId.slice(0, 8)})`);
      } catch (err) {
        setStatusMessage(`Error sending input: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setShowSendInputModal(false);
  };

  return (
    <Box flexDirection="column" padding={1} width="100%">
      <Header
        configPath={configPath}
        activeSessions={activeSessionsCount}
        maxSessions={config.security.maxConcurrentSessions}
        activeTab={activeTab}
        sanitizedEnv={config.security.sanitizeEnv !== false}
        version={version}
      />

      {connectionLost && (
        <Box marginBottom={1} borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red" bold>
            ⚠ Connection to agent-rack server lost — retrying…
          </Text>
        </Box>
      )}

      {activeTab === 'launcher' ? (
        <LauncherModal
          availableAgents={availableAgents}
          workspaces={config.allowedWorkspaces}
          onLaunch={handleLaunch}
          onCancel={() => setActiveTab('sessions')}
        />
      ) : showSendInputModal && sessions[selectedIndex] ? (
        <SendInputModal
          sessionId={sessions[selectedIndex].sessionId}
          agentName={sessions[selectedIndex].agentName}
          onSend={handleSendInput}
          onCancel={() => setShowSendInputModal(false)}
        />
      ) : activeTab === 'sessions' ? (
        <SessionsView sessions={sessions} selectedIndex={selectedIndex} events={events} />
      ) : activeTab === 'system' ? (
        <SystemView config={config} configPath={configPath} />
      ) : (
        <ReviewView sessions={sessions} />
      )}

      <Footer statusMessage={statusMessage} />
    </Box>
  );
};
