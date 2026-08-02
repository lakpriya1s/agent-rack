import React, { useState, useEffect } from 'react';
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

export interface DashboardSessionListState {
  sessions: AgentSessionInfo[];
  selectedSessionId?: string;
}

export function refreshSessionList(
  state: DashboardSessionListState,
  sessions: AgentSessionInfo[]
): DashboardSessionListState {
  const selectedSessionId = sessions.some(
    (session) => session.sessionId === state.selectedSessionId
  )
    ? state.selectedSessionId
    : sessions[0]?.sessionId;
  return { sessions, selectedSessionId };
}

export function prependLaunchedSession(
  state: DashboardSessionListState,
  session: AgentSessionInfo
): DashboardSessionListState {
  return {
    sessions: [session, ...state.sessions.filter((item) => item.sessionId !== session.sessionId)],
    selectedSessionId: session.sessionId,
  };
}

export function moveSessionSelection(
  state: DashboardSessionListState,
  direction: -1 | 1
): DashboardSessionListState {
  if (state.sessions.length === 0) return { sessions: [], selectedSessionId: undefined };

  const currentIndex = state.sessions.findIndex(
    (session) => session.sessionId === state.selectedSessionId
  );
  const nextIndex =
    currentIndex < 0
      ? 0
      : (currentIndex + direction + state.sessions.length) % state.sessions.length;
  return { ...state, selectedSessionId: state.sessions[nextIndex].sessionId };
}

export const DashboardApp: React.FC<AppProps> = ({ config, configPath, version, remoteClient }) => {
  const { exit } = useApp();
  const [sessionListState, setSessionListState] = useState<DashboardSessionListState>({
    sessions: [],
    selectedSessionId: undefined,
  });
  const { sessions, selectedSessionId } = sessionListState;
  const [events, setEvents] = useState<ParsedAgentEvent[]>([]);
  const [activeTab, setActiveTab] = useState<'sessions' | 'launcher' | 'system' | 'reviews'>('sessions');
  const [statusMessage, setStatusMessage] = useState<string | undefined>(undefined);
  const [showSendInputModal, setShowSendInputModal] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);

  const availableAgents = Object.keys(config.agents);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const list = await remoteClient.listSessions();
        if (!cancelled) {
          setSessionListState((state) => refreshSessionList(state, list));
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
    if (!selectedSessionId) {
      setEvents([]);
      return;
    }

    let cancelled = false;
    let inFlight = false;
    setEvents([]);

    const poll = async () => {
      if (cancelled || inFlight) return;

      inFlight = true;
      try {
        const snapshot = await remoteClient.getSessionLogs(selectedSessionId);
        if (!cancelled) setEvents(snapshot);
      } catch {
        // Connection issues are already surfaced by the session-list poll above.
      } finally {
        inFlight = false;
      }
    };
    poll();
    const interval = setInterval(poll, SESSION_LOGS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [remoteClient, selectedSessionId]);

  const selectedSession =
    sessions.find((session) => session.sessionId === selectedSessionId) ?? sessions[0];
  const selectedIndex = selectedSession
    ? Math.max(
        0,
        sessions.findIndex((session) => session.sessionId === selectedSession.sessionId)
      )
    : 0;

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
      setSessionListState((state) => moveSessionSelection(state, -1));
    } else if (key.downArrow) {
      setSessionListState((state) => moveSessionSelection(state, 1));
    } else if (input === 'c') {
      if (selectedSession && selectedSession.status === 'running') {
        remoteClient
          .cancelSession(selectedSession.sessionId)
          .then(() => setStatusMessage(`Session ${selectedSession.sessionId.slice(0, 8)} cancelled.`))
          .catch((err) =>
            setStatusMessage(`Error cancelling session: ${err instanceof Error ? err.message : String(err)}`)
          );
      } else {
        setStatusMessage('No active running session selected to cancel.');
      }
    } else if (input === 's') {
      if (selectedSession && selectedSession.status === 'running') {
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
      setSessionListState((state) => prependLaunchedSession(state, session));
      setActiveTab('sessions');
      setStatusMessage(`Launched ${agentId} (${kind}) session ${session.sessionId.slice(0, 8)}`);
    } catch (err) {
      setStatusMessage(`Failed to launch agent: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSendInput = async (message: string) => {
    if (selectedSession) {
      try {
        await remoteClient.sendInput(selectedSession.sessionId, message);
        setStatusMessage(
          `Sent input to ${selectedSession.agentId} (${selectedSession.sessionId.slice(0, 8)})`
        );
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
      ) : showSendInputModal && selectedSession ? (
        <SendInputModal
          sessionId={selectedSession.sessionId}
          agentName={selectedSession.agentName}
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
